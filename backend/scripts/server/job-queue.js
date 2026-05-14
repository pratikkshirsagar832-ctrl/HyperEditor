/**
 * Per-session job queue with global concurrency control.
 *
 * Features:
 * - Max 2 simultaneous FFmpeg/Remotion processes across all sessions.
 * - Per-session dedup: rejects 409 if same session & type job is running.
 * - Abort support (kills child processes / cancels renders).
 * - Progress callbacks pushed to per-session SSE subscribers.
 * - Pollable job status: GET /api/v1/session/:id/jobs/:jobId
 * - Cancel:          DELETE /api/v1/session/:id/jobs/:jobId
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

const GLOBAL_CONCURRENCY = 2;
let runningCount = 0;

// ── Job states ───────────────────────────────────────────────────────────
const PENDING   = 'pending';
const RUNNING   = 'running';
const COMPLETED = 'completed';
const FAILED    = 'failed';
const CANCELLED = 'cancelled';

// ── Internal state ───────────────────────────────────────────────────────
const pendingJobs = [];           // Queue of { job, resolve, reject }
const jobsById   = new Map();     // jobId → job details (status, progress, result/error)
const runningBySession = new Map(); // sessionId → Set<type> (for dedup)
const sessionsByJob   = new Map(); // jobId → sessionId (for cleanup)

// SSE subscribers: Map<sessionId, Set<res>>
const sseClients = new Map();

// Events for internal wiring
const bus = new EventEmitter();
bus.setMaxListeners(200);

// ── Job status helpers ───────────────────────────────────────────────────
function setStatus(jobId, status, detail = null) {
  const j = jobsById.get(jobId);
  if (!j) return;
  j.status = status;
  if (detail !== null) {
    if (status === FAILED) j.error = detail;
    else if (status === COMPLETED) j.result = detail;
  }
  // Push to SSE subscribers for the session
  pushSSE(j.sessionId, { jobId, status, percent: j.percent, step: j.step, error: j.error });
}

function setProgress(jobId, percent, step) {
  const j = jobsById.get(jobId);
  if (!j) return;
  j.percent = percent;
  if (step) j.step = step;
  pushSSE(j.sessionId, { jobId, status: j.status, percent: j.percent, step: j.step });
}

// ── SSE helpers ──────────────────────────────────────────────────────────
export function addSSEClient(sessionId, res) {
  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
  sseClients.get(sessionId).add(res);
  // Send initial keepalive
  res.write(`data: {"type":"connected"}\n\n`);
}

export function removeSSEClient(sessionId, res) {
  const set = sseClients.get(sessionId);
  if (set) {
    set.delete(res);
    if (set.size === 0) sseClients.delete(sessionId);
  }
}

/**
 * Push an arbitrary event to all SSE subscribers for a session.
 * Used for upload progress, custom notifications, etc.
 */
export function pushSSEToSession(sessionId, data) {
  pushSSE(sessionId, data);
}

function pushSSE(sessionId, data) {
  const set = sseClients.get(sessionId);
  if (!set || set.size === 0) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(msg); } catch { removeSSEClient(sessionId, res); }
  }
}

// ── Drain the queue (run when a slot opens) ──────────────────────────────
function drain() {
  if (pendingJobs.length === 0 || runningCount >= GLOBAL_CONCURRENCY) return;

  const entry = pendingJobs.shift();
  const { job, resolve, reject } = entry;

  // Check per-session dedup (the check is also done at enqueue time, but
  // a job may have completed since then)
  const sessionTypes = runningBySession.get(job.sessionId);
  if (sessionTypes && sessionTypes.has(job.type)) {
    // Another job of same type is already running for this session — re-queue
    // This shouldn't happen if the frontend respects 409, but handle gracefully.
    pendingJobs.unshift(entry);
    return;
  }

  runningCount++;
  setStatus(job.id, RUNNING);

  if (!runningBySession.has(job.sessionId)) {
    runningBySession.set(job.sessionId, new Set());
  }
  runningBySession.get(job.sessionId).add(job.type);

  // Run the job
  const resultPromise = job.run((percent, step) => {
    setProgress(job.id, percent, step);
  });

  resultPromise.then(
    (result) => {
      setStatus(job.id, COMPLETED, result);
      resolve(result);
    },
    (err) => {
      if (err && err.code === 'CANCELLED') {
        setStatus(job.id, CANCELLED);
        reject(err);
      } else {
        setStatus(job.id, FAILED, err ? err.message : 'Unknown error');
        reject(err);
      }
    }
  ).finally(() => {
    runningCount--;
    // Clear timeout so it doesn't fire after job completes
    if (job.timeoutHandle) {
      clearTimeout(job.timeoutHandle);
      job.timeoutHandle = null;
    }
    // Remove session type tracking
    const st = runningBySession.get(job.sessionId);
    if (st) {
      st.delete(job.type);
      if (st.size === 0) runningBySession.delete(job.sessionId);
    }
    sessionsByJob.delete(job.id);
    // Keep job result in map for polling — it will be cleaned after 5 minutes
    // (or you can let the client poll once, then delete)
    drain();
  });
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Create and enqueue a job.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.type        - e.g. 'generate-animation', 'transcribe', 'remove-dead-air'
 * @param {(onProgress: (pct: number, step?: string) => void) => Promise<any>} opts.run
 * @param {() => void} [opts.abort] - optional; called when job is cancelled
 * @param {number} [opts.timeout]   - optional timeout in ms
 * @returns {{ jobId: string, status: string }}
 */
export function enqueueJob({ sessionId, type, run, abort, timeout }) {
  // Dedup: check if same session + type is already running
  const sessionTypes = runningBySession.get(sessionId);
  if (sessionTypes && sessionTypes.has(type)) {
    // Also check pending queue
    const hasPending = pendingJobs.some(e => e.job.sessionId === sessionId && e.job.type === type);
    if (hasPending || sessionTypes.has(type)) {
      const err = new Error(`A job of type '${type}' is already running for this session`);
      err.statusCode = 409;
      throw err;
    }
  }

  const jobId = randomUUID();
  let aborted = false;
  let timeoutHandle = null;

  const job = {
    id: jobId,
    sessionId,
    type,
    status: PENDING,
    percent: 0,
    step: '',
    timeoutHandle: null, // Will be set below
    run: (onProgress) => {
      if (aborted) return Promise.reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
      // Wrap the user's run function with abort guard
      const wrappedRun = run;
      const promise = wrappedRun(onProgress);
      return promise;
    },
    abort: () => {
      if (aborted) return;
      aborted = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (abort) abort();
      // If still pending, remove from queue
      const idx = pendingJobs.findIndex(e => e.job.id === jobId);
      if (idx !== -1) {
        const [entry] = pendingJobs.splice(idx, 1);
        setStatus(jobId, CANCELLED);
        entry.reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
      }
      // If running, the abort callback will kill the process
    },
  };

  jobsById.set(jobId, {
    id: jobId,
    sessionId,
    type,
    status: PENDING,
    percent: 0,
    step: '',
    createdAt: Date.now(),
    result: null,
    error: null,
  });
  sessionsByJob.set(jobId, sessionId);

  if (timeout) {
    timeoutHandle = setTimeout(() => {
      job.abort();
      const j = jobsById.get(jobId);
      if (j && j.status === RUNNING) {
        setStatus(jobId, FAILED, 'Timed out');
      }
    }, timeout);
    job.timeoutHandle = timeoutHandle;
  }

  const entry = { job, resolve: null, reject: null };
  const promise = new Promise((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
  });

  pendingJobs.push(entry);
  setStatus(jobId, PENDING);
  drain();

  return { jobId, promise };
}

/**
 * Get current job status (for polling).
 */
export function getJobStatus(jobId) {
  const j = jobsById.get(jobId);
  if (!j) return null;
  return {
    jobId: j.id,
    status: j.status,
    percent: j.percent,
    step: j.step,
    result: j.result,
    error: j.error,
    createdAt: j.createdAt,
  };
}

/**
 * Get all jobs for a session.
 */
export function getSessionJobs(sessionId) {
  const results = [];
  for (const j of jobsById.values()) {
    if (j.sessionId === sessionId) results.push(getJobStatus(j.id));
  }
  // Also check pending queue
  for (const e of pendingJobs) {
    if (e.job.sessionId === sessionId) {
      const existing = results.find(r => r.jobId === e.job.id);
      if (!existing) results.push(getJobStatus(e.job.id));
    }
  }
  return results;
}

/**
 * Cancel a job by ID.
 */
export function cancelJob(jobId) {
  const j = jobsById.get(jobId);
  if (!j) return false;
  if (j.status === COMPLETED || j.status === FAILED || j.status === CANCELLED) return false;

  // Find the job entry in queue
  const entry = pendingJobs.find(e => e.job.id === jobId);
  if (entry) {
    entry.job.abort();
    return true;
  }
  return false;
}

/**
 * Cancel all running jobs (for graceful shutdown).
 * Kills all pending and running child processes.
 */
export function cancelAllJobs() {
  let killed = 0;
  for (const [id, j] of jobsById) {
    if (j.status === PENDING || j.status === RUNNING) {
      const entry = pendingJobs.find(e => e.job.id === id);
      if (entry) {
        entry.job.abort();
        killed++;
      }
    }
  }
  console.log(`[JobQueue] Cancelled ${killed} pending/running jobs for shutdown`);
  return killed;
}

/**
 * Clean up stale job status entries older than 5 minutes.
 */
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, j] of jobsById) {
    if (j.status !== PENDING && j.status !== RUNNING && j.createdAt < cutoff) {
      jobsById.delete(id);
    }
  }
}, 60_000);
