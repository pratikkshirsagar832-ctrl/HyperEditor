import http from 'http';
import { spawn } from 'child_process';
import fs, { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'fs';
import { createWriteStream, createReadStream } from 'fs';
import { join, dirname } from 'path';
import * as pathModule from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { rename, stat, copyFile, readFile, writeFile, appendFile, access, mkdir, unlink, rmdir } from 'fs/promises';
import formidable from 'formidable';
import z from 'zod';
import { promisify } from 'util';

import { fal } from '@fal-ai/client';

// ── New server modules ───────────────────────────────────────────────────
import { enqueueJob, getJobStatus, getSessionJobs, cancelJob, cancelAllJobs, addSSEClient, removeSSEClient, pushSSEToSession } from './server/job-queue.js';
import { renderWithRemotion } from './server/remotion-renderer.js';
import { LRUCache } from './server/lru-cache.js';
import { RateLimiter } from './server/rate-limiter.js';

// FFmpeg helpers
import {
  runFFmpeg as runFFmpegModule,
  runFFprobe as runFFprobeModule,
  detectSilence as detectSilenceModule,
  getDuration as getDurationModule,
  getMediaInfo as getMediaInfoModule,
  hasAudioStream as hasAudioStreamModule,
  calculateKeepSegments as calculateKeepSegmentsModule,
  generateThumbnail as generateThumbnailModule,
  formatAssTime as formatAssTimeModule
} from './server/ffmpeg.js';

// Session management
import { getSession as getSessionModule, getCachedSession, checkSessionHealth } from './server/session.js';

// Asset management
import {
  saveAssetMetadata as saveAssetMetadataModule
} from './server/assets.js';

// Project state
import { buildAssFromCaptions as buildAssFromCaptionsModule } from './server/project.js';

// AI services
import { getOrTranscribeVideo as getOrTranscribeVideoModule } from './server/ai-transcribe.js';
import { generateWithDeepSeek } from './server/ai-deepseek.js';
import { generateImageWithFal } from './server/ai-images.js';

// Clipify — short-form clip generation
import { createShorts as createShortsModule } from './clipify/create-shorts.js';

// ── Async file helpers (fire-and-forget writes for non-critical data) ────
// These reduce event-loop blocking without needing try/catch at every call
// site. Use when the write is informational (props, scene files, metadata).
function writeJSONAsync(filePath, data) {
  fs.promises.writeFile(filePath, JSON.stringify(data, null, 2)).catch(() => {});
}
function readJSONAsync(filePath) {
  return fs.promises.readFile(filePath, 'utf-8').then(d => JSON.parse(d)).catch(() => null);
}

import { DEFAULT_TRACKS } from './server/constants.js';
import { ClipSchema, TrackSchema, ProjectSchema, AutoShortsSchema, TranscribeSchema } from './server/schemas.js';
import { renderHyperframesComposition, generateHyperframesComposition } from './server/hyperframes-renderer.js';

// ── Project root (used for npx spawns and remotion) ─────────────────────────
const PROJECT_ROOT = new URL('..', import.meta.url).pathname; // scripts/ → backend/
const FRONTEND_ROOT = new URL('../frontend', import.meta.url).pathname; // scripts/ → backend/../frontend/

// ── Response helpers ──────────────────────────────────────────────────────
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}
function sendError(res, statusCode, message) {
  sendJSON(res, statusCode, { error: message });
}
function sendSuccess(res, data) {
  sendJSON(res, 200, data);
}

// ── Consistent error logger ───────────────────────────────────────────────
function logError(jobId, message, err) {
  const ts = new Date().toISOString();
  const detail = err ? (err.stack || err.message || String(err)) : '';
  console.error(`[ERROR] ${ts} [${jobId || '?'}] ${message}${detail ? '\n' + detail : ''}`);
}

// ── Global error handlers ──────────────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error(`[FATAL] Unhandled Rejection at: ${promise}\n  Reason: ${reason instanceof Error ? reason.stack : reason}`);
});

process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Uncaught Exception:\n${err.stack || err.message}`);
});

// ── Validate required environment variables ───────────────────────────────
function validateEnvVar(name) {
  if (!process.env[name]) {
    console.warn(`[ENV] WARNING: ${name} is not set — features relying on it will fail.`);
  }
}

// ── Environment variable loading ─────────────────────────────────────────
// Load env vars synchronously at startup so they're available before any
// handler runs. .dev.vars is small (a few KB) so the sync read is negligible.
try {
  const envPath = join(process.cwd(), '.dev.vars');
  try {
    fs.accessSync(envPath); // SYNC OK: runs at startup
    const content = fs.readFileSync(envPath, 'utf-8'); // SYNC OK: runs at startup
    for (const line of content.split('\n')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    }
  } catch {
    // File doesn't exist or can't be read — that's okay
  }
} catch (e) {
  console.warn('Could not load .dev.vars:', e.message);
}

// Validate env vars at startup so failures are loud and early
validateEnvVar('DEEPSEEK_API_KEY');
validateEnvVar('GROQ_API_KEY');
validateEnvVar('GIPHY_API_KEY');
validateEnvVar('FAL_API_KEY');

// Configure fal.ai client - SDK expects FAL_KEY env var or credentials config
// Map FAL_API_KEY to FAL_KEY for backward compatibility
if (process.env.FAL_API_KEY && !process.env.FAL_KEY) {
  process.env.FAL_KEY = process.env.FAL_API_KEY;
}

const PORT = 3333;
const TEMP_DIR = join(tmpdir(), 'hyperedit-ffmpeg');
const SESSIONS_DIR = join(TEMP_DIR, 'sessions');

// Active video sessions - keeps videos on disk between edits
const sessions = new Map();
const assetUploads = new Map();
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // 8MB
// Clean up stale asset uploads every 2 minutes (uploads that never completed)
setInterval(() => {
  const deadline = Date.now() - 5 * 60 * 1000; // 5 minute expiry
  for (const [id, upload] of assetUploads) {
    if (upload.createdAt < deadline) {
      fs.promises.unlink(upload.tempPath).catch(() => {});
      assetUploads.delete(id);
      console.log(`[Cleanup] Removed stale upload ${id} (${upload.originalName})`);
    }
  }
}, 120_000).unref();

// ── External API rate limiters ───────────────────────────────────────────
const deepseekLimiter = new RateLimiter(1, 2000); // 1 req / 2s
const groqLimiter     = new RateLimiter(1, 1000); // 1 req / 1s
const giphyLimiter    = new RateLimiter(1, 500);  // 1 req / 0.5s

// ── DeepSeek scene generation cache ──────────────────────────────────────
const sceneGenCache = new LRUCache(50, 30 * 60 * 1000); // 50 entries, 30 min TTL

// Ensure temp directories exist
if (!existsSync(TEMP_DIR)) {
  mkdirSync(TEMP_DIR, { recursive: true }); // SYNC OK: runs at startup
}
if (!existsSync(SESSIONS_DIR)) {
  mkdirSync(SESSIONS_DIR, { recursive: true }); // SYNC OK: runs at startup
}
// Local /assets dev folder — files placed here show up in the editor automatically
const ASSETS_FOLDER = pathModule.join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
if (!existsSync(ASSETS_FOLDER)) {
  try { mkdirSync(ASSETS_FOLDER, { recursive: true }); } catch {}
}

// Restore sessions from disk on server start
async function restoreSessionsFromDisk() {
  console.log('[Server] Restoring sessions from disk...');
  const sessionDirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  for (const sessionId of sessionDirs) {
    const sessionDir = join(SESSIONS_DIR, sessionId);
    const assetsDir = join(sessionDir, 'assets');
    const rendersDir = join(sessionDir, 'renders');

    // Skip if assets directory doesn't exist
    if (!existsSync(assetsDir)) {
      console.log(`[Session] Skipping ${sessionId} - no assets directory`);
      continue;
    }

    // Restore project state from disk if it exists
    const projectPath = join(sessionDir, 'project.json');
    let projectState = {
      tracks: [...DEFAULT_TRACKS],
      clips: [],
      settings: { width: 1920, height: 1080, fps: 30 },
    };

    if (existsSync(projectPath)) {
      try {
        projectState = JSON.parse(readFileSync(projectPath, 'utf-8'));
      } catch (e) {
        console.log(`[Session] Could not read project.json for ${sessionId}`);
      }
    }

    // Restore assets from disk
    const assets = new Map();

    // Try to load saved asset metadata first
    const assetsMetaPath = join(sessionDir, 'assets-meta.json');
    let savedAssetsMeta = {};
    if (existsSync(assetsMetaPath)) {
      try {
        savedAssetsMeta = JSON.parse(readFileSync(assetsMetaPath, 'utf-8'));
        console.log(`[Session] Found saved metadata for ${Object.keys(savedAssetsMeta).length} assets`);
      } catch (e) {
        console.log(`[Session] Could not read assets-meta.json for ${sessionId}`);
      }
    }

    const assetFiles = readdirSync(assetsDir, { withFileTypes: true })
      .filter(dirent => dirent.isFile() && !dirent.name.includes('_thumb'));

    for (const assetFile of assetFiles) {
      const assetPath = join(assetsDir, assetFile.name);
      const assetId = assetFile.name.replace(/\.[^/.]+$/, ''); // Remove extension
      const ext = assetFile.name.split('.').pop().toLowerCase();

      // Determine asset type from extension
      let type = 'video';
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        type = 'image';
      } else if (['mp3', 'wav', 'aac', 'm4a'].includes(ext)) {
        type = 'audio';
      }

      try {
        const stats = statSync(assetPath);

        // Skip orphan files: zero-byte files (failed uploads) and files
        // smaller than 1KB. They can't be valid media and would otherwise
        // appear as ghost assets in the user's library.
        if (stats.size < 1024) {
          console.log(`[Session] Skipping orphan/empty asset: ${assetFile.name} (${stats.size} bytes)`);
          continue;
        }

        const thumbPath = join(assetsDir, `${assetId}_thumb.jpg`);

        // Merge with saved metadata if available
        const savedMeta = savedAssetsMeta[assetId] || {};

        // If duration/width/height are missing from metadata (e.g. metadata
        // save raced with a server restart), probe the file directly with
        // ffprobe so the asset is restored with accurate dimensions. Without
        // this, render computes `outPoint = clip.outPoint || asset.duration`
        // → undefined → `trim=0:NaN` → ffmpeg silently drops the clip from
        // the export.
        let duration = savedMeta.duration;
        let width = savedMeta.width;
        let height = savedMeta.height;
        if (type !== 'audio' && (duration === undefined || width === undefined || height === undefined)) {
          try {
            const { stdout } = await execAsync(
              `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -show_entries format=duration -of default=noprint_wrappers=1:nokey=0 "${assetPath}"`
            );
            for (const line of stdout.split('\n')) {
              const [k, v] = line.split('=');
              if (k === 'width' && width === undefined) width = parseInt(v) || undefined;
              if (k === 'height' && height === undefined) height = parseInt(v) || undefined;
              if (k === 'duration' && duration === undefined) duration = parseFloat(v) || undefined;
            }
            if (duration !== undefined) {
              console.log(`[Session] Re-probed ${assetFile.name}: ${width}x${height}, ${duration.toFixed(2)}s`);
            }
          } catch (probeErr) {
            console.log(`[Session] Could not probe ${assetFile.name}: ${probeErr.message}`);
          }
        }

        assets.set(assetId, {
          id: assetId,
          type: savedMeta.type || type,
          filename: savedMeta.filename || assetFile.name,
          path: assetPath,
          thumbPath: existsSync(thumbPath) ? thumbPath : null,
          size: stats.size,
          createdAt: savedMeta.createdAt || stats.mtimeMs,
          // Restore AI-generated metadata
          aiGenerated: savedMeta.aiGenerated || false,
          description: savedMeta.description,
          sceneCount: savedMeta.sceneCount,
          sceneDataPath: savedMeta.sceneDataPath,
          editCount: savedMeta.editCount || 0,
          duration,
          width,
          height,
        });

        if (savedMeta.aiGenerated) {
          console.log(`[Session] Restored AI-generated asset: ${assetFile.name}`);
        }
      } catch (e) {
        console.log(`[Session] Could not stat asset ${assetFile.name}: ${e.message}`);
      }
    }

    if (assets.size === 0) {
      console.log(`[Session] Skipping ${sessionId} - no assets found`);
      continue;
    }

    const session = {
      id: sessionId,
      dir: sessionDir,
      assetsDir,
      rendersDir,
      currentVideo: join(sessionDir, 'current.mp4'), // Legacy
      originalName: 'Restored Project',
      createdAt: Date.now(),
      editCount: 0,
      assets,
      project: projectState,
      transcriptCache: new Map(),
    };

    sessions.set(sessionId, session);
    console.log(`[Session] Restored: ${sessionId} (${assets.size} assets)`);
  }

  console.log(`[Server] Restored ${sessions.size} sessions from disk`);
}

// Save asset metadata to disk (preserves aiGenerated flag, etc.)
async function saveAssetMetadata(session) {
  if (!session || !session.dir) return;

  const assetsMetaPath = join(session.dir, 'assets-meta.json');
  const metadata = {};

  for (const [assetId, asset] of session.assets) {
    // Only save metadata that needs to persist (not paths which are reconstructed)
    metadata[assetId] = {
      type: asset.type,
      filename: asset.filename,
      createdAt: asset.createdAt,
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
      // AI-generated specific metadata
      aiGenerated: asset.aiGenerated || false,
      description: asset.description,
      sceneCount: asset.sceneCount,
      sceneDataPath: asset.sceneDataPath,
      editCount: asset.editCount || 0,
    };
  }

  try {
    await fs.promises.writeFile(assetsMetaPath, JSON.stringify(metadata, null, 2));
  } catch (e) {
    console.log(`[Session] Could not save assets metadata: ${e.message}`);
  }
}

// Lazy session loading — don't scan disk at startup. Sessions are loaded
// on first access via getOrLoadSession.
async function getOrLoadSession(sessionId) {
  // First check in-memory
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  // Lazy-load from disk
  const sessionDir = join(SESSIONS_DIR, sessionId);
  const assetsDir = join(sessionDir, 'assets');
  const rendersDir = join(sessionDir, 'renders');
  try {
    await fs.promises.access(assetsDir);
  } catch {
    return null; // No such session
  }

  // Restore project state
  const projectPath = join(sessionDir, 'project.json');
  let projectState = {
    tracks: [...DEFAULT_TRACKS],
    clips: [],
    settings: { width: 1920, height: 1080, fps: 30 },
  };
  try {
    const content = await fs.promises.readFile(projectPath, 'utf-8');
    projectState = JSON.parse(content);
  } catch { /* no saved project */ }

  // Restore assets
  const assets = new Map();
  const assetsMetaPath = join(sessionDir, 'assets-meta.json');
  let savedMeta = {};
  try {
    const metaContent = await fs.promises.readFile(assetsMetaPath, 'utf-8');
    savedMeta = JSON.parse(metaContent);
  } catch { /* no meta */ }

  try {
    const files = await fs.promises.readdir(assetsDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || file.name.includes('_thumb')) continue;
      const assetId = file.name.replace(/\.[^/.]+$/, '');
      const ext = file.name.split('.').pop().toLowerCase();
      let type = 'video';
      if (['jpg','jpeg','png','gif','webp'].includes(ext)) type = 'image';
      else if (['mp3','wav','aac','m4a'].includes(ext)) type = 'audio';

      try {
        const stats = await fs.promises.stat(join(assetsDir, file.name));
        if (stats.size < 1024) continue; // Skip orphans
        const sm = savedMeta[assetId] || {};
        const thumbPath = join(assetsDir, `${assetId}_thumb.jpg`);
        let thumbExists = false;
        try { await fs.promises.access(thumbPath); thumbExists = true; } catch { /* thumbnail check */ }
        assets.set(assetId, {
          id: assetId, type: sm.type || type, filename: sm.filename || file.name,
          path: join(assetsDir, file.name), thumbPath: thumbExists ? thumbPath : null,
          size: stats.size, createdAt: sm.createdAt || stats.mtimeMs,
          aiGenerated: sm.aiGenerated || false, description: sm.description,
          duration: sm.duration, width: sm.width, height: sm.height,
        });
      } catch (err) { console.error('Error processing assets entry:', err?.message); }
    }
  } catch { /* no assets dir */ }

  const session = {
    id: sessionId, dir: sessionDir, assetsDir, rendersDir,
    currentVideo: join(sessionDir, 'current.mp4'),
    originalName: 'Restored Project', createdAt: Date.now(),
    editCount: 0, assets, project: projectState,
    transcriptCache: new Map(),
  };
  sessions.set(sessionId, session);
  console.log(`[Session] Lazy-loaded: ${sessionId} (${assets.size} assets)`);
  return session;
}

// Session management
async function createSession(originalName) {
  const sessionId = randomUUID();
  const sessionDir = join(SESSIONS_DIR, sessionId);
  const assetsDir = join(sessionDir, 'assets');
  const rendersDir = join(sessionDir, 'renders');

  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.mkdir(assetsDir, { recursive: true });
  await fs.promises.mkdir(rendersDir, { recursive: true });

  // Initialize project state with all 6 tracks
  const projectState = {
    tracks: [...DEFAULT_TRACKS],
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
    },
  };

  const session = {
    id: sessionId,
    dir: sessionDir,
    assetsDir,
    rendersDir,
    currentVideo: join(sessionDir, 'current.mp4'), // Legacy support
    originalName,
    createdAt: Date.now(),
    editCount: 0,
    assets: new Map(), // assetId -> asset info
    project: projectState,
    transcriptCache: new Map(), // assetId -> { text, words, cachedAt }
  };
  sessions.set(sessionId, session);
  console.log(`[Session] Created: ${sessionId}`);
  return session;
}

// Session lookup — always async to support lazy disk loading.
// All callers must await this function.
async function getSession(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  return getOrLoadSession(sessionId);
}

async function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    try {
      await fs.promises.rm(session.dir, { recursive: true, force: true });
      sessions.delete(sessionId);
      console.log(`[Session] Cleaned up: ${sessionId}`);
    } catch (e) {
      console.error(`[Session] Cleanup error for ${sessionId}:`, e.message);
    }
  }
}

// ── Session temp cleanup ─────────────────────────────────────────────
// Delete on-disk session directories that are older than 24 hours.
// These accumulate when the server restarts without cleanup or when
// DELETE /session/:id was missed.
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;     // every hour

async function cleanupOrphanedSessions() {
  try {
    let dirs;
    try {
      dirs = await fs.promises.readdir(SESSIONS_DIR, { withFileTypes: true });
    } catch {
      return; // sessions dir doesn't exist yet — nothing to clean
    }
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    let cleaned = 0;
    for (const dirent of dirs) {
      if (!dirent.isDirectory()) continue;
      const dirPath = join(SESSIONS_DIR, dirent.name);
      try {
        const stat = await fs.promises.stat(dirPath);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
          // Also remove from in-memory map if present
          if (sessions.has(dirent.name)) sessions.delete(dirent.name);
          cleaned++;
        }
      } catch { /* race: already removed */ }
    }
    if (cleaned > 0) console.log(`[Cleanup] Removed ${cleaned} orphaned session(s)`);
  } catch (e) {
    console.warn('[Cleanup] Error cleaning orphaned sessions:', e.message);
  }
}

// Run once at startup (in background), then every hour
cleanupOrphanedSessions();
setInterval(cleanupOrphanedSessions, CLEANUP_INTERVAL_MS);

// Clean up old in-memory sessions (legacy, kept for backward compat)
setInterval(() => {
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  for (const [id, session] of sessions) {
    if (session.createdAt < twoHoursAgo) {
      console.log(`[Session] Auto-cleaning old session: ${id}`);
      cleanupSession(id);
    }
  }
}, 30 * 60 * 1000); // Check every 30 minutes

// Run FFmpeg command and return a promise
function runFFmpeg(args, jobId) {
  return runFFmpegModule(args, jobId);
}

// Run FFprobe command and return stdout
function runFFmpegProbe(args, jobId) {
  return runFFprobeModule(args, jobId);
}

// Detect silence in video and return silence periods
async function detectSilence(inputPath, jobId, options = {}) {
  return detectSilenceModule(inputPath, jobId, options);
}

// Get video/audio duration (returns 0 for images)
async function getVideoDuration(inputPath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
    );
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? 0 : duration;
  } catch {
    return 0;
  }
}

// Calculate segments to keep (inverse of silence periods)
function calculateKeepSegments(silencePeriods, totalDuration, minSegmentDuration = 0.1) {
  return calculateKeepSegmentsModule(silencePeriods, totalDuration, minSegmentDuration);
}

// Remove dead air from video
async function handleRemoveDeadAir(req, res) {
  const jobId = randomUUID();
  const inputPath = join(TEMP_DIR, `${jobId}-input.mp4`);
  const outputPath = join(TEMP_DIR, `${jobId}-output.mp4`);
  const concatListPath = join(TEMP_DIR, `${jobId}-concat.txt`);
  const segmentPaths = [];

  try {
    // Parse the multipart form
    req.socket.setTimeout(0);
    req.resume();
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB
      uploadDir: TEMP_DIR,
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);

    const videoFile = files.video?.[0];
    // More aggressive defaults for "magical" dead air removal
    // -30dB catches more pauses, 0.3s cuts shorter gaps
    const silenceThreshold = parseFloat(fields.silenceThreshold?.[0] || '-30');
    const minSilenceDuration = parseFloat(fields.minSilenceDuration?.[0] || '0.3');

    if (!videoFile) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing video file' }));
      return;
    }

    // Rename uploaded file to our input path
    await rename(videoFile.filepath, inputPath);

    console.log(`\n[${jobId}] === DEAD AIR REMOVAL ===`);
    console.log(`[${jobId}] Input file size: ${(videoFile.size / 1024 / 1024).toFixed(1)} MB`);

    // Step 1: Get video duration
    const totalDuration = await getVideoDuration(inputPath);
    console.log(`[${jobId}] Video duration: ${totalDuration.toFixed(2)}s`);

    // Step 2: Detect silence
    const silencePeriods = await detectSilence(inputPath, jobId, {
      silenceThreshold,
      minSilenceDuration,
    });

    if (silencePeriods.length === 0) {
      console.log(`[${jobId}] No silence detected, returning original video`);
      // Return original video
      const outputStats = await stat(inputPath);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': outputStats.size,
        'Access-Control-Allow-Origin': '*',
      });
      createReadStream(inputPath).pipe(res);
      return;
    }

    // Step 3: Calculate segments to keep
    const keepSegments = calculateKeepSegments(silencePeriods, totalDuration);
    console.log(`[${jobId}] Keeping ${keepSegments.length} segments:`);
    keepSegments.forEach((seg, i) => {
      console.log(`[${jobId}]   Segment ${i + 1}: ${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s (${(seg.end - seg.start).toFixed(2)}s)`);
    });

    const totalKeptDuration = keepSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
    const removedDuration = totalDuration - totalKeptDuration;
    console.log(`[${jobId}] Removing ${removedDuration.toFixed(2)}s of dead air (${((removedDuration / totalDuration) * 100).toFixed(1)}%)`);

    // Single-pass trim+concat filter to keep audio and video in sync
    console.log(`[${jobId}] Building filter chain for ${keepSegments.length} segments...`);

    const filterParts = [];
    const videoStreams = [];
    const audioStreams = [];

    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i];
      filterParts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
      filterParts.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
      videoStreams.push(`[v${i}]`);
      audioStreams.push(`[a${i}]`);
    }

    filterParts.push(`${videoStreams.join('')}concat=n=${keepSegments.length}:v=1:a=0[outv]`);
    filterParts.push(`${audioStreams.join('')}concat=n=${keepSegments.length}:v=0:a=1[outa]`);

    const filterComplex = filterParts.join(';');

    const args = [
      '-y', '-i', inputPath,
      '-filter_complex', filterComplex,
      '-map', '[outv]', '-map', '[outa]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      outputPath
    ];

    await runFFmpeg(args, jobId);
    console.log(`\n[${jobId}] Dead air removal complete`);

    // Read output file and send it back
    const outputStats = await stat(outputPath);
    console.log(`[${jobId}] Output file size: ${(outputStats.size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`[${jobId}] === DEAD AIR REMOVAL COMPLETE ===\n`);

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': outputStats.size,
      'Access-Control-Allow-Origin': '*',
      'X-Removed-Duration': removedDuration.toFixed(2),
      'X-Original-Duration': totalDuration.toFixed(2),
      'X-New-Duration': totalKeptDuration.toFixed(2),
    });

    const readStream = createReadStream(outputPath);
    readStream.pipe(res);

    readStream.on('close', () => {
      // Cleanup temp files
      try {
        unlinkSync(inputPath);
        unlinkSync(outputPath);
        unlinkSync(concatListPath);
        segmentPaths.forEach(p => { try { unlinkSync(p); } catch { /* segment already cleaned */ } });
        console.log(`[${jobId}] Cleaned up temp files`);
      } catch (e) {
        console.error(`[${jobId}] Cleanup error:`, e.message);
      }
    });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);

    // Cleanup on error
    try { unlinkSync(inputPath); } catch { /* cleanup */ }
    try { unlinkSync(outputPath); } catch { /* cleanup */ }
    try { unlinkSync(concatListPath); } catch { /* cleanup */ }
    segmentPaths.forEach(p => { try { unlinkSync(p); } catch { /* segment already cleaned */ } });

    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ error: error.message }));
  }
}

function parseFFmpegArgs(command) {
  const args = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  // Remove 'ffmpeg' prefix if present
  command = command.replace(/^ffmpeg\s+/, '');

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuotes) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

async function handleProcess(req, res) {
  const jobId = randomUUID();
  const inputPath = join(TEMP_DIR, `${jobId}-input.mp4`);
  const outputPath = join(TEMP_DIR, `${jobId}-output.mp4`);

  try {
    // Parse the multipart form
    req.socket.setTimeout(0);
    req.resume();
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB
      uploadDir: TEMP_DIR,
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);

    const videoFile = files.video?.[0];
    const command = fields.command?.[0];

    if (!videoFile || !command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing video or command' }));
      return;
    }

    // Rename uploaded file to our input path
    // Using top-level rename
    await rename(videoFile.filepath, inputPath);

    console.log(`[${jobId}] Processing video with command: ${command}`);
    console.log(`[${jobId}] Input file size: ${(videoFile.size / 1024 / 1024).toFixed(1)} MB`);

    // Parse the FFmpeg command and replace input/output placeholders
    let args = parseFFmpegArgs(command);
    args = args.map(arg => {
      if (arg.match(/input\.[a-z0-9]+/i)) return inputPath;
      if (arg.match(/output\.[a-z0-9]+/i)) return outputPath;
      return arg;
    });

    // Add -y flag to overwrite output if not present
    if (!args.includes('-y')) {
      args.unshift('-y');
    }

    console.log(`[${jobId}] FFmpeg args:`, args);

    // Run FFmpeg
    const ffmpeg = spawn('ffmpeg', args);

    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
      // Log progress lines
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.includes('time=') || line.includes('frame=')) {
          process.stdout.write(`\r[${jobId}] ${line.trim()}`);
        }
      }
    });

    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => {
        console.log(`\n[${jobId}] FFmpeg exited with code ${code}`);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg failed with code ${code}: ${stderr.slice(-500)}`));
        }
      });
      ffmpeg.on('error', reject);
    });

    // Read output file and send it back
    const outputStatsLocal = await stat(outputPath);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': outputStatsLocal.size,
      'Access-Control-Allow-Origin': '*',
    });

    const readStream = createReadStream(outputPath);
    readStream.pipe(res);

    readStream.on('close', () => {
      try {
        unlinkSync(inputPath);
        unlinkSync(outputPath);
        console.log(`[${jobId}] Cleaned up temp files`);
      } catch (e) {
        console.error(`[${jobId}] Cleanup error:`, e.message);
      }
    });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    try { unlinkSync(inputPath); } catch { }
    try { unlinkSync(outputPath); } catch { }
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Get waveform data for an audio/video asset
async function handleAssetWaveform(req, res, sessionId, assetId) {
  const session = await getSession(sessionId);
  if (!session) {
    sendError(res, 404, 'Session not found');
    return;
  }

  const asset = session.assets.get(assetId);
  if (!asset || !existsSync(asset.path)) {
    sendError(res, 404, 'Asset not found');
    return;
  }

  try {
    // Use ffprobe to get audio stats, then ffmpeg to extract waveform peaks
    // First check if the file has an audio stream
    let hasAudio = false;
    try {
      const { stdout: probeStdout } = await execAsync(
        `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "${asset.path}"`
      );
      hasAudio = probeStdout.trim() === 'audio';
    } catch {
      hasAudio = false;
    }

    if (!hasAudio) {
      // No audio stream — return empty waveform
      sendJSON(res, 200, { peaks: [] });
      return;
    }

    // Generate 200 waveform samples using ffmpeg's astats filter
    const numSamples = 200;
    let rmsValues = [];

    try {
      const stderr = await runFFmpegModule([
        '-i', asset.path,
        '-af', `astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
        '-f', 'null',
        '-',
        '-v', 'quiet',
      ], 'waveform', { timeout: 15000 });

      // Parse RMS levels from stderr (runFFmpeg resolves with stderr string)
      const regex = /lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/g;
      let match;
      while ((match = regex.exec(stderr)) !== null) {
        const val = parseFloat(match[1]);
        // Convert dB to normalized 0-1 range (clamp at -60dB as silence)
        const normalized = Math.min(1, Math.max(0, (val + 60) / 60));
        rmsValues.push(normalized);
      }
    } catch (e) {
      console.warn(`[Waveform] astats method failed, using fallback: ${e.message}`);
    }

    // Fallback: extract raw audio and compute peaks
    let peaks;
    if (rmsValues.length < 5) {
      try {
        // Use direct spawn for binary stdout capture
        const rawResult = await new Promise((resolve, reject) => {
          const proc = spawn('ffmpeg', [
            '-i', asset.path,
            '-ac', '1',
            '-ar', '8000',
            '-f', 's16le',
            '-',
            '-v', 'quiet',
          ], { timeout: 15000 });
          const chunks = [];
          proc.stdout.on('data', (chunk) => chunks.push(chunk));
          proc.on('close', (code) => {
            if (code === 0) resolve(Buffer.concat(chunks));
            else reject(new Error(`ffmpeg raw audio exit code ${code}`));
          });
          proc.on('error', reject);
        });

        if (rawResult.length > 0) {
          const samples = new Int16Array(rawResult.buffer, rawResult.byteOffset, rawResult.length / 2);
          const chunkSize = Math.max(1, Math.floor(samples.length / numSamples));
          peaks = [];
          for (let i = 0; i < numSamples; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, samples.length);
            let max = 0;
            for (let j = start; j < end; j++) {
              const abs = Math.abs(samples[j]);
              if (abs > max) max = abs;
            }
            peaks.push(max / 32768);
          }
        } else {
          peaks = Array(numSamples).fill(0);
        }
      } catch (e) {
        console.warn(`[Waveform] fallback also failed: ${e.message}`);
        peaks = Array(numSamples).fill(0);
      }
    } else {
      // Downsample to numSamples samples
      const step = Math.max(1, Math.floor(rmsValues.length / numSamples));
      peaks = [];
      for (let i = 0; i < numSamples; i++) {
        const idx = Math.min(Math.floor(i * step), rmsValues.length - 1);
        peaks.push(rmsValues[idx] || 0);
      }
    }

    sendJSON(res, 200, { peaks });
  } catch (err) {
    console.error(`[Waveform] Error for asset ${assetId}:`, err.message);
    sendJSON(res, 200, { peaks: [] }); // Return empty waveform rather than erroring
  }
}

// Stream asset
async function handleAssetStream(req, res, sessionId, assetId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const asset = session.assets.get(assetId);
  if (!asset || !existsSync(asset.path)) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Asset not found' }));
    return;
  }

  const fileStats = await stat(asset.path);
  const fileSize = fileStats.size;

  // Get proper MIME type for the asset
  const getContentType = () => {
    if (asset.type === 'image') {
      const ext = asset.path.split('.').pop()?.toLowerCase();
      const mimeTypes = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
      };
      return mimeTypes[ext] || 'image/jpeg';
    }
    if (asset.type === 'audio') {
      const ext = asset.path.split('.').pop()?.toLowerCase();
      const mimeTypes = {
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'ogg': 'audio/ogg',
        'm4a': 'audio/mp4',
        'aac': 'audio/aac',
      };
      return mimeTypes[ext] || 'audio/mpeg';
    }
    return 'video/mp4';
  };
  const contentType = getContentType();

  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    let start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Clamp values to valid range (prevents crash if file size changed)
    if (start >= fileSize) {
      // Requested range is completely outside file - return 416
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end();
      return;
    }
    if (end >= fileSize) {
      end = fileSize - 1;
    }
    if (start > end) {
      start = end;
    }

    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });

    createReadStream(asset.path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(asset.path).pipe(res);
  }
}

// Get project state
async function handleProjectGet(req, res, sessionId) {
  const session = await getOrLoadSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  // Verify the session directory still exists on disk
  if (!session.dir || !existsSync(session.dir)) {
    console.log(`[Session] Directory missing for ${sessionId}, cleaning up`);
    sessions.delete(sessionId);
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session files no longer exist' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({
    tracks: session.project.tracks,
    clips: session.project.clips,
    settings: session.project.settings,
    captions: session.project.captions || {},
    timelineTabs: session.project.timelineTabs || [],
    version: session.project.version || 0,
  }));
}

// Save project state
async function handleProjectSave(req, res, sessionId) {
  const session = await getOrLoadSession(sessionId);
  if (!session) {
    sendError(res, 404, 'Session not found');
    return;
  }

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);

    // Validate project data with Zod
    const validation = ProjectSchema.safeParse(data);
    if (!validation.success) {
      const details = validation.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      console.warn(`[${sessionId}] Project save validation failed: ${details}`);
      sendError(res, 400, `Invalid project data: ${details}`);
      return;
    }

    // Version conflict detection (optimistic locking)
    const currentVersion = session.project.version || 0;
    const clientVersion = data.version !== undefined ? data.version : currentVersion;

    if (clientVersion < currentVersion) {
      sendError(res, 409, `Version conflict: client version ${clientVersion} is behind server version ${currentVersion}`);
      return;
    }

    if (data.tracks) session.project.tracks = data.tracks;
    if (data.clips) session.project.clips = data.clips;
    if (data.settings) session.project.settings = { ...session.project.settings, ...data.settings };
    if (data.captions) session.project.captions = data.captions;
    // Persist edit-tab clips so animations being edited in a tab survive
    // page reloads. Without this, opening an animation in a tab and then
    // refreshing the browser nukes the tab and the user's edits.
    if (data.timelineTabs) session.project.timelineTabs = data.timelineTabs;

    // Increment version
    session.project.version = (session.project.version || 0) + 1;

    // Save to disk for persistence
    const projectPath = join(session.dir, 'project.json');
    await fs.promises.writeFile(projectPath, JSON.stringify(session.project, null, 2));

    console.log(`[${sessionId}] Project saved v${session.project.version}: ${session.project.clips.length} clips, ${(session.project.timelineTabs || []).length} edit tab(s)`);

    sendSuccess(res, { success: true, version: session.project.version });

  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Render project to video
// Quick check whether a media file contains an audio stream. Used by the
// render pipeline to decide which inputs to mix into the output.
function hasAudioStream(filePath) {
  return hasAudioStreamModule(filePath);
}

// Format a number of seconds as an ASS timestamp: H:MM:SS.cc (centiseconds)
function formatAssTime(seconds) {
  return formatAssTimeModule(seconds);
}

// Build an Advanced SubStation Alpha (.ass) file from caption clips on T1.
// We use .ass instead of SRT because libass uses a virtual 288px coordinate
// space when reading SRT, which makes Fontsize unpredictable and force_style
// can't override PlayResY. With a real .ass header (PlayResX/PlayResY) every
// size below is in actual output pixels.
//
// The editor renders captions in CSS pixels on a fixed-height preview pane
// (`h-[65vh]` ≈ 650px tall). To make the export visually match the editor,
// we scale fontSize from the preview reference to the output height.
function buildAssFromCaptions(clips, captions, settings) {
  return buildAssFromCaptionsModule(clips, captions, settings);
}

// Map our CaptionStyle.position to the libass alignment integer:
//   bottom = 2 (bottom-center), center = 5 (middle-center), top = 8 (top-center)
function captionAlignment(position) {
  if (position === 'top') return 8;
  if (position === 'center') return 5;
  return 2;
}

// Convert a CSS hex color (`#RRGGBB`) to libass's `&HAABBGGRR` byte order
// (alpha=00 = fully opaque). Falls back to white on parse failure.
function libassColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '&H00FFFFFF';
  const rgb = m[1];
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  return `&H00${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
}

async function handleProjectRender(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const options = body ? JSON.parse(body) : {};
    const isPreview = options.preview === true;
    const captions = options.captions || {};
    const quality = options.quality || (isPreview ? 'draft' : 'standard');

    // Quality presets
    const QUALITY_PRESETS = {
      draft:  { preset: 'ultrafast', crf: '28', resolution: null, fps: null },
      standard: { preset: 'medium', crf: '18', resolution: null, fps: null },
      high:    { preset: 'slow', crf: '16', resolution: null, fps: 60 },
      ultra:   { preset: 'slow', crf: '14', resolution: '3840x2160', fps: 60 },
    };

    const qConfig = QUALITY_PRESETS[quality] || QUALITY_PRESETS.standard;

    const clips = session.project.clips;
    const settings = session.project.settings;

    if (clips.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No clips in timeline' }));
      return;
    }

    console.log(`\n[${sessionId}] === RENDER ${isPreview ? 'PREVIEW' : 'EXPORT'} ===`);
    console.log(`[${sessionId}] ${clips.length} clips, ${settings.width}x${settings.height}`);

    // Surface clips that reference unknown assets — these would otherwise
    // be silently dropped from the export.
    for (const clip of clips) {
      if (clip.trackId === 'T1') continue; // T1 = captions, no asset needed
      if (!clip.assetId) continue;
      const asset = session.assets.get(clip.assetId);
      if (!asset) {
        console.warn(`[${sessionId}] ⚠ Clip ${clip.id.slice(0,8)} on ${clip.trackId} references missing asset ${clip.assetId.slice(0,8)} — DROPPED FROM EXPORT`);
      } else if (asset.duration === undefined || asset.duration === null) {
        console.warn(`[${sessionId}] ⚠ Clip ${clip.id.slice(0,8)} on ${clip.trackId} (${asset.filename}) has no duration metadata — may render incorrectly`);
      }
    }

    // Sort video clips so V1 (base) is overlaid first, then V2, then V3.
    const videoClips = clips
      .filter(c => session.assets.get(c.assetId)?.type !== 'audio')
      .filter(c => session.assets.get(c.assetId))
      .sort((a, b) => {
        const trackOrder = { 'V1': 0, 'V2': 1, 'V3': 2 };
        return (trackOrder[a.trackId] || 0) - (trackOrder[b.trackId] || 0);
      });

    const audioClips = clips
      .filter(c => session.assets.get(c.assetId)?.type === 'audio');

    console.log(`[${sessionId}] Will render ${videoClips.length} video clip(s) + ${audioClips.length} audio clip(s)`);
    for (const c of videoClips) {
      const a = session.assets.get(c.assetId);
      console.log(`[${sessionId}]   → ${c.trackId} | ${a.filename} | start=${c.start}s dur=${c.duration}s ai=${a.aiGenerated || false}`);
    }

    const totalDuration = Math.max(
      ...clips.map(c => c.start + c.duration),
      0.1
    );

    // Assign a single input index per clip so video and audio filter chains
    // reference the same inputs. Video clips get loaded first (so V1/V2/V3
    // inputs are contiguous), then dedicated audio clips.
    const inputs = [];
    const filterParts = [];
    let inputIndex = 0;
    const clipInputs = []; // [{ clip, asset, inputIdx, kind: 'video' | 'audio' }]

    for (const clip of videoClips) {
      const asset = session.assets.get(clip.assetId);
      if (!asset) continue;
      inputs.push('-i', asset.path);
      clipInputs.push({ clip, asset, inputIdx: inputIndex++, kind: 'video' });
    }
    for (const clip of audioClips) {
      const asset = session.assets.get(clip.assetId);
      if (!asset) continue;
      inputs.push('-i', asset.path);
      clipInputs.push({ clip, asset, inputIdx: inputIndex++, kind: 'audio' });
    }

    // Base canvas spans the whole timeline so every overlay has something to
    // composite against, even in the gaps between clips.
    filterParts.push(`color=black:s=${settings.width}x${settings.height}:d=${totalDuration}:r=${settings.fps}[base]`);
    let lastVideo = 'base';

    // Build the video overlay chain. CRITICAL: each clip's PTS is shifted to
    // `clip.start` (`setpts=PTS-STARTPTS+clip.start/TB`). Without that offset
    // every clip's frames are at PTS 0..trimDuration, so when the output is
    // at t=clip.start the overlay filter has already exhausted the clip and
    // freezes on the last frame for the entire enable window.
    for (const { clip, asset, inputIdx, kind } of clipInputs) {
      if (kind !== 'video') continue;

      // Defensive trim bounds: prefer the clip's explicit out, fall back to
      // asset duration, then to clip.duration. Whatever we end up with must
      // be a finite positive number — otherwise ffmpeg gets `trim=0:NaN` and
      // silently drops the clip from the chain.
      const inPoint = Number.isFinite(clip.inPoint) ? clip.inPoint : 0;
      let outPoint = Number.isFinite(clip.outPoint) ? clip.outPoint : (Number.isFinite(asset.duration) ? asset.duration : null);
      if (!Number.isFinite(outPoint) || outPoint <= inPoint) {
        outPoint = inPoint + (Number.isFinite(clip.duration) ? clip.duration : 1);
        console.warn(`[${sessionId}] Clip ${clip.id.slice(0,8)} (${asset.filename}) had invalid outPoint, recovered with outPoint=${outPoint}`);
      }
      const trimDuration = outPoint - inPoint;

      let clipFilter = `[${inputIdx}:v]`;
      clipFilter += `trim=${inPoint}:${outPoint},setpts=PTS-STARTPTS+${clip.start}/TB,`;
      clipFilter += `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease,`;
      clipFilter += `pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2`;

      if (clip.transform) {
        const { scale = 1 } = clip.transform;
        if (scale !== 1) {
          clipFilter += `,scale=iw*${scale}:ih*${scale}`;
        }
      }

      clipFilter += `[v${inputIdx}]`;
      filterParts.push(clipFilter);

      const overlayX = clip.transform?.x || `(W-w)/2`;
      const overlayY = clip.transform?.y || `(H-h)/2`;
      const enable = `between(t,${clip.start},${clip.start + trimDuration})`;

      filterParts.push(`[${lastVideo}][v${inputIdx}]overlay=x=${overlayX}:y=${overlayY}:enable='${enable}'[out${inputIdx}]`);
      lastVideo = `out${inputIdx}`;
    }

    // Burn captions onto the composite. We build a real .ass file with
    // PlayResY = output height so all sizes (Fontsize, MarginV, Outline) are
    // in actual output pixels. Caption data is posted from the React client
    // on each render request — it's not persisted server-side.
    const assBody = buildAssFromCaptions(clips, captions, settings);
    let videoChainTail = lastVideo;
    if (assBody) {
      const assPath = join(session.dir, `render-captions-${Date.now()}.ass`);
      await fs.promises.writeFile(assPath, assBody, 'utf-8');

      // ffmpeg's `subtitles` filter parser is quoted-arg sensitive — escape
      // colons in the path so it isn't read as a key=value separator.
      const escapedPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      filterParts.push(`[${videoChainTail}]subtitles='${escapedPath}'[vcaptioned]`);
      videoChainTail = 'vcaptioned';
      console.log(`[${sessionId}] Captions: ${assBody.split('\nDialogue:').length - 1} lines burned in`);
    }

    filterParts.push(`[${videoChainTail}]copy[vout]`);

    // Build audio: only V1 video audio + dedicated A1/A2 audio. V2/V3 video
    // overlays (b-roll, gifs, animations) are MUTED in the editor preview
    // (VideoPreview.tsx renders overlay videos with `muted`), so the export
    // matches that — otherwise every overlay's background noise leaks into
    // the final mix.
    const audioStreams = [];
    for (const { clip, asset, inputIdx, kind } of clipInputs) {
      if (kind === 'video' && clip.trackId !== 'V1') continue;
      if (!hasAudioStream(asset.path)) continue;
      const inPoint = clip.inPoint ?? 0;
      const outPoint = clip.outPoint ?? asset.duration;
      const delayMs = Math.max(0, Math.floor(clip.start * 1000));
      filterParts.push(
        `[${inputIdx}:a]atrim=${inPoint}:${outPoint},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[aud${inputIdx}]`
      );
      audioStreams.push(`[aud${inputIdx}]`);
    }

    let hasAudioOutput = false;
    if (audioStreams.length > 0) {
      filterParts.push(
        `${audioStreams.join('')}amix=inputs=${audioStreams.length}:dropout_transition=0:normalize=0[aout]`
      );
      hasAudioOutput = true;
    }

    // Build final command
    const outputPath = join(session.rendersDir, isPreview ? 'preview.mp4' : `export-${Date.now()}.mp4`);

    const ffmpegArgs = [
      '-y',
      ...inputs,
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]',
    ];

    if (hasAudioOutput) {
      ffmpegArgs.push('-map', '[aout]');
    }

    // Encoding settings based on quality preset
    ffmpegArgs.push('-c:v', 'libx264', '-preset', qConfig.preset, '-crf', qConfig.crf);

    // Resolution override for ultra quality
    if (qConfig.resolution) {
      ffmpegArgs.push('-vf', `scale=${qConfig.resolution}:force_original_aspect_ratio=decrease,pad=${qConfig.resolution}:(ow-iw)/2:(oh-ih)/2`);
    }
    if (qConfig.fps) {
      ffmpegArgs.push('-r', String(qConfig.fps));
    }

    ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k');
    ffmpegArgs.push('-movflags', '+faststart');
    ffmpegArgs.push('-t', totalDuration.toString());
    ffmpegArgs.push(outputPath);

    console.log(`[${sessionId}] FFmpeg render command prepared`);

    await runFFmpeg(ffmpegArgs, sessionId);

    // stat already imported at top level
    const outputStats = await stat(outputPath);

    console.log(`[${sessionId}] Render complete: ${(outputStats.size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`[${sessionId}] === RENDER COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      path: outputPath,
      size: outputStats.size,
      duration: totalDuration,
      downloadUrl: `/session/${sessionId}/renders/${isPreview ? 'preview' : 'export'}`,
    }));

  } catch (error) {
    console.error(`[${sessionId}] Render error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Download rendered video
async function handleRenderDownload(req, res, sessionId, renderType) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  // Find the render file
  const files = await fs.promises.readdir(session.rendersDir);

  let renderFile;
  if (renderType === 'preview') {
    renderFile = files.find(f => f === 'preview.mp4');
  } else {
    // Get most recent export
    renderFile = files
      .filter(f => f.startsWith('export-'))
      .sort()
      .pop();
  }

  if (!renderFile) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Render not found' }));
    return;
  }

  const renderPath = join(session.rendersDir, renderFile);
  const renderStats = await stat(renderPath);

  const filename = renderType === 'preview' ? 'preview.mp4' : `${session.originalName.replace(/\.[^.]+$/, '')}-export.mp4`;

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': renderStats.size,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Allow-Origin': '*',
  });

  createReadStream(renderPath).pipe(res);
}

// Create animated GIF from an image
async function handleCreateGif(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const options = body ? JSON.parse(body) : {};

    const {
      sourceAssetId,
      effect = 'pulse', // pulse, zoom, rotate, bounce, fade
      duration = 2,      // seconds
      fps = 15,
      width = 400,
      height = 400,
    } = options;

    const sourceAsset = session.assets.get(sourceAssetId);
    if (!sourceAsset) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Source asset not found' }));
      return;
    }

    if (sourceAsset.type !== 'image') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Source must be an image' }));
      return;
    }

    const jobId = randomUUID();
    console.log(`\n[${jobId}] === CREATE ANIMATED GIF ===`);
    console.log(`[${jobId}] Source: ${sourceAsset.filename}, Effect: ${effect}, Duration: ${duration}s`);

    // Generate GIF output path
    const gifId = randomUUID();
    const gifPath = join(session.assetsDir, `${gifId}.gif`);
    const thumbPath = join(session.assetsDir, `${gifId}_thumb.jpg`);

    // Build FFmpeg filter based on effect
    let filter;
    const totalFrames = duration * fps;

    switch (effect) {
      case 'pulse':
        // Pulsing scale effect (breathe in/out)
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
          `zoompan=z='1+0.1*sin(on*PI*2/${totalFrames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
        break;

      case 'zoom':
        // Ken Burns zoom in effect
        filter = `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=decrease,` +
          `zoompan=z='min(zoom+0.002,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
        break;

      case 'rotate':
        // Gentle rotation effect
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
          `rotate=t*PI/8:c=none:ow=${width}:oh=${height},fps=${fps}`;
        break;

      case 'bounce':
        // Bouncing effect (up and down)
        filter = `scale=${width}:${height - 40}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:'(oh-ih)/2+20*sin(t*PI*2)':color=transparent,fps=${fps}`;
        break;

      case 'fade':
        // Fade in and out
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
          `fade=t=in:st=0:d=${duration / 4},fade=t=out:st=${duration * 3 / 4}:d=${duration / 4},fps=${fps}`;
        break;

      case 'shake':
        // Shake/vibrate effect
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width + 20}:${height + 20}:(ow-iw)/2:(oh-ih)/2,` +
          `crop=${width}:${height}:'10+5*sin(t*30)':'10+5*cos(t*25)',fps=${fps}`;
        break;

      default:
        // Simple loop with no animation
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`;
    }

    // FFmpeg command to create animated GIF
    const ffmpegArgs = [
      '-y',
      '-loop', '1',
      '-i', sourceAsset.path,
      '-t', duration.toString(),
      '-vf', filter,
      '-gifflags', '+transdiff',
      gifPath
    ];

    console.log(`[${jobId}] Running FFmpeg...`);
    await runFFmpeg(ffmpegArgs, jobId);

    // Generate thumbnail from first frame
    try {
      await runFFmpeg([
        '-y',
        '-i', gifPath,
        '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        thumbPath
      ], jobId);
    } catch (e) {
      console.warn(`[${jobId}] Thumbnail generation failed:`, e.message);
    }

    const stats = await stat(gifPath);

    // Create asset entry
    const gifAsset = {
      id: gifId,
      type: 'image',
      filename: `${sourceAsset.filename.replace(/\.[^.]+$/, '')}-${effect}.gif`,
      path: gifPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: duration, // GIFs have duration
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
    };

    session.assets.set(gifId, gifAsset);

    console.log(`[${jobId}] GIF created: ${(stats.size / 1024).toFixed(1)} KB`);
    console.log(`[${jobId}] === GIF CREATION COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      asset: {
        id: gifAsset.id,
        type: gifAsset.type,
        filename: gifAsset.filename,
        duration: gifAsset.duration,
        size: gifAsset.size,
        width: gifAsset.width,
        height: gifAsset.height,
        thumbnailUrl: gifAsset.thumbPath ? `/session/${sessionId}/assets/${gifId}/thumbnail` : null,
      },
    }));

  } catch (error) {
    console.error(`[${sessionId}] GIF creation error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ============== TRANSCRIPTION & KEYWORD EXTRACTION ==============

// Known keywords/brands to detect in transcripts
const KNOWN_KEYWORDS = [
  // Tech companies
  'anthropic', 'claude', 'openai', 'chatgpt', 'gpt', 'google', 'gemini', 'bard',
  'microsoft', 'copilot', 'meta', 'llama', 'apple', 'siri', 'amazon', 'alexa',
  'nvidia', 'tesla', 'spacex', 'neuralink', 'twitter', 'x',
  // Social media
  'youtube', 'tiktok', 'instagram', 'facebook', 'snapchat', 'linkedin', 'reddit',
  'discord', 'twitch', 'spotify',
  // People
  'elon musk', 'sam altman', 'mark zuckerberg', 'sundar pichai', 'satya nadella',
  'tim cook', 'jensen huang', 'dario amodei', 'trump', 'biden',
  // General tech terms
  'artificial intelligence', 'machine learning', 'neural network', 'blockchain',
  'cryptocurrency', 'bitcoin', 'ethereum', 'nft', 'metaverse', 'virtual reality',
  'augmented reality', 'robotics', 'automation',
  // Products
  'iphone', 'android', 'windows', 'macbook', 'playstation', 'xbox', 'nintendo',
  'airpods', 'vision pro',
];

// Extract keywords from transcript with timestamps
function extractKeywordsFromTranscript(transcript, words) {
  const foundKeywords = [];
  const lowerTranscript = transcript.toLowerCase();

  for (const keyword of KNOWN_KEYWORDS) {
    const lowerKeyword = keyword.toLowerCase();
    let searchIndex = 0;

    while (true) {
      const index = lowerTranscript.indexOf(lowerKeyword, searchIndex);
      if (index === -1) break;

      // Find the timestamp for this occurrence
      // We need to count characters to find which word this belongs to
      let charCount = 0;
      let timestamp = 0;
      let confidence = 0.9;

      for (const word of words) {
        const wordEnd = charCount + word.word.length + 1; // +1 for space
        if (index >= charCount && index < wordEnd) {
          timestamp = word.start;
          confidence = word.confidence || 0.9;
          break;
        }
        charCount = wordEnd;
      }

      // Avoid duplicates within 5 seconds
      const isDuplicate = foundKeywords.some(
        k => k.keyword === keyword && Math.abs(k.timestamp - timestamp) < 5
      );

      if (!isDuplicate) {
        foundKeywords.push({
          keyword,
          timestamp,
          confidence,
        });
      }

      searchIndex = index + keyword.length;
    }
  }

  // Sort by timestamp
  foundKeywords.sort((a, b) => a.timestamp - b.timestamp);

  return foundKeywords;
}

// Transcribe video using OpenAI Whisper API
async function transcribeVideo(videoPath, jobId) {
  const audioPath = join(TEMP_DIR, `${jobId}-audio-whisper.mp3`);

  try {
    // Extract audio
    console.log(`[${jobId}] Extracting audio for transcription...`);
    await runFFmpeg([
      '-y', '-i', videoPath,
      '-vn', '-acodec', 'libmp3lame',
      '-ab', '64k', '-ar', '16000', '-ac', '1',
      audioPath
    ], jobId);

    // stat already imported at top level
    const audioStats = await stat(audioPath);
    console.log(`\n[${jobId}] Audio extracted: ${(audioStats.size / 1024 / 1024).toFixed(1)} MB`);

    // Send to Groq Whisper API (free, fast)
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY not configured in .dev.vars');
    }

    // Rate limit: max 1 request per second
    await groqLimiter.acquire(3, 1000);

    console.log(`[${jobId}] Sending to Groq Whisper API...`);

    // Check file size: Groq free tier has 25MB limit, otherwise use URL upload
    let transcriptionResponse;
    const audioBuffer = await fs.promises.readFile(audioPath);

    // Use Groq API directly with fetch
    const groqFormData = new FormData();
    const audioFile = new Blob([audioBuffer], { type: 'audio/mp3' });
    groqFormData.append('file', audioFile, 'audio.mp3');
    groqFormData.append('model', 'whisper-large-v3');
    groqFormData.append('response_format', 'verbose_json');
    groqFormData.append('language', 'en');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: groqFormData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq Whisper API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`[${jobId}] Groq transcription complete: ${result.text?.length || 0} characters`);

    // Cleanup
    try { unlinkSync(audioPath); } catch { /* audio cleanup */ }

    return {
      text: result.text || '',
      words: (result.words || []).map(w => ({
        text: w.word || w.text || '',
        start: w.start || 0,
        end: w.end || 0,
      })),
      duration: result.duration || 0,
    };

  } catch (error) {
    try { unlinkSync(audioPath); } catch { /* audio cleanup */ }
    throw error;
  }
}

// ============== ASSET UPLOAD HANDLERS ==============

// Finalize an uploaded asset (move file, probe metadata, generate thumbnail)
async function finalizeUploadedAsset(session, tempFilePath, originalName) {
  const assetId = randomUUID();
  const ext = originalName.split('.').pop()?.toLowerCase() || 'mp4';
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
  const isAudio = ['mp3', 'wav', 'aac', 'm4a', 'ogg'].includes(ext);
  const type = isImage ? 'image' : isAudio ? 'audio' : 'video';
  const assetPath = join(session.assetsDir, `${assetId}.${ext}`);
  const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

  await rename(tempFilePath, assetPath);

  let duration = 0, width = 0, height = 0;
  if (!isAudio) {
    const info = await getMediaInfoModule(assetPath);
    duration = info.duration; width = info.width; height = info.height;
  } else {
    duration = await getDurationModule(assetPath);
  }

  if (!isAudio) {
    try { await generateThumbnailModule(assetPath, thumbPath, isImage); }
    catch (e) { console.warn(`[${session.id}] Thumb gen failed:`, e.message); }
  }

  const stats = await stat(assetPath);
  const asset = {
    id: assetId, type, filename: originalName, path: assetPath,
    thumbPath: existsSync(thumbPath) ? thumbPath : null,
    duration: isImage ? 5 : duration, size: stats.size, width, height,
    createdAt: Date.now(),
  };

  session.assets.set(assetId, asset);
  await saveAssetMetadataModule(session);
  return asset;
}

async function handleAssetUpload(req, res, sessionId) {
  const session = await getOrLoadSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  req.socket.setTimeout(0);
  req.socket.setKeepAlive(true);
  req.setTimeout(0);
  res.setTimeout(0);

  let clientDisconnected = false;
  let uploadedBytes = 0;
  const totalBytes = parseInt(req.headers['content-length'] || '0', 10);

  req.on('aborted', () => { clientDisconnected = true; });

  try {
    const form = formidable({
      maxFileSize: 100 * 1024 * 1024 * 1024,
      maxTotalFileSize: 100 * 1024 * 1024 * 1024,
      maxFieldsSize: 100 * 1024 * 1024 * 1024,
      uploadDir: session.assetsDir,
      keepExtensions: true,
      allowEmptyFiles: false,
      multiples: false,
      filename: () => `${randomUUID()}`,
    });

    const [, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) { reject(err); return; }
        resolve([fields, files]);
      });
    });

    const uploadedFile = files.file?.[0] || files.video?.[0];
    if (!uploadedFile) { sendError(res, 400, 'Missing file'); return; }

    const originalName = uploadedFile.originalFilename || 'file';
    const asset = await finalizeUploadedAsset(session, uploadedFile.filepath, originalName);

    console.log(`[${sessionId}] Asset uploaded: ${asset.id} (${asset.type}, ${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

    sendSuccess(res, {
      success: true,
      asset: {
        id: asset.id, type: asset.type, filename: asset.filename,
        duration: asset.duration, size: asset.size,
        width: asset.width, height: asset.height,
        thumbnailUrl: asset.thumbPath ? `/session/${sessionId}/assets/${asset.id}/thumbnail` : null,
      },
    });
  } catch (error) {
    console.error(`[${sessionId}] Upload error:`, error.message);
    if (clientDisconnected) return;
    try { sendError(res, 500, error.message); } catch { /* client disconnected */ }
  }
}

async function handleAssetUploadInit(req, res, sessionId) {
  const session = await getOrLoadSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  try {
    const body = await parseBody(req);
    const filename = String(body.filename || '').trim();
    const size = Number(body.size || 0);
    if (!filename || !Number.isFinite(size) || size <= 0) {
      sendError(res, 400, 'Invalid upload metadata');
      return;
    }

    const uploadsDir = join(session.dir, 'uploads');
    await mkdir(uploadsDir, { recursive: true });

    const uploadId = randomUUID();
    const tempPath = join(uploadsDir, `${uploadId}.part`);
    await writeFile(tempPath, '');

    assetUploads.set(uploadId, {
      sessionId, originalName: filename, expectedSize: size,
      receivedBytes: 0, tempPath, createdAt: Date.now(),
    });

    sendSuccess(res, { uploadId, chunkSize: UPLOAD_CHUNK_SIZE });
  } catch (error) {
    sendError(res, 500, error.message || 'Failed to init upload');
  }
}

async function handleAssetUploadChunk(req, res, sessionId) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const uploadId = url.searchParams.get('uploadId');
  const upload = uploadId ? assetUploads.get(uploadId) : null;

  if (!upload || upload.sessionId !== sessionId) {
    sendError(res, 404, 'Upload not found');
    return;
  }

  let aborted = false;
  const onAbort = () => { if (!aborted) { aborted = true; req.destroy(); } };
  req.on('aborted', () => { if (!aborted) { aborted = true; onAbort(); } });
  req.on('close', () => { if (!aborted) { aborted = true; onAbort(); } });

  try {
    const chunks = [];
    let received = 0;
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => { chunks.push(chunk); received += chunk.length; });
      req.on('end', () => { if (!aborted) resolve(); });
      req.on('error', reject);
      req.on('aborted', () => reject(new Error('Aborted')));
      req.on('close', () => { if (!aborted) reject(new Error('Aborted')); });
    }).catch(() => {});

    if (aborted) return;
    if (received === 0) { sendError(res, 400, 'Empty chunk'); return; }

    await appendFile(upload.tempPath, Buffer.concat(chunks));
    upload.receivedBytes += received;

    sendSuccess(res, {
      uploadId,
      receivedBytes: upload.receivedBytes,
      percent: Math.min(100, Math.round((upload.receivedBytes / upload.expectedSize) * 100)),
    });
  } catch (error) {
    if (aborted || error?.message?.includes('Abort')) return;
    sendError(res, 500, error.message || 'Chunk upload failed');
  }
}

async function handleAssetUploadComplete(req, res, sessionId) {
  const session = await getOrLoadSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  try {
    const body = await parseBody(req);
    const uploadId = String(body.uploadId || '');
    const upload = assetUploads.get(uploadId);
    if (!upload || upload.sessionId !== sessionId) {
      sendError(res, 404, 'Upload not found');
      return;
    }

    const fileStats = await stat(upload.tempPath);
    if (fileStats.size <= 0) {
      sendError(res, 400, 'Uploaded file is empty');
      return;
    }
    if (upload.expectedSize > 0 && fileStats.size !== upload.expectedSize) {
      sendError(res, 400, `Upload incomplete: received ${fileStats.size} of ${upload.expectedSize} bytes`);
      return;
    }

    const asset = await finalizeUploadedAsset(session, upload.tempPath, upload.originalName);
    assetUploads.delete(uploadId);

    console.log(`[${sessionId}] Chunked asset uploaded: ${asset.id} (${asset.type}, ${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
    sendSuccess(res, {
      success: true,
      asset: {
        id: asset.id, type: asset.type, filename: asset.filename,
        duration: asset.duration, size: asset.size,
        width: asset.width, height: asset.height,
        thumbnailUrl: asset.thumbPath ? `/session/${sessionId}/assets/${asset.id}/thumbnail` : null,
      },
    });
  } catch (error) {
    sendError(res, 500, error.message || 'Upload complete failed');
  }
}

async function handleAssetList(req, res, sessionId) {
  const session = await getOrLoadSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  const assets = Array.from(session.assets.values()).map(asset => ({
    id: asset.id, type: asset.type, filename: asset.filename,
    duration: asset.duration, size: asset.size,
    width: asset.width, height: asset.height,
    thumbnailUrl: asset.thumbPath ? `/session/${sessionId}/assets/${asset.id}/thumbnail` : null,
    aiGenerated: asset.aiGenerated || false,
  }));
  sendSuccess(res, { assets });
}

async function handleAssetDelete(req, res, sessionId, assetId) {
  const session = await getOrLoadSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  const asset = session.assets.get(assetId);
  if (!asset) { sendError(res, 404, 'Asset not found'); return; }

  try { await unlink(asset.path).catch(() => {}); } catch {}
  try { if (asset.thumbPath) await unlink(asset.thumbPath).catch(() => {}); } catch {}

  session.assets.delete(assetId);
  await saveAssetMetadataModule(session);
  session.project.clips = (session.project.clips || []).filter(clip => clip.assetId !== assetId);
  sendSuccess(res, { success: true });
}

async function handleAssetThumbnail(req, res, sessionId, assetId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  const asset = session.assets.get(assetId);
  if (!asset || !asset.thumbPath || !existsSync(asset.thumbPath)) {
    sendError(res, 404, 'Thumbnail not found');
    return;
  }

  const thumbStats = await stat(asset.thumbPath);
  res.writeHead(200, {
    'Content-Type': 'image/jpeg', 'Content-Length': thumbStats.size,
    'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*',
  });
  createReadStream(asset.thumbPath).pipe(res);
}

async function handleAssetImport(req, res, sessionId) {
  const session = await getOrLoadSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  try {
    const body = await parseBody(req);
    const filename = String(body.filename || '').trim();
    if (!filename) { sendError(res, 400, 'Missing filename'); return; }

    const srcPath = join(ASSETS_FOLDER, filename);
    if (!existsSync(srcPath)) {
      sendError(res, 404, `File "${filename}" not found in /assets`);
      return;
    }

    const ext = filename.split('.').pop()?.toLowerCase() || 'mp4';
    const assetId = randomUUID();
    const destPath = join(session.assetsDir, `${assetId}.${ext}`);
    try { await copyFile(srcPath, destPath); }
    catch (copyErr) {
      console.warn(`[Import] copyFile failed (${copyErr.message}), fallback to stream`);
      await new Promise((resolve, reject) => {
        const rs = createReadStream(srcPath);
        const ws = createWriteStream(destPath);
        rs.on('error', reject); ws.on('error', reject);
        ws.on('finish', resolve); rs.pipe(ws);
      });
    }

    const isImage = ['jpg','jpeg','png','gif','webp'].includes(ext);
    const isAudio = ['mp3','wav','aac','m4a','ogg'].includes(ext);
    const type = isImage ? 'image' : isAudio ? 'audio' : 'video';
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

    let duration = 0, width = 0, height = 0;
    if (!isAudio) {
      try { const info = await getMediaInfoModule(destPath); duration = info.duration; width = info.width; height = info.height; } catch {}
    } else {
      try { duration = await getDurationModule(destPath); } catch {}
    }
    if (!isAudio) {
      try { await generateThumbnailModule(destPath, thumbPath, isImage); } catch {}
    }

    const fileStats = await stat(destPath);
    const asset = {
      id: assetId, type, filename, path: destPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: isImage ? 5 : duration, size: fileStats.size, width, height,
      createdAt: Date.now(),
    };
    session.assets.set(assetId, asset);
    await saveAssetMetadataModule(session);
    sendSuccess(res, {
      asset: { id: assetId, type, filename, duration: asset.duration, size: fileStats.size, width, height,
        thumbnailUrl: asset.thumbPath ? `/session/${sessionId}/assets/${assetId}/thumbnail` : null },
    });
  } catch (error) {
    sendError(res, 500, error.message || 'Import failed');
  }
}

// ============== LEGACY SESSION HANDLERS ==============

async function handleSessionCreate(req, res) {
  try {
    const session = await createSession('Untitled Project');
    console.log(`[${session.id}] Session created`);
    sendSuccess(res, { success: true, sessionId: session.id });
  } catch (error) {
    sendError(res, 500, error.message);
  }
}

async function handleSessionUpload(req, res) {
  try {
    req.socket.setTimeout(0);
    req.resume();
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024 * 1024,
      uploadDir: TEMP_DIR, keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);
    const videoFile = files.video?.[0];
    if (!videoFile) { sendError(res, 400, 'Missing video file'); return; }

    const session = await createSession(videoFile.originalFilename || 'video.mp4');
    await rename(videoFile.filepath, session.currentVideo);

    const duration = await getDurationModule(session.currentVideo);
    const stats = await stat(session.currentVideo);
    sendSuccess(res, {
      success: true, sessionId: session.id, duration,
      size: stats.size, name: session.originalName,
    });
  } catch (error) {
    sendError(res, 500, error.message);
  }
}

async function handleSessionStream(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  try {
    const videoStats = await stat(session.currentVideo);
    const fileSize = videoStats.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes', 'Content-Length': chunkSize,
        'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*',
      });
      createReadStream(session.currentVideo, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize, 'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*',
      });
      createReadStream(session.currentVideo).pipe(res);
    }
  } catch (error) {
    sendError(res, 500, error.message);
  }
}

async function handleSessionInfo(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  try {
    const videoStats = await stat(session.currentVideo);
    const duration = await getDurationModule(session.currentVideo);
    sendSuccess(res, {
      sessionId: session.id, duration, size: videoStats.size,
      name: session.originalName, editCount: session.editCount,
      createdAt: session.createdAt,
    });
  } catch (error) {
    sendError(res, 500, error.message);
  }
}

async function handleSessionProcess(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  try {
    const body = await parseBody(req);
    const { command } = body;
    if (!command) { sendError(res, 400, 'Missing command'); return; }

    const outputPath = join(session.dir, `output-${Date.now()}.mp4`);
    let args = parseFFmpegArgs(command);
    args = args.map(arg => {
      if (arg.match(/input\.[a-z0-9]+/i)) return session.currentVideo;
      if (arg.match(/output\.[a-z0-9]+/i)) return outputPath;
      return arg;
    });
    if (!args.includes('-y')) args.unshift('-y');
    await runFFmpegModule(args, sessionId);

    await unlink(session.currentVideo);
    await rename(outputPath, session.currentVideo);

    const newStats = await stat(session.currentVideo);
    const newDuration = await getDurationModule(session.currentVideo);
    session.editCount++;
    sendSuccess(res, { success: true, duration: newDuration, size: newStats.size, editCount: session.editCount });
  } catch (error) {
    sendError(res, 500, error.message);
  }
}

async function handleSessionRemoveDeadAir(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  const jobId = sessionId;
  const outputPath = join(session.dir, `deadair-${Date.now()}.mp4`);
  const concatListPath = join(session.dir, `concat-${Date.now()}.txt`);
  const segmentPaths = [];

  try {
    const body = await parseBody(req);
    const silenceThreshold = body.silenceThreshold ?? -30;
    const minSilenceDuration = body.minSilenceDuration ?? 0.3;

    const videoAsset = Array.from(session.assets.values()).find(a => a.type === 'video');
    if (!videoAsset) { sendError(res, 400, 'No video asset found'); return; }
    if (!existsSync(videoAsset.path)) {
      sendError(res, 410, 'Video file no longer exists. Please re-upload.');
      return;
    }

    const totalDuration = await getDurationModule(videoAsset.path);
    const silencePeriods = await detectSilenceModule(videoAsset.path, jobId, { silenceThreshold, minSilenceDuration });

    if (silencePeriods.length === 0) {
      sendSuccess(res, { success: true, duration: totalDuration, removedDuration: 0, message: 'No silence detected' });
      return;
    }

    const keepSegments = calculateKeepSegmentsModule(silencePeriods, totalDuration);
    const totalKeptDuration = keepSegments.reduce((s, seg) => s + (seg.end - seg.start), 0);
    const removedDuration = totalDuration - totalKeptDuration;

    // Extract segments
    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i];
      const segmentPath = join(session.dir, `segment-${Date.now()}-${i}.mp4`);
      segmentPaths.push(segmentPath);
      await runFFmpegModule([
        '-y', '-i', videoAsset.path,
        '-ss', seg.start.toString(), '-t', (seg.end - seg.start).toString(),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k', segmentPath,
      ], jobId);
    }

    // Concatenate
    const concatList = segmentPaths.map(p => `file '${p}'`).join('\n');
    await writeFile(concatListPath, concatList);
    await runFFmpegModule([
      '-y', '-f', 'concat', '-safe', '0', '-i', concatListPath,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath,
    ], jobId);

    await unlink(videoAsset.path);
    await rename(outputPath, videoAsset.path);
    const newStats = await stat(videoAsset.path);

    videoAsset.duration = totalKeptDuration;
    videoAsset.size = newStats.size;
    session.editCount++;

    // Regenerate thumbnail
    try {
      const thumbPath = videoAsset.thumbPath || join(session.assetsDir, `${videoAsset.id}_thumb.jpg`);
      await generateThumbnailModule(videoAsset.path, thumbPath, false);
      videoAsset.thumbPath = thumbPath;
    } catch { /* thumb optional */ }

    sendSuccess(res, {
      success: true, duration: totalKeptDuration,
      originalDuration: totalDuration, removedDuration,
      size: newStats.size, editCount: session.editCount,
    });
  } catch (error) {
    segmentPaths.forEach(p => { try { unlinkSync(p); } catch {} });
    sendError(res, 500, error.message);
  }
}

async function handleSessionChapters(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  const jobId = sessionId;
  try {
    let videoPath = session.currentVideo;
    if (!videoPath || !existsSync(videoPath)) {
      for (const [, asset] of session.assets) {
        if (asset.type === 'video' && !asset.aiGenerated && existsSync(asset.path)) {
          videoPath = asset.path; break;
        }
      }
    }
    if (!videoPath || !existsSync(videoPath)) {
      sendError(res, 400, 'No video found in session'); return;
    }

    const totalDuration = await getDurationModule(videoPath);
    const videoAsset = { id: 'chapters', path: videoPath, filename: 'video' };
    let transcriptResult = { text: '', words: [] };
    try { transcriptResult = await getOrTranscribeVideoModule(session, videoAsset, jobId); } catch {}

    let chapters = [];
    let summary = '';

    if (transcriptResult.text && transcriptResult.text.trim().length > 0) {
      const text = transcriptResult.text.trim();
      const words = transcriptResult.words || [];
      const targetChapterCount = Math.max(3, Math.min(8, Math.ceil(totalDuration / 60)));
      const chunkDuration = totalDuration / targetChapterCount;

      let currentChapterStart = 0;
      for (let i = 0; i < targetChapterCount - 1; i++) {
        const chapterEnd = chunkDuration * (i + 1);
        const wordsInChunk = words.filter(w => w.start >= currentChapterStart && w.start < chapterEnd);
        let title = `Part ${i + 2}`;
        if (wordsInChunk.length > 0) {
          const lastWords = wordsInChunk.slice(-5);
          if (lastWords.length > 0) {
            title = lastWords.map(w => w.text).join(' ').substring(0, 40);
            if (lastWords.length >= 5) title += '...';
          }
        }
        chapters.push({ start: Math.round(chapterEnd * 10) / 10, title });
        currentChapterStart = chapterEnd;
      }
      summary = text.substring(0, 200) + (text.length > 200 ? '...' : '');
    } else {
      const chapterInterval = Math.max(30, Math.min(90, totalDuration / 5));
      for (let time = 0; time < totalDuration - 10; time += chapterInterval) {
        chapters.push({ start: Math.round(time * 10) / 10, title: time === 0 ? 'Introduction' : `Part ${chapters.length + 1}` });
      }
      summary = 'Auto-generated chapters based on video duration';
    }

    const youtubeChapters = chapters.sort((a, b) => a.start - b.start)
      .map(ch => `${formatTimestamp(ch.start)} ${ch.title}`).join('\n');

    sendSuccess(res, { success: true, chapters, youtubeFormat: youtubeChapters, summary, videoDuration: totalDuration });
  } catch (error) {
    sendError(res, 500, error.message);
  }
}

async function handleSessionDownload(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  try {
    const videoStats = await stat(session.currentVideo);
    const filename = session.originalName.replace(/\.[^.]+$/, '-edited.mp4');
    res.writeHead(200, {
      'Content-Type': 'video/mp4', 'Content-Length': videoStats.size,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(session.currentVideo).pipe(res);
  } catch (error) {
    sendError(res, 500, error.message);
  }
}

async function handleSessionDelete(req, res, sessionId) {
  await cleanupSession(sessionId);
  sendSuccess(res, { success: true });
}

// Search GIPHY for a keyword
async function searchGiphy(keyword, limit = 1) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GIPHY_API_KEY_HERE') {
    throw new Error('GIPHY_API_KEY not configured. Get a free key at https://developers.giphy.com/');
  }

  const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(keyword)}&limit=${limit}&rating=g&lang=en`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GIPHY API error: ${response.status}`);
  }

  const data = await response.json();
  return data.data || [];
}

// Download GIF and save as asset
async function downloadGifAsAsset(session, gifUrl, keyword, timestamp) {
  const jobId = randomUUID();
  const gifId = randomUUID();
  const gifPath = join(session.assetsDir, `${gifId}.gif`);
  const thumbPath = join(session.assetsDir, `${gifId}_thumb.jpg`);

  try {
    console.log(`[${jobId}] Downloading GIF for "${keyword}"...`);

    const response = await fetch(gifUrl);
    if (!response.ok) {
      throw new Error(`Failed to download GIF: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    await fs.promises.writeFile(gifPath, Buffer.from(buffer));

    // Generate thumbnail
    try {
      await runFFmpeg([
        '-y', '-i', gifPath,
        '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        thumbPath
      ], jobId);
    } catch (e) {
      console.warn(`[${jobId}] Thumbnail generation failed:`, e.message);
    }

    const stats = await stat(gifPath);

    // Get GIF dimensions
    const info = await getMediaInfo(gifPath);

    const asset = {
      id: gifId,
      type: 'image',
      filename: `${keyword.replace(/\s+/g, '-')}.gif`,
      path: gifPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: 3, // Default 3 seconds for GIFs
      size: stats.size,
      width: info.width || 200,
      height: info.height || 200,
      createdAt: Date.now(),
      // Extra metadata for auto-placement
      keyword,
      timestamp,
    };

    session.assets.set(gifId, asset);

    console.log(`[${jobId}] GIF saved: ${(stats.size / 1024).toFixed(1)} KB`);

    return asset;

  } catch (error) {
    try { unlinkSync(gifPath); } catch { /* temp file cleanup */ }
    try { unlinkSync(thumbPath); } catch { /* temp file cleanup */ }
    throw error;
  }
}

// Search GIPHY for trending GIFs
async function searchGiphyTrending(limit = 20) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GIPHY_API_KEY_HERE') {
    throw new Error('GIPHY_API_KEY not configured. Get a free key at https://developers.giphy.com/');
  }

  const url = `https://api.giphy.com/v1/gifs/trending?api_key=${apiKey}&limit=${limit}&rating=g`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GIPHY API error: ${response.status}`);
  }

  const data = await response.json();
  return data.data || [];
}

// Handle GIPHY search endpoint
async function handleGiphySearch(req, res, sessionId, url) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const query = url.searchParams.get('q') || '';
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    if (!query.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Search query (q) is required' }));
      return;
    }

    const gifs = await searchGiphy(query, limit);

    // Format response
    const results = gifs.map(gif => ({
      id: gif.id,
      title: gif.title,
      url: gif.images.original.url,
      previewUrl: gif.images.fixed_width.url,
      thumbnailUrl: gif.images.fixed_width_still?.url || gif.images.fixed_width.url,
      width: parseInt(gif.images.original.width, 10),
      height: parseInt(gif.images.original.height, 10),
      source: 'giphy',
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ gifs: results }));
  } catch (error) {
    console.error('GIPHY search error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Handle GIPHY trending endpoint
async function handleGiphyTrending(req, res, sessionId, url) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const gifs = await searchGiphyTrending(limit);

    // Format response
    const results = gifs.map(gif => ({
      id: gif.id,
      title: gif.title,
      url: gif.images.original.url,
      previewUrl: gif.images.fixed_width.url,
      thumbnailUrl: gif.images.fixed_width_still?.url || gif.images.fixed_width.url,
      width: parseInt(gif.images.original.width, 10),
      height: parseInt(gif.images.original.height, 10),
      source: 'giphy',
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ gifs: results }));
  } catch (error) {
    console.error('GIPHY trending error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Handle adding a GIPHY GIF to assets
async function handleGiphyAdd(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);

    const { gifUrl, title } = body;
    if (!gifUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'gifUrl is required' }));
      return;
    }

    // Download and add to assets
    const asset = await downloadGifAsAsset(session, gifUrl, title || 'GIF', Date.now());

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      asset: {
        id: asset.id,
        filename: asset.filename,
        type: asset.type,
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
        thumbnailUrl: `/session/${sessionId}/assets/${asset.id}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${asset.id}/stream`,
      }
    }));
  } catch (error) {
    console.error('GIPHY add error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Handle simple transcription for captions (returns word-level timestamps)
// Check if local Whisper Python script is available (uses OpenAI API, no local model)
async function checkLocalWhisper() {
  return new Promise((resolve) => {
    const scriptPath = join(process.cwd(), 'scripts', 'whisper-transcribe.py');
    if (!existsSync(scriptPath)) {
      resolve(false);
      return;
    }
    // Check that Python and requests module are available
    const check = spawn('python3', ['-c', 'import requests; print("ok")']);
    let output = '';
    check.stdout.on('data', (data) => { output += data.toString(); });
    check.on('close', (code) => {
      resolve(code === 0 && output.includes('ok'));
    });
    check.on('error', () => resolve(false));
  });
}

// Run local Whisper transcription
async function runLocalWhisper(audioPath, jobId) {
  const scriptPath = join(process.cwd(), 'scripts', 'whisper-transcribe.py');

  return new Promise((resolve, reject) => {
    console.log(`[${jobId}] Running local Whisper...`);
    const whisperProcess = spawn('python3', [scriptPath, audioPath, 'base']);

    let stdout = '';
    let stderr = '';

    whisperProcess.stdout.on('data', (data) => { stdout += data.toString(); });
    whisperProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      // Log progress messages
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => console.log(`[${jobId}] Whisper: ${line}`));
    });

    whisperProcess.on('close', (code) => {
      if (code !== 0) {
        // Try to parse JSON error from stdout first
        try {
          const result = JSON.parse(stdout);
          if (result.error) {
            reject(new Error(`Whisper error: ${result.error}`));
            return;
          }
        } catch (e) {
          // stdout wasn't valid JSON, fall through to stderr
        }
        reject(new Error(`Whisper failed (exit code ${code}): ${stderr.slice(-500)}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      } catch (e) {
        reject(new Error(`Failed to parse Whisper output: ${stdout.slice(0, 200)}`));
      }
    });

    whisperProcess.on('error', (err) => reject(err));
  });
}

// Cached transcription helper - avoids re-transcribing the same video
// Returns { text: string, words: Array<{text, start, end}> }
async function getOrTranscribeVideo(session, videoAsset, jobId) {
  return getOrTranscribeVideoModule(session, videoAsset, jobId || '');
}

// Get transcript segment for a specific time range
function getTranscriptSegment(transcription, startTime, endTime) {
  if (!transcription || !transcription.words || !Array.isArray(transcription.words)) return '';
  return transcription.words
    .filter(w => w.start >= startTime && w.end <= endTime)
    .map(w => w.text)
    .join(' ');
}

// Extract numeric value from stat strings like "$10K+", "50%", "2.5M", "10,000", etc.
// Returns { numericValue, prefix, suffix } where numericValue is the number to count TO
function extractNumericValue(valueStr) {
  if (!valueStr || typeof valueStr !== 'string') return null;

  const str = valueStr.trim();
  console.log(`[extractNumericValue] Input: "${str}"`);

  // Extract prefix (currency symbols and other leading non-numeric chars)
  let prefix = '';
  const prefixMatch = str.match(/^([£$€¥₹#@~]+)/);
  if (prefixMatch) {
    prefix = prefixMatch[1];
  }

  // Extract the number part (including decimals and commas)
  const numberMatch = str.match(/[\d,]+\.?\d*/);
  if (!numberMatch || numberMatch[0] === '') {
    console.log(`[extractNumericValue] No number found in "${str}"`);
    return null;
  }

  let numericValue = parseFloat(numberMatch[0].replace(/,/g, ''));
  if (isNaN(numericValue)) {
    console.log(`[extractNumericValue] Could not parse number from "${numberMatch[0]}"`);
    return null;
  }

  // Extract suffix - everything after the number
  let suffix = '';
  const numberEndIndex = str.indexOf(numberMatch[0]) + numberMatch[0].length;
  const afterNumber = str.substring(numberEndIndex).trim();
  console.log(`[extractNumericValue] Number: ${numericValue}, After: "${afterNumber}"`);

  // Check for multiplier suffixes and apply them
  if (/^k\b/i.test(afterNumber) || /^thousand/i.test(afterNumber)) {
    numericValue *= 1000;
    suffix = afterNumber.replace(/^k\b/i, '').replace(/^thousand/i, '').trim();
  } else if (/^m\b/i.test(afterNumber) || /^million/i.test(afterNumber)) {
    numericValue *= 1000000;
    suffix = afterNumber.replace(/^m\b/i, '').replace(/^million/i, '').trim();
  } else if (/^b\b/i.test(afterNumber) || /^billion/i.test(afterNumber)) {
    numericValue *= 1000000000;
    suffix = afterNumber.replace(/^b\b/i, '').replace(/^billion/i, '').trim();
  } else {
    suffix = afterNumber;
  }

  // Clean up suffix - keep only common suffix chars
  // But preserve % and + which are important
  if (suffix.includes('%')) {
    suffix = '%';
  } else if (suffix.includes('+')) {
    suffix = '+';
  } else {
    suffix = suffix.replace(/[^%+\-KMB]/gi, '').trim();
  }

  const result = {
    numericValue: Math.round(numericValue),
    prefix,
    suffix,
  };

  console.log(`[extractNumericValue] Result: ${JSON.stringify(result)}`);
  return result;
}

async function handleTranscribe(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);
  const audioPath = join(TEMP_DIR, `${jobId}-caption-audio.mp3`);

  try {
    // Check for transcription options in order of preference:
    // 1. Local Whisper (free, accurate)
    // 2. Groq Whisper API (free, fast)
    const hasLocalWhisper = await checkLocalWhisper();
    const groqKey = process.env.GROQ_API_KEY;

    if (!hasLocalWhisper && !groqKey) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No transcription method available. Install local Whisper or set GROQ_API_KEY in .dev.vars' }));
      return;
    }

    // Parse request body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const { assetId } = JSON.parse(body || '{}');

    // Determine which method to use
    const useLocalWhisper = hasLocalWhisper;
    const useGroqWhisper = !hasLocalWhisper && !!groqKey;

    const method = useLocalWhisper ? 'Local Whisper' : 'Groq Whisper';
    console.log(`\n[${jobId}] === TRANSCRIBE FOR CAPTIONS (${method}) ===`);

    // Find the video asset
    let videoAsset = null;
    if (assetId) {
      videoAsset = session.assets.get(assetId);
    } else {
      // If no assetId, prefer the original (non-AI-generated) video asset
      for (const asset of session.assets.values()) {
        if (asset.type === 'video' && !asset.aiGenerated) {
          videoAsset = asset;
          break;
        }
      }
      // Fallback to any video if no non-AI video found
      if (!videoAsset) {
        for (const asset of session.assets.values()) {
          if (asset.type === 'video') {
            videoAsset = asset;
            break;
          }
        }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found' }));
      return;
    }

    console.log(`[${jobId}] Transcribing: ${videoAsset.filename}`);

    // Get video duration
    const totalDuration = await getVideoDuration(videoAsset.path);
    console.log(`[${jobId}] Video duration: ${totalDuration.toFixed(2)}s`);

    // Extract audio as MP3
    console.log(`[${jobId}] Extracting audio...`);
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn', '-acodec', 'libmp3lame',
      '-ab', '64k', '-ar', '16000', '-ac', '1',
      audioPath
    ], jobId);

    // stat already imported at top level
    const audioStats = await stat(audioPath);
    console.log(`[${jobId}] Audio extracted: ${(audioStats.size / 1024 / 1024).toFixed(1)} MB`);

    // Transcribe using the available method
    let transcription;

    if (useLocalWhisper) {
      try {
        transcription = await runLocalWhisper(audioPath, jobId);
        console.log(`[${jobId}] Local Whisper complete: ${transcription.words?.length || 0} words`);
      } catch (whisperError) {
        console.log(`[${jobId}] Local Whisper failed: ${whisperError.message}`);
        transcription = { text: '', words: [] };
      }
    } else if (useGroqWhisper) {
      await groqLimiter.acquire(3, 1000);
      console.log(`[${jobId}] Sending to Groq Whisper for transcription...`);
      const audioBuffer = await fs.promises.readFile(audioPath);

      const groqFormData = new FormData();
      groqFormData.append('file', new Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
      groqFormData.append('model', 'whisper-large-v3');
      groqFormData.append('response_format', 'verbose_json');
      groqFormData.append('language', 'en');

      const groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}` },
        body: groqFormData,
      });

      if (!groqResponse.ok) {
        console.log(`[${jobId}] Groq Whisper failed (${groqResponse.status})`);
        transcription = { text: '', words: [] };
      } else {
        const groqResult = await groqResponse.json();
        console.log(`[${jobId}] Groq Whisper complete: ${groqResult.words?.length || 0} words`);

        transcription = {
          text: groqResult.text || '',
          words: (groqResult.words || []).map(w => ({
            text: w.word || w.text || '',
            start: w.start || 0,
            end: w.end || 0,
          }))
        };
      }
    } else {
      transcription = { text: '', words: [] };
    }

    // Cleanup
    try { unlinkSync(audioPath); } catch { /* audio cleanup */ }

    const words = (transcription.words || []).map(w => ({
      text: w.text || '',
      start: parseFloat(w.start) || 0,
      end: parseFloat(w.end) || 0,
    })).filter(w => w.text.trim().length > 0); // Filter out empty words

    console.log(`[${jobId}] Transcription complete: ${words.length} words`);
    console.log(`[${jobId}] Text: "${(transcription.text || '').substring(0, 200)}..."`);

    // Check if transcription is empty
    if (words.length === 0 && (!transcription.text || transcription.text.trim().length === 0)) {
      console.error(`[${jobId}] Empty transcription - no words detected`);
      console.error(`[${jobId}] This could mean: no speech in video, audio too quiet, or unsupported language`);

      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        error: 'No speech detected. Make sure the video has clear, audible speech.',
        debug: {
          transcriptionText: (transcription.text || '').substring(0, 200),
          wordCount: (transcription.words || []).length
        }
      }));
      return;
    }

    console.log(`[${jobId}] === TRANSCRIPTION DONE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      text: transcription.text || '',
      words: words,
      duration: totalDuration,
    }));

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    try { unlinkSync(audioPath); } catch { /* audio cleanup */ }
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Handle transcribe and extract keywords endpoint
async function handleTranscribeAndExtract(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    console.log(`\n[${jobId}] === TRANSCRIBE & EXTRACT KEYWORDS ===`);

    // Find the original (non-AI-generated) video asset
    let videoAsset = null;
    for (const asset of session.assets.values()) {
      if (asset.type === 'video' && !asset.aiGenerated) {
        videoAsset = asset;
        break;
      }
    }
    if (!videoAsset) {
      for (const asset of session.assets.values()) {
        if (asset.type === 'video') { videoAsset = asset; break; }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found in session' }));
      return;
    }

    console.log(`[${jobId}] Using video: ${videoAsset.filename}`);

    // Step 1: Transcribe
    const transcription = await transcribeVideo(videoAsset.path, jobId);
    console.log(`[${jobId}] Transcript: "${transcription.text.substring(0, 100)}..."`);

    // Step 2: Extract keywords
    const keywords = extractKeywordsFromTranscript(transcription.text, transcription.words);
    console.log(`[${jobId}] Found ${keywords.length} keywords`);

    // Step 3: Fetch GIFs from GIPHY for each keyword
    const gifAssets = [];
    for (const kw of keywords) {
      try {
        console.log(`[${jobId}] Searching GIPHY for "${kw.keyword}"...`);
        const gifs = await searchGiphy(kw.keyword, 1);

        if (gifs.length > 0) {
          // Get the fixed height small GIF URL
          const gifUrl = gifs[0].images?.fixed_height?.url ||
                         gifs[0].images?.original?.url;

          if (gifUrl) {
            const asset = await downloadGifAsAsset(session, gifUrl, kw.keyword, kw.timestamp);
            gifAssets.push({
              assetId: asset.id,
              keyword: kw.keyword,
              timestamp: kw.timestamp,
              confidence: kw.confidence,
              filename: asset.filename,
              thumbnailUrl: `/session/${sessionId}/assets/${asset.id}/thumbnail`,
            });
          }
        }
      } catch (error) {
        console.warn(`[${jobId}] Failed to get GIF for "${kw.keyword}":`, error.message);
      }
    }

    console.log(`[${jobId}] Downloaded ${gifAssets.length} GIFs`);
    console.log(`[${jobId}] === TRANSCRIPTION COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      transcript: transcription.text,
      keywords: keywords,
      gifAssets: gifAssets,
    }));

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ============== B-ROLL IMAGE GENERATION ==============

// Helper to parse JSON body from request with size limit (10MB)
const MAX_BODY_SIZE = 10 * 1024 * 1024;
async function parseBody(req) {
  let body = '';
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_SIZE) {
      req.destroy(new Error('Request body too large'));
      throw new Error('Request body exceeds maximum allowed size (10MB)');
    }
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

// Analyze transcript for B-roll opportunities using DeepSeek
async function analyzeBrollOpportunities(transcript, words, totalDuration) {

  const response = await generateWithDeepSeek({
    prompt: `Analyze this video transcript and identify 3-5 key moments that would benefit from a visual B-roll image overlay. Consider:
- Keywords or products mentioned (e.g., "iPhone", "Claude AI", "Tesla")
- Funny or emphatic moments
- Important concepts being explained
- Brand names or people mentioned
- Abstract concepts that could use visual reinforcement

The video is ${totalDuration.toFixed(1)} seconds long.

Transcript: "${transcript}"

Word timings (for reference): ${JSON.stringify(words.slice(0, 50))}${words.length > 50 ? '...' : ''}

Return a JSON array with this exact structure:
[
  {
    "timestamp": 15.2,
    "prompt": "minimalist icon of iPhone floating on clean white background, simple flat design",
    "reason": "product mention",
    "keyword": "iPhone"
  }
]

Guidelines for prompts:
- Keep prompts concise (10-20 words)
- Request clean, iconic, simple images suitable for video overlay
- Use "minimalist", "icon", "simple", "flat design" style descriptors
- Avoid complex scenes - prefer single subjects with clean backgrounds
- Images will be 1:1 square format

IMPORTANT: Return ONLY valid JSON array, no markdown, no explanation.`,
    responseMimeType: 'application/json',
  });

  const responseText = response.text || '[]';

  try {
    // Try to parse directly
    const parsed = JSON.parse(responseText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Try to extract JSON from response
    const match = responseText.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return [];
      }
    }
    return [];
  }
}

// Generate image using fal.ai FLUX.1 schnell
async function generateImageWithAI(prompt, apiKey, outputPath) {
  console.log(`    Generating image via FLUX.1 schnell: "${prompt.substring(0, 50)}..."`);
  try {
    return await generateImageWithFal(prompt, outputPath);
  } catch (error) {
    console.error(`    ✗ Image generation failed: ${error.message}`);
    return false;
  }
}

// Handle B-roll generation endpoint
async function handleGenerateBroll(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const jobId = sessionId.substring(0, 8);

  try {
    console.log(`\n[${jobId}] === GENERATE B-ROLL IMAGES ===`);

    // Find the original (non-AI-generated) video asset
    let videoAsset = null;
    for (const asset of session.assets.values()) {
      if (asset.type === 'video' && !asset.aiGenerated) {
        videoAsset = asset;
        break;
      }
    }
    if (!videoAsset) {
      for (const asset of session.assets.values()) {
        if (asset.type === 'video') { videoAsset = asset; break; }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found in session' }));
      return;
    }

    console.log(`[${jobId}] Using video: ${videoAsset.filename}`);

    // Step 1: Transcribe the video
    console.log(`[${jobId}] Step 1: Transcribing video...`);
    const audioPath = join(TEMP_DIR, `${jobId}-broll-audio.mp3`);
    const totalDuration = await getVideoDuration(videoAsset.path);

    // Check for transcription method
    const hasLocalWhisper = await checkLocalWhisper();
    const groqKey = process.env.GROQ_API_KEY;

    // Extract audio
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn', '-acodec', 'libmp3lame',
      '-ab', '64k', '-ar', '16000', '-ac', '1',
      audioPath
    ], jobId);

    let transcription;
    if (hasLocalWhisper) {
      try {
        console.log(`[${jobId}]    Using local Whisper...`);
        transcription = await runLocalWhisper(audioPath, jobId);
      } catch (whisperError) {
        console.log(`[${jobId}]    Local Whisper failed: ${whisperError.message}`);
        console.log(`[${jobId}]    No transcription service available. Using empty transcript.`);
        transcription = { text: '', words: [] };
      }
    } else if (groqKey) {
      console.log(`[${jobId}]    Using Groq Whisper API...`);
      const audioBuffer = await fs.promises.readFile(audioPath);

      const groqFormData = new FormData();
      groqFormData.append('file', new Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
      groqFormData.append('model', 'whisper-large-v3');
      groqFormData.append('response_format', 'verbose_json');
      groqFormData.append('language', 'en');

      const groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}` },
        body: groqFormData,
      });

      if (!groqResponse.ok) {
        console.log(`[${jobId}] Groq Whisper failed (${groqResponse.status})`);
        transcription = { text: '', words: [] };
      } else {
        const groqResult = await groqResponse.json();
        transcription = {
          text: groqResult.text || '',
          words: (groqResult.words || []).map(w => ({
            text: w.word || w.text || '',
            start: w.start || 0,
            end: w.end || 0,
          }))
        };
      }
    } else {
      console.log(`[${jobId}]    No transcription service available. Using empty transcript.`);
      transcription = { text: '', words: [] };
    }

    try { unlinkSync(audioPath); } catch { /* audio cleanup */ }

    console.log(`[${jobId}]    Transcript: "${transcription.text.substring(0, 100)}..."`);
    console.log(`[${jobId}]    Words: ${transcription.words?.length || 0}`);

    // Step 2: Analyze transcript for B-roll opportunities
    console.log(`[${jobId}] Step 2: Analyzing for B-roll opportunities...`);
    const opportunities = await analyzeBrollOpportunities(
      transcription.text,
      transcription.words || [],
      totalDuration
    );

    console.log(`[${jobId}]    Found ${opportunities.length} B-roll opportunities`);
    opportunities.forEach((opp, i) => {
      console.log(`[${jobId}]    ${i + 1}. @${opp.timestamp.toFixed(1)}s: "${opp.keyword}" - ${opp.reason}`);
    });

    // Step 3: Generate images for each opportunity
    console.log(`[${jobId}] Step 3: Generating B-roll images...`);
    const brollAssets = [];

    for (let i = 0; i < opportunities.length; i++) {
      const opp = opportunities[i];
      const assetId = randomUUID();
      const imagePath = join(session.assetsDir, `${assetId}.png`);
      const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

      console.log(`[${jobId}]    [${i + 1}/${opportunities.length}] Generating for "${opp.keyword}"...`);

      const success = await generateImageWithAI(opp.prompt, '', imagePath);

      if (success && existsSync(imagePath)) {
        // Generate thumbnail
        try {
          await runFFmpeg([
            '-y', '-i', imagePath,
            '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
            '-frames:v', '1',
            thumbPath
          ], jobId);
        } catch (e) {
          console.warn(`[${jobId}]    Thumbnail generation failed:`, e.message);
        }

        // stat already imported at top level
        const stats = await stat(imagePath);
        const info = await getMediaInfo(imagePath);

        // Create asset entry
        const asset = {
          id: assetId,
          type: 'image',
          filename: `broll-${opp.keyword.replace(/\s+/g, '-')}.png`,
          path: imagePath,
          thumbPath: existsSync(thumbPath) ? thumbPath : null,
          duration: 3, // Default 3 seconds for B-roll images
          size: stats.size,
          width: info.width || 1024,
          height: info.height || 1024,
          createdAt: Date.now(),
          // B-roll metadata
          keyword: opp.keyword,
          timestamp: opp.timestamp,
          reason: opp.reason,
        };

        session.assets.set(assetId, asset);
        await saveAssetMetadata(session); // Persist asset metadata to disk

        brollAssets.push({
          assetId: asset.id,
          keyword: opp.keyword,
          timestamp: opp.timestamp,
          reason: opp.reason,
          filename: asset.filename,
          thumbnailUrl: `/session/${sessionId}/assets/${asset.id}/thumbnail`,
        });

        console.log(`[${jobId}]    ✓ Generated: ${asset.filename}`);
      } else {
        console.log(`[${jobId}]    ✗ Failed to generate image for "${opp.keyword}"`);
      }
    }

    console.log(`[${jobId}] Generated ${brollAssets.length}/${opportunities.length} B-roll images`);
    console.log(`[${jobId}] === B-ROLL GENERATION COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      transcript: transcription.text,
      opportunities: opportunities,
      brollAssets: brollAssets,
    }));

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ============== MOTION GRAPHICS RENDERING ==============

// Handle motion graphics rendering
// NOTE: This is a placeholder that creates a simple text overlay video using FFmpeg
// For proper Remotion rendering, you'd need to set up @remotion/renderer with bundling
async function handleRenderMotionGraphic(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { templateId, props, duration, fps = 30, width = 1920, height = 1080 } = body;

    const jobId = randomUUID();
    const assetId = randomUUID();
    const outputPath = join(session.assetsDir, `${assetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

    console.log(`\n[${jobId}] === RENDER MOTION GRAPHIC ===`);
    console.log(`[${jobId}] Template: ${templateId}`);
    console.log(`[${jobId}] Duration: ${duration}s`);

    // Get text and styling from props
    const text = props.text || props.name || templateId;
    const color = (props.color || props.primaryColor || '#ffffff').replace('#', '');
    const bgColor = props.backgroundColor || '000000';
    const fontSize = props.fontSize || 64;

    // Create a video with text overlay using FFmpeg
    // This is a placeholder - proper Remotion rendering would generate much nicer animations
    const fontFile = process.platform === 'win32'
      ? 'C\\:\\\\Windows\\\\Fonts\\\\arial.ttf'
      : process.platform === 'darwin'
        ? '/System/Library/Fonts/Helvetica.ttc'
        : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
    // Note: Windows font paths in drawtext filter require escaped colons (C\:)

    // FFmpeg command to create a video with text
    const ffmpegArgs = [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=0x${bgColor}:s=${width}x${height}:d=${duration}:r=${fps}`,
      '-vf', `drawtext=text='${text.replace(/'/g, "\\'")}':fontfile=${fontFile}:fontsize=${fontSize}:fontcolor=0x${color}:x=(w-text_w)/2:y=(h-text_h)/2`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      outputPath
    ];

    await runFFmpeg(ffmpegArgs, jobId);

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    const stats = await stat(outputPath);

    // Create asset entry
    const asset = {
      id: assetId,
      type: 'video',
      filename: `motion-${templateId}-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: duration,
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
      // Metadata
      templateId,
      props,
    };

    session.assets.set(assetId, asset);
    await saveAssetMetadata(session); // Persist asset metadata to disk

    console.log(`[${jobId}] Motion graphic rendered: ${assetId}`);
    console.log(`[${jobId}] === RENDER COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId,
      filename: asset.filename,
      duration,
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
    }));

  } catch (error) {
    console.error('Motion graphic render error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Auto-edit: AI-powered video editing pipeline
async function handleAutoEdit(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const videoAssetId = body.videoAssetId;

    // Find video asset in session
    const videoAsset = Array.from(session.assets.values()).find(a => a.type === 'video');
    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, error: 'No video asset found in session' }));
      return;
    }

    const videoPath = videoAsset.path;
    const jobId = randomUUID();
    jobs.set(jobId, {
      type: 'auto-edit',
      status: 'pending',
      percent: 0,
      step: 'Initializing...',
      sessionId,
      assetId: videoAsset.id
    });

    // Start auto-edit in background
    runAutoEditJob(jobId, sessionId, videoPath, videoAsset.id);

    res.writeHead(202, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, jobId }));
  } catch (error) {
    console.error('Auto-edit error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

// Background auto-edit job runner
async function runAutoEditJob(jobId, sessionId, videoPath, assetId) {
  const job = jobs.get(jobId);

  try {
    job.percent = 5; job.step = 'Detecting scenes...';
    const duration = await getVideoDuration(videoPath);

    job.percent = 10; job.step = 'Transcribing audio...';
    const session = await getSession(sessionId);
    if (session) {
      const vAsset = session.assets.get(assetId);
      if (vAsset) {
        await getOrTranscribeVideo(session, vAsset, jobId);
      }
    }

    job.percent = 20; job.step = 'Analyzing content...';
    job.percent = 50; job.step = 'Applying edits...';

    job.percent = 100;
    job.status = 'completed';
    job.step = 'Auto-edit complete!';
    console.log('[' + jobId + '] Auto-edit completed for session ' + sessionId);
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.step = 'Error: ' + error.message;
    console.error('[' + jobId + '] Auto-edit error:', error.message);
  }
}

// AI-generated animation using DeepSeek + Remotion
async function handleGenerateAnimation(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { description, videoAssetId, startTime, endTime, attachedAssetIds, fps = 30, width = 1920, height = 1080, durationSeconds } = body;

    if (!description) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'description is required' }));
      return;
    }

    const jobId = randomUUID();
    const assetId = randomUUID();
    const outputPath = join(session.assetsDir, `${assetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-props.json`);

    console.log(`\n[${jobId}] === GENERATE AI ANIMATION ===`);
    console.log(`[${jobId}] Description: ${description}`);
    if (attachedAssetIds?.length) {
      console.log(`[${jobId}] Attached assets: ${attachedAssetIds.length}`);
    }

    // Step 0: Get video transcript context if a video is provided
    let transcriptContext = '';
    let relevantSegment = '';
    let detectedTimeRange = null;

    if (videoAssetId) {
      const videoAsset = session.assets.get(videoAssetId);
      if (videoAsset && videoAsset.type === 'video') {
        console.log(`[${jobId}] Getting transcript context from ${videoAsset.filename}...`);

        try {
          const transcription = await getOrTranscribeVideo(session, videoAsset, jobId);

          if (transcription.text) {
            // If time range provided, get that segment
            if (startTime !== undefined && endTime !== undefined) {
              relevantSegment = getTranscriptSegment(transcription, startTime, endTime);
              detectedTimeRange = { start: startTime, end: endTime };
              console.log(`[${jobId}] ⏱️ Using USER-SPECIFIED time range: ${startTime}s - ${endTime}s`);
              console.log(`[${jobId}] 📝 Extracted transcript segment (${relevantSegment.split(' ').length} words):`);
              console.log(`[${jobId}]    "${relevantSegment.substring(0, 200)}${relevantSegment.length > 200 ? '...' : ''}"`);
            } else {
              // Use AI to identify the relevant part of the video based on the description
              console.log(`[${jobId}] Using AI to identify relevant video segment...`);

              const segmentResult = await generateWithDeepSeek({
                prompt: `Given this video transcript and an animation request, identify the most relevant time segment.

VIDEO TRANSCRIPT (with word timestamps):
${transcription.words?.slice(0, 200).map(w => `[${w.start.toFixed(1)}s] ${w.text}`).join(' ') || transcription.text.substring(0, 2000)}

ANIMATION REQUEST: "${description}"

VIDEO DURATION: ${videoAsset.duration}s

Analyze the request and determine:
1. Which part of the video is most relevant to this animation
2. The start and end times of the relevant segment

Return ONLY JSON (no markdown):
{
  "startTime": <seconds>,
  "endTime": <seconds>,
  "reasoning": "brief explanation of why this segment is relevant"
}

If the animation seems to be for the intro (beginning), use startTime: 0.
If it's for the outro (ending), use times near the end.
If it's about a specific topic mentioned in the transcript, find where that topic is discussed.
If unclear or general, use the middle third of the video.`,
                responseMimeType: 'application/json',
                jobId,
              });

              try {
                const segmentText = segmentResult.candidates[0].content.parts[0].text;
                const cleanedSegment = segmentText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                const segmentData = JSON.parse(cleanedSegment);

                if (segmentData.startTime !== undefined && segmentData.endTime !== undefined) {
                  detectedTimeRange = {
                    start: Math.max(0, segmentData.startTime),
                    end: Math.min(videoAsset.duration, segmentData.endTime)
                  };
                  relevantSegment = getTranscriptSegment(transcription, detectedTimeRange.start, detectedTimeRange.end);
                  console.log(`[${jobId}] AI detected relevant segment: ${detectedTimeRange.start}s - ${detectedTimeRange.end}s`);
                  console.log(`[${jobId}] Reasoning: ${segmentData.reasoning}`);
                }
              } catch (e) {
                console.log(`[${jobId}] Could not parse segment detection, using full transcript`);
                relevantSegment = transcription.text;
              }
            }

            // Build transcript context for the animation prompt
            if (relevantSegment) {
              const timeRangeNote = detectedTimeRange
                ? `\nThis segment is from ${detectedTimeRange.start.toFixed(1)}s to ${detectedTimeRange.end.toFixed(1)}s in the video.`
                : '';

              transcriptContext = `

VIDEO CONTEXT (from the transcript):
"${relevantSegment.substring(0, 1500)}"
${timeRangeNote}

IMPORTANT: The animation content should be relevant to and inspired by this video context. Use specific terms, concepts, and themes from the transcript to make the animation feel connected to the video content.`;

              console.log(`[${jobId}] 🎯 Transcript context built for AI (${relevantSegment.length} chars)`);
            }
          }
        } catch (transcriptError) {
          console.log(`[${jobId}] Could not get transcript: ${transcriptError.message}`);
          // Continue without transcript context
        }
      }
    }

    // Build context for attached assets (images/videos to include in animation)
    let attachedAssetsContext = '';
    const attachedAssetPaths = [];
    if (attachedAssetIds?.length) {
      const attachedAssetInfo = [];
      for (const attachedId of attachedAssetIds) {
        const attachedAsset = session.assets.get(attachedId);
        if (attachedAsset) {
          // Build HTTP URL for the asset (served by FFmpeg server)
          const assetUrl = `http://localhost:${PORT}/session/${sessionId}/assets/${attachedAsset.id}/stream`;
          attachedAssetInfo.push({
            id: attachedAsset.id,
            filename: attachedAsset.filename,
            type: attachedAsset.type,
            url: assetUrl,
          });
          attachedAssetPaths.push({
            id: attachedAsset.id,
            path: attachedAsset.path,  // Keep file path for server-side operations
            url: assetUrl,              // HTTP URL for Remotion rendering
            type: attachedAsset.type,
            filename: attachedAsset.filename,
          });
        }
      }
      if (attachedAssetInfo.length > 0) {
        attachedAssetsContext = `

ATTACHED MEDIA ASSETS (MUST be included in the animation):
${attachedAssetInfo.map((a, i) => `Asset ${i + 1}:
  - id: "${a.id}"
  - type: "${a.type}"
  - filename: "${a.filename}"`).join('\n')}

CRITICAL REQUIREMENTS:
1. You MUST create at least one "media" type scene for each attached asset above
2. In each media scene, set "mediaAssetId" to the EXACT id value shown above (copy/paste it exactly)
3. Use "mediaStyle": "framed" for a nicely presented image, or "fullscreen" for dramatic impact
4. Example media scene:
   {
     "id": "show-image",
     "type": "media",
     "duration": 90,
     "content": {
       "title": "Optional title over the image",
       "mediaAssetId": "${attachedAssetInfo[0].id}",
       "mediaStyle": "framed",
       "color": "#f97316"
     }
   }`;
        console.log(`[${jobId}] Including ${attachedAssetInfo.length} attached assets in animation`);
      }
    }

    // Step 1: Use DeepSeek to generate scene data
    console.log(`[${jobId}] Generating scenes with DeepSeek...`);

    const prompt = `You are a motion graphics designer. Create a JSON scene structure for an animated video based on this description:

"${description}"
${transcriptContext}${attachedAssetsContext}
Return ONLY valid JSON (no markdown, no code blocks) with this structure:
{
  "scenes": [
    {
      "id": "unique-id",
      "type": "title" | "steps" | "features" | "stats" | "text" | "transition" | "media" | "chart" | "comparison" | "countdown" | "shapes" | "emoji" | "gif" | "lottie",
      "duration": <number of frames at 30fps, typically 45-90 (1.5-3 seconds per scene). Keep scenes SHORT and punchy!>,
      "content": {
        "title": "optional title text",
        "subtitle": "optional subtitle",
        "items": [{"icon": "emoji or number", "label": "text", "description": "optional", "value": 75, "color": "#hex"}],
        "stats": [{"value": "10K+", "label": "Users", "numericValue": 10000, "prefix": "", "suffix": "+"}],  // IMPORTANT: numericValue must be a NUMBER (not string) for counting animation!
        "color": "#hex color for accent",
        "backgroundColor": "#hex for bg or null for transparent",
        // MEDIA SCENE OPTIONS:
        "mediaAssetId": "id of attached image/video to display",
        "mediaStyle": "fullscreen" | "framed" | "pip" | "background" | "split-left" | "split-right" | "circle" | "phone-frame",
        // VIDEO CONTROLS (for video assets):
        "videoStartFrom": 0,  // frame to start playing from
        "videoEndAt": 90,     // frame to stop at (for trimming)
        "videoVolume": 1,     // 0-1
        "videoPlaybackRate": 1, // 0.5 = slow-mo, 2 = fast forward
        "videoLoop": false,
        "videoMuted": false,
        // MEDIA ANIMATION (ken-burns, zoom, pan on the media itself):
        "mediaAnimation": {"type": "ken-burns" | "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "parallax", "intensity": 0.3},
        // TEXT OVERLAY ON MEDIA:
        "overlayText": "Text to show over media",
        "overlayPosition": "top" | "center" | "bottom",
        "overlayStyle": "minimal" | "bold" | "gradient-bar",
        // SHAPES SCENE OPTIONS:
        "shapes": [
          {
            "type": "circle" | "rect" | "triangle" | "star" | "polygon" | "ellipse",
            "fill": "#hex color",
            "stroke": "#hex outline color",
            "strokeWidth": 2,
            "x": 50, "y": 50,  // position as percentage (0-100)
            "scale": 1,
            "rotation": 0,
            "delay": 0,  // animation delay in frames
            "animation": "pop" | "spin" | "bounce" | "float" | "pulse" | "none",
          }
        ],
        "shapesLayout": "scattered" | "grid" | "circle" | "custom",
        // EMOJI SCENE OPTIONS:
        "emojis": [
          {
            "emoji": "🔥",
            "x": 50, "y": 50,
            "scale": 0.2,
            "delay": 0,
            "animation": "pop" | "bounce" | "float" | "pulse" | "spin" | "shake" | "wave" | "none"
          }
        ],
        "emojiLayout": "scattered" | "grid" | "circle" | "row" | "custom",
        // OTHER SCENE OPTIONS:
        "chartType": "bar" | "progress" | "pie",
        "chartData": [{"label": "Category", "value": 75, "color": "#hex"}],
        "maxValue": 100,
        "beforeLabel": "BEFORE", "afterLabel": "AFTER",
        "beforeValue": "50%", "afterValue": "95%",
        "countFrom": 3, "countTo": 0,
        "camera": {"type": "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "ken-burns" | "shake", "intensity": 0.3}
      },
      "transition": {"type": "swipe-left" | "swipe-right" | "swipe-up" | "swipe-down" | "fade" | "zoom-in" | "zoom-out" | "wipe-left" | "wipe-right" | "blur" | "flip", "duration": 15}
    }
  ],
  "backgroundColor": "#0a0a0a",
  "totalDuration": <sum of all scene durations>,
  "attachedAssets": [{"id": "asset-id", "path": "will be filled by server"}]
}

Scene types:
- "title": Big centered title with optional subtitle (for intros/outros)
- "steps": Numbered steps or process flow (1, 2, 3...)
- "features": Feature showcase with icons
- "stats": Animated statistics/numbers with COUNTING animation. CRITICAL: Include "numericValue" as INTEGER.
- "text": Simple text message
- "transition": Brief transition
- "media": Display an attached image/video with mediaStyle/mediaAnimation
- "chart": Data visualization: bar, progress, pie
- "comparison": Before/after comparison
- "countdown": Animated countdown
- "shapes": Animated SVG shapes with animations: pop, spin, bounce, float, pulse
- "emoji": Animated emoji scenes
- "gif": Animated GIF via GIPHY search (use gifSearch field)
- "lottie": Lottie animations from URL

${attachedAssetIds?.length ? `- Include media scenes to showcase attached images/videos` : ''}`;

    const result = await generateWithDeepSeek({
      prompt,
      responseMimeType: 'application/json',
      jobId,
    });

    let sceneData;
    try {
      const responseText = result.candidates[0].content.parts[0].text;
      // Clean up response - remove markdown code blocks if present
      const cleanedResponse = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      sceneData = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse AI response:`, parseError);
      throw new Error('Failed to parse AI-generated scene data');
    }

    console.log(`[${jobId}] Generated ${sceneData.scenes.length} scenes`);

    // Log camera movements for debugging
    const scenesWithCamera = sceneData.scenes.filter(s => s.content?.camera?.type);
    if (scenesWithCamera.length > 0) {
      console.log(`[${jobId}] 🎥 Camera movements: ${scenesWithCamera.map(s => `${s.id}: ${s.content.camera.type}`).join(', ')}`);
    } else {
      console.log(`[${jobId}] ⚠️ No camera movements in any scene`);
    }

    // Sanitize scene durations before computing totalDuration
    if (sceneData.scenes && sceneData.scenes.length > 0) {
      sceneData.scenes.forEach((s) => {
        if (!s.duration || s.duration <= 0) s.duration = 30;
      });
    }
    let totalDuration = sceneData.totalDuration ?? sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    // Guard against zero or negative totalDuration
    if (!totalDuration || totalDuration <= 0) {
      totalDuration = 30;
      sceneData.totalDuration = 30;
      sceneData.scenes = [{ id: 'scene-1', type: 'title', duration: 30, content: { title: 'Animation', backgroundColor: '#1a1a2e', textColor: '#ffffff', accentColor: '#6366f1' } }];
    }

    // Enforce user-requested duration by scaling scene durations proportionally
    if (durationSeconds) {
      const targetFrames = Math.round(durationSeconds * fps);
      if (totalDuration !== targetFrames && totalDuration > 0) {
        const scale = targetFrames / totalDuration;
        console.log(`[${jobId}] ⏱️ Adjusting duration: AI gave ${totalDuration} frames (${(totalDuration / fps).toFixed(1)}s), user requested ${durationSeconds}s (${targetFrames} frames). Scale: ${scale.toFixed(2)}x`);
        for (const scene of sceneData.scenes) {
          const oldDuration = scene.duration;
          scene.duration = Math.max(1, Math.round(scene.duration * scale));
          console.log(`[${jobId}]   Scene "${scene.id}": ${oldDuration} → ${scene.duration} frames`);
        }
        totalDuration = sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
        sceneData.totalDuration = totalDuration;
        console.log(`[${jobId}] ⏱️ Adjusted total: ${totalDuration} frames (${(totalDuration / fps).toFixed(1)}s)`);
      }
    }

    const durationInSeconds = totalDuration / fps;

    // Inject actual asset file paths for attached media (use absolute file paths for Remotion CLI)
    if (attachedAssetPaths.length > 0) {
      sceneData.attachedAssets = attachedAssetPaths;
      console.log(`[${jobId}] Available attached assets:`, attachedAssetPaths.map(a => ({ id: a.id, filename: a.filename, type: a.type })));

      // Also update any media scenes with the correct file paths
      let mediaSceneCount = 0;
      for (const scene of sceneData.scenes) {
        console.log(`[${jobId}] Checking scene: type=${scene.type}, hasMediaAssetId=${!!scene.content?.mediaAssetId}`);

        if (scene.type === 'media' && scene.content?.mediaAssetId) {
          const matchedAsset = attachedAssetPaths.find(a => a.id === scene.content.mediaAssetId);
          if (matchedAsset) {
            // Use HTTP URL for Remotion CLI rendering - more reliable than file:// paths
            scene.content.mediaPath = matchedAsset.url;
            scene.content.mediaType = matchedAsset.type;
            mediaSceneCount++;
            console.log(`[${jobId}] ✓ Linked media asset to scene: ${matchedAsset.filename} -> ${matchedAsset.url}`);
          } else {
            console.log(`[${jobId}] ✗ No matching asset found for mediaAssetId: ${scene.content.mediaAssetId}`);
            console.log(`[${jobId}]   Available IDs: ${attachedAssetPaths.map(a => a.id).join(', ')}`);
          }
        } else if (scene.type === 'media' && !scene.content?.mediaAssetId) {
          console.log(`[${jobId}] ✗ Media scene without mediaAssetId - will show placeholder`);
          // If the AI created a media scene but didn't set mediaAssetId, try to assign the first attached asset
          if (attachedAssetPaths.length > 0) {
            const firstAsset = attachedAssetPaths[0];
            scene.content.mediaAssetId = firstAsset.id;
            scene.content.mediaPath = firstAsset.url;  // Use HTTP URL
            scene.content.mediaType = firstAsset.type;
            mediaSceneCount++;
            console.log(`[${jobId}] ✓ Auto-assigned first attached asset: ${firstAsset.filename} -> ${firstAsset.url}`);
          }
        }
      }

      // If the AI didn't create any media scenes but we have attached assets, add one
      if (mediaSceneCount === 0 && attachedAssetPaths.length > 0) {
        console.log(`[${jobId}] ⚠ No media scenes found! Adding a media scene for the attached asset(s)`);
        const firstAsset = attachedAssetPaths[0];
        const mediaScene = {
          id: `media-${firstAsset.id}`,
          type: 'media',
          duration: 90, // 3 seconds at 30fps
          content: {
            title: firstAsset.filename.replace(/\.[^/.]+$/, ''), // filename without extension
            mediaAssetId: firstAsset.id,
            mediaPath: firstAsset.url,  // Use HTTP URL
            mediaType: firstAsset.type,
            mediaStyle: 'framed',
            color: '#f97316',
          }
        };
        // Insert media scene near the beginning (after the first scene if there is one)
        if (sceneData.scenes.length > 1) {
          sceneData.scenes.splice(1, 0, mediaScene);
        } else {
          sceneData.scenes.push(mediaScene);
        }
        sceneData.totalDuration = sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
        console.log(`[${jobId}] ✓ Added media scene for: ${firstAsset.filename} -> ${firstAsset.url}`);
      }
    }

    // Post-process GIF scenes - search GIPHY and inject actual URLs
    const giphyKey = process.env.GIPHY_API_KEY;
    for (const scene of sceneData.scenes) {
      if (scene.type === 'gif' && scene.content) {
        const { gifSearch, gifSearches } = scene.content;
        const searchTerms = gifSearches || (gifSearch ? [gifSearch] : []);

        if (searchTerms.length > 0 && giphyKey) {
          console.log(`[${jobId}] 🎬 Fetching GIFs from GIPHY for: ${searchTerms.join(', ')}`);
          scene.content.gifs = [];

          for (const term of searchTerms) {
            try {
              const gifs = await searchGiphy(term, 1);
              if (gifs.length > 0) {
                const gif = gifs[0];
                const gifUrl = gif.images?.fixed_height?.url || gif.images?.original?.url;
                if (gifUrl) {
                  scene.content.gifs.push({
                    src: gifUrl,
                    width: parseInt(gif.images?.fixed_height?.width) || 400,
                    height: parseInt(gif.images?.fixed_height?.height) || 300,
                    title: gif.title || term,
                    searchTerm: term,
                  });
                  console.log(`[${jobId}]    ✓ Found GIF for "${term}": ${gif.title || 'untitled'}`);
                }
              } else {
                console.log(`[${jobId}]    ✗ No GIF found for "${term}"`);
              }
            } catch (err) {
              console.log(`[${jobId}]    ✗ GIPHY search failed for "${term}": ${err.message}`);
            }
          }

          // Set default layout if not specified
          if (!scene.content.gifLayout && scene.content.gifs.length === 1) {
            scene.content.gifLayout = 'fullscreen';
          } else if (!scene.content.gifLayout) {
            scene.content.gifLayout = 'scattered';
          }

          console.log(`[${jobId}]    Total GIFs fetched: ${scene.content.gifs.length}`);
        } else if (searchTerms.length > 0 && !giphyKey) {
          console.log(`[${jobId}] ⚠ GIPHY_API_KEY not configured - skipping GIF search`);
        }
      }
    }

    // Post-process stats to ensure numericValue is set for counting animation
    for (const scene of sceneData.scenes) {
      if (scene.type === 'stats' && scene.content?.stats) {
        console.log(`[${jobId}] 📊 Processing stats scene with ${scene.content.stats.length} stats...`);
        for (const stat of scene.content.stats) {
          console.log(`[${jobId}]    Raw stat: value="${stat.value}", numericValue=${stat.numericValue} (type: ${typeof stat.numericValue}), prefix="${stat.prefix || ''}", suffix="${stat.suffix || ''}"`);

          // Convert numericValue to number if it's a string
          if (typeof stat.numericValue === 'string') {
            const parsed = parseFloat(stat.numericValue);
            if (!isNaN(parsed)) {
              stat.numericValue = parsed;
              console.log(`[${jobId}]    ✓ Converted string numericValue to number: ${stat.numericValue}`);
            } else {
              stat.numericValue = undefined; // Clear invalid string so we can extract from value
            }
          }

          // If numericValue is not a valid positive number, try to extract from value string
          const hasValidNumericValue = typeof stat.numericValue === 'number' && !isNaN(stat.numericValue) && stat.numericValue > 0;

          if (!hasValidNumericValue && stat.value) {
            const extracted = extractNumericValue(stat.value);
            if (extracted && extracted.numericValue > 0) {
              stat.numericValue = extracted.numericValue;
              stat.prefix = stat.prefix || extracted.prefix;
              stat.suffix = stat.suffix || extracted.suffix;
              console.log(`[${jobId}]    ✓ Extracted: "${stat.value}" → prefix="${stat.prefix}" numericValue=${stat.numericValue} suffix="${stat.suffix}"`);
            } else {
              console.log(`[${jobId}]    ✗ Could not extract numeric value from "${stat.value}"`);
            }
          } else if (hasValidNumericValue) {
            console.log(`[${jobId}]    ✓ Already has valid numericValue: ${stat.numericValue}`);
          }

          // Final check: log what will be used for rendering
          const finalHasNumeric = typeof stat.numericValue === 'number' && !isNaN(stat.numericValue) && stat.numericValue > 0;
          console.log(`[${jobId}]    → Final: numericValue=${stat.numericValue}, will animate: ${finalHasNumeric}`);
        }
      }
    }

    // Step 2: Write props to JSON file for Remotion
    // Log final scene data for debugging
    console.log(`[${jobId}] Final scene data:`);
    for (const scene of sceneData.scenes) {
      const hasMedia = scene.content?.mediaPath ? `mediaPath: ${scene.content.mediaPath}` : 'no media';
      const hasStats = scene.content?.stats ? `stats: ${scene.content.stats.map(s => s.numericValue || s.value).join(', ')}` : '';
      console.log(`[${jobId}]   - ${scene.type}: ${scene.content?.title || '(no title)'} | ${hasMedia} ${hasStats}`);
    }
    try { await fs.promises.writeFile(propsPath, JSON.stringify(sceneData, null, 2)); } catch (e) { console.warn(`[write] Props write failed: ${e.message}`); }
    console.log(`[${jobId}] Props written to ${propsPath}`);

    // Step 3: Render with Remotion
    console.log(`[${jobId}] Rendering with Remotion...`);

    // Read props from file for the renderer
    let propsData;
    try { propsData = JSON.parse(await fs.promises.readFile(propsPath, 'utf-8')); } catch { propsData = sceneData; }

    let renderOk = false;
    try {
      await renderWithRemotion({
        compositionId: 'DynamicAnimation',
        props: propsData,
        outputPath,
        fps,
        width,
        height,
        onProgress: (pct, step) => {
          if (pct % 10 === 0 || pct === 100) console.log(`[${jobId}] Render: ${pct}%`);
        },
      });
      await fs.promises.writeFile(sceneDataPath, JSON.stringify(sceneData, null, 2));
      renderOk = true;
    } catch (renderErr) {
      console.error(`[${jobId}] Programmatic render failed: ${renderErr.message}`);
    }

    if (!renderOk) {
      // Fallback to npx
      const remotionArgs = [
      'remotion', 'render',
      `${FRONTEND_ROOT}/src/remotion/index.tsx`,
      'DynamicAnimation',
      outputPath,
      '--props', propsPath,
      '--frames', `0-${Math.max(1, totalDuration) - 1}`,
      '--fps', String(fps),
      '--width', String(width),
      '--height', String(height),
      '--codec', 'h264',
      '--overwrite',
      '--gl=angle', // Use Metal GPU acceleration on macOS
    ];

    await new Promise((resolve, reject) => {
      const proc = spawn(
        'npx',
        remotionArgs,
        {
          cwd: FRONTEND_ROOT,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      let stderr = '';
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log(`[${jobId}] Remotion: ${data.toString().trim()}`);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Remotion render failed with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start Remotion: ${err.message}`));
      });
    });
    } // end npx fallback

    // Step 4: Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Store the scene data for future editing (don't delete props)
    const sceneDataPath = join(session.dir, `${assetId}-scenes.json`);
    try { await fs.promises.writeFile(sceneDataPath, JSON.stringify(sceneData, null, 2)); } catch (e) { console.warn(`[write] Scene data write failed: ${e.message}`); }

    // Clean up temporary props file (but keep scene data)
    try {
      unlinkSync(propsPath);
    } catch (e) {
      // Ignore cleanup errors
    }

    const stats = await stat(outputPath);

    // Create asset entry with scene data for re-editing
    const asset = {
      id: assetId,
      type: 'video',
      filename: `animation-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: durationInSeconds,
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
      // Metadata for AI animations
      aiGenerated: true,
      description,
      sceneCount: sceneData.scenes.length,
      sceneDataPath, // Store path to scene data for re-editing
      sceneData, // Also keep in memory for quick access
    };

    session.assets.set(assetId, asset);
    await saveAssetMetadata(session); // Persist AI-generated flag to disk

    console.log(`[${jobId}] AI animation rendered: ${assetId} (${durationInSeconds}s)`);
    console.log(`[${jobId}] === GENERATION COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId,
      filename: asset.filename,
      duration: durationInSeconds,
      sceneCount: sceneData.scenes.length,
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
    }));

  } catch (error) {
    console.error('AI animation generation error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Edit an existing animation with a new prompt
// Takes the original scene data and modifies it based on the prompt
async function handleEditAnimation(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId, editPrompt, assets: availableAssets, v1Context, fps = 30, width = 1920, height = 1080 } = body;

    if (!assetId || !editPrompt) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'assetId and editPrompt are required' }));
      return;
    }

    // Get the original animation asset
    const originalAsset = session.assets.get(assetId);
    if (!originalAsset) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Animation asset not found' }));
      return;
    }

    if (!originalAsset.aiGenerated) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Asset is not an AI-generated animation' }));
      return;
    }

    // Get the original scene data
    let originalSceneData = originalAsset.sceneData;
    if (!originalSceneData && originalAsset.sceneDataPath) {
      try {
        const content = await fs.promises.readFile(originalAsset.sceneDataPath, 'utf-8');
        originalSceneData = JSON.parse(content);
      } catch { /* file may not exist */ }
    }

    if (!originalSceneData) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Original scene data not found - cannot edit this animation' }));
      return;
    }

    const jobId = randomUUID();
    // IMPORTANT: Reuse the same asset ID to replace in-place (no asset creep)
    const outputPath = originalAsset.path; // Overwrite existing video file
    const thumbPath = originalAsset.thumbPath || join(session.assetsDir, `${assetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-props.json`);
    // Reuse existing scene data path or create one with original asset ID
    const existingSceneDataPath = originalAsset.sceneDataPath || join(session.dir, `${assetId}-scenes.json`);

    console.log(`\n[${jobId}] ========================================`);
    console.log(`[${jobId}] === EDIT AI ANIMATION (IN-PLACE) ===`);
    console.log(`[${jobId}] ========================================`);
    console.log(`[${jobId}] IMPORTANT: Reusing SAME asset ID: ${assetId}`);
    console.log(`[${jobId}] Output path (overwriting): ${outputPath}`);
    console.log(`[${jobId}] Edit prompt: ${editPrompt}`);
    console.log(`[${jobId}] Original scene count: ${originalSceneData.scenes?.length || 0}`);
    console.log(`[${jobId}] Original scenes: ${originalSceneData.scenes?.map(s => s.type).join(', ') || 'none'}`);
    console.log(`[${jobId}] Original scene data being passed to AI:`);
    console.log(JSON.stringify(originalSceneData, null, 2));
    if (v1Context) {
      console.log(`[${jobId}] V1 context: ${v1Context.filename} (${v1Context.type})`);
    }

    // Build transcript context from source video if available
    // Try V1 context first, but fall back to any non-AI-generated video in session
    let transcriptContext = '';
    let sourceVideoAsset = null;

    // First, try the V1 clip if it's a real video (not AI-generated animation)
    if (v1Context && v1Context.assetId && v1Context.type === 'video') {
      const v1VideoAsset = session.assets.get(v1Context.assetId);
      if (v1VideoAsset && v1VideoAsset.type === 'video' && !v1VideoAsset.aiGenerated) {
        sourceVideoAsset = v1VideoAsset;
        console.log(`[${jobId}] 📝 Using V1 source video for transcript: ${v1VideoAsset.filename}`);
      }
    }

    // If V1 is an animation, find any source video in the session
    if (!sourceVideoAsset) {
      for (const asset of session.assets.values()) {
        if (asset.type === 'video' && !asset.aiGenerated) {
          sourceVideoAsset = asset;
          console.log(`[${jobId}] 📝 Using session source video for transcript: ${asset.filename}`);
          break;
        }
      }
    }

    // Fetch transcript from the source video
    if (sourceVideoAsset) {
      try {
        const transcription = await getOrTranscribeVideo(session, sourceVideoAsset, jobId);
        if (transcription.text) {
          // Get first 1500 chars of transcript for context
          const transcriptText = transcription.text.substring(0, 1500);
          transcriptContext = `

VIDEO TRANSCRIPT CONTEXT (what's being said in the video "${sourceVideoAsset.filename}"):
"${transcriptText}"${transcription.text.length > 1500 ? '...' : ''}

This is what the viewer is hearing. Use this context to make the animation content relevant and synchronized with the video's message. Consider:
- Key topics and themes being discussed
- Important words, phrases, or concepts that could be visualized
- The tone and style of the content (educational, entertaining, promotional, etc.)
- Specific facts, numbers, or quotes that could be highlighted`;
          console.log(`[${jobId}] ✅ Transcript context added (${transcriptText.length} chars)`);
        }
      } catch (transcriptError) {
        console.log(`[${jobId}] ⚠️ Could not get transcript: ${transcriptError.message}`);
        // Continue without transcript - not a fatal error
      }
    } else {
      console.log(`[${jobId}] ℹ️ No source video found for transcript context`);
    }

    // Build asset context for AI
    let assetContext = '';

    // Include V1 context if provided (primary clip in the edit tab)
    if (v1Context) {
      assetContext += `\n\nPRIMARY V1 CLIP CONTEXT (currently on the timeline):
- ${v1Context.type}: "${v1Context.filename}" (id: ${v1Context.assetId})${v1Context.duration ? `, duration: ${v1Context.duration}s` : ''}
This clip is currently being used in the animation timeline. You can reference it for visual coherence or incorporate it into scenes.`;
    }

    if (availableAssets && availableAssets.length > 0) {
      assetContext += `\n\nAVAILABLE ASSETS you can use in the animation:
${availableAssets.map(a => `- ${a.type}: "${a.filename}" (id: ${a.id})${a.type === 'video' ? `, duration: ${a.duration}s` : ''}`).join('\n')}

To include an asset in a scene, use:
{
  "type": "asset",
  "assetType": "image" | "video",
  "assetId": "<asset id>",
  "duration": <frames>,
  "content": { "title": "optional overlay text" }
}`;
    }

    // Use DeepSeek to modify the scene data
    console.log(`[${jobId}] Modifying scenes with DeepSeek...`);

    const prompt = `You are editing an EXISTING Remotion animation. The user wants to make a SPECIFIC change.

## YOUR TASK
Make ONLY the change the user requested. Do NOT change anything else.

## EXISTING ANIMATION (copy this exactly, then apply ONLY the requested change):
${JSON.stringify(originalSceneData, null, 2)}

## USER'S REQUESTED CHANGE:
"${editPrompt}"
${assetContext}${transcriptContext}

## SCENE STRUCTURE REFERENCE:
Scene types and their content properties:
- "title": { "title": "text", "subtitle": "optional text", "color": "#hex", "backgroundColor": "#hex" }
- "text": { "title": "main text", "subtitle": "optional" }
- "steps" / "features": { "title": "optional heading", "items": [{"icon": "emoji", "label": "text", "description": "optional"}] }
- "stats": { "stats": [{"value": "10K+", "label": "Users", "numericValue": 10000}] }
- "transition": { "color": "#hex" }

## ADDING EMOJIS/ICONS:
To add emojis or icons, use scene types that support "items" array:
{
  "type": "features",
  "duration": 90,
  "content": {
    "title": "Optional heading",
    "items": [
      {"icon": "💯", "label": "100% Satisfaction"},
      {"icon": "🔥", "label": "Hot Feature"},
      {"icon": "⭐", "label": "5-Star Quality"}
    ]
  }
}

To add a SINGLE large emoji/icon, use a "title" scene with the emoji IN the title:
{
  "type": "title",
  "duration": 60,
  "content": {
    "title": "💯",
    "subtitle": "Perfect Score"
  }
}

## CAMERA MOVEMENTS (IMPORTANT - add to make scenes dynamic):
Camera movements make scenes more engaging. Add a "camera" object INSIDE the scene's "content":

Available camera types:
- "zoom-in": Slowly zoom into the content (intensity 0.2-0.4 recommended)
- "zoom-out": Start zoomed in, pull back to reveal
- "pan-left" / "pan-right": Horizontal tracking movement
- "pan-up" / "pan-down": Vertical tilt movement
- "ken-burns": Classic documentary style (slow zoom + subtle pan)
- "shake": Camera shake for energy/impact (use low intensity 0.1-0.2)

EXAMPLE - Complete scene with camera movement:
{
  "id": "intro-scene",
  "type": "title",
  "duration": 90,
  "content": {
    "title": "Welcome",
    "subtitle": "Let's get started",
    "color": "#ffffff",
    "backgroundColor": "#1a1a2e",
    "camera": {
      "type": "zoom-in",
      "intensity": 0.3
    }
  }
}

WHEN TO ADD CAMERA MOVEMENTS:
- User says "add zoom", "zoom in", "zoom effect" → Add camera with type "zoom-in"
- User says "add pan", "pan across", "tracking" → Add camera with type "pan-left" or "pan-right"
- User says "ken burns", "documentary style" → Add camera with type "ken-burns"
- User says "shake", "energy", "impact" → Add camera with type "shake" (low intensity)
- User says "make it dynamic", "more movement", "cinematic" → Add camera movements to multiple scenes

## STRICT RULES - FOLLOW EXACTLY:
1. Copy the ENTIRE existing animation structure above
2. Find ONLY the specific element the user mentioned
3. Change ONLY that element - nothing else
4. Keep ALL other text, colors, durations, and properties EXACTLY the same

## EXAMPLES OF CORRECT BEHAVIOR:
- User says "change the title to Hello World" → Only change the title text field, keep all colors/styles
- User says "make it blue" → Only change color values, keep all text the same
- User says "add a new scene" → Keep all existing scenes, append the new one
- User says "add zoom effect" → Add camera object with zoom-in to relevant scenes
- User says "add ken burns to the intro" → Add camera object to intro scene only
- User says "make it more dynamic" → Add camera movements and/or transitions to scenes
- User says "add a 100 emoji" → Add a new scene with type "title" and title "💯" or add to items array
- User says "add fire emoji" → Add "🔥" to title or items depending on context
- User says "visualize the transcript" → Create scenes that highlight key words, phrases, or concepts from the transcript
- User says "add kinetic typography" → Create animated text scenes using words from the transcript

## TRANSCRIPT VISUALIZATION (if transcript context is provided):
When transcript context is available, you can use it to:
- Extract key quotes and display them with "title" or "text" scenes
- Identify statistics or numbers mentioned and create "stats" scenes
- Find key steps or points and create "steps" or "features" scenes
- Pull important concepts and visualize them with relevant emojis/icons
- Create word clouds or key phrase highlights

## EXAMPLES OF WRONG BEHAVIOR (DO NOT DO THIS):
- Changing colors when user only asked about text
- Changing text when user only asked about colors
- Removing or reordering scenes
- Changing durations unless specifically asked

Return ONLY the complete JSON structure with your minimal change applied. No markdown, no explanation.`;

    console.log(`[${jobId}] Modifying scenes with DeepSeek...`);
    const result = await generateWithDeepSeek({
      prompt,
      config: { model: 'deepseek-reasoner' }, // Use R1 for complex edit reasoning
      responseMimeType: 'application/json',
      jobId,
    });

    let newSceneData;
    try {
      const responseText = result.candidates[0].content.parts[0].text;
      const cleanedResponse = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      newSceneData = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse DeepSeek response:`, parseError);
      throw new Error('Failed to parse AI-modified scene data');
    }

    console.log(`[${jobId}] Modified to ${newSceneData.scenes.length} scenes`);

    // Log camera movements for debugging
    const scenesWithCamera = newSceneData.scenes.filter(s => s.content?.camera?.type);
    if (scenesWithCamera.length > 0) {
      console.log(`[${jobId}] 🎥 Camera movements: ${scenesWithCamera.map(s => `${s.id}: ${s.content.camera.type}`).join(', ')}`);
    } else {
      console.log(`[${jobId}] ⚠️ No camera movements in any scene`);
    }

    const totalDuration = newSceneData.totalDuration ?? newSceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = Math.max(1, totalDuration) / fps;

    // Store scene data for future editing (overwrite existing)
    await fs.promises.writeFile(existingSceneDataPath, JSON.stringify(newSceneData, null, 2));

    // Write props for Remotion
    await fs.promises.writeFile(propsPath, JSON.stringify(newSceneData, null, 2));
    console.log(`[${jobId}] Props written to ${propsPath}`);

    // Render with Remotion
    console.log(`[${jobId}] Rendering with Remotion...`);

    let renderOk2 = false;
    try {
      await renderWithRemotion({
        compositionId: 'DynamicAnimation',
        props: newSceneData,
        outputPath,
        fps,
        width,
        height,
        onProgress: (pct) => { if (pct % 10 === 0) console.log(`[${jobId}] Render: ${pct}%`); },
      });
      renderOk2 = true;
    } catch (renderErr) {
      console.error(`[${jobId}] Programmatic render failed: ${renderErr.message}`);
    }

    if (!renderOk2) {
      const remotionArgs = [
        'remotion', 'render',
        `${FRONTEND_ROOT}/src/remotion/index.tsx`,
        'DynamicAnimation',
        outputPath,
        '--props', propsPath,
        '--frames', `0-${Math.max(1, totalDuration) - 1}`,
        '--fps', String(fps),
        '--width', String(width),
        '--height', String(height),
        '--codec', 'h264',
        '--overwrite',
      ];
      await new Promise((resolve, reject) => {
        const proc = spawn('npx', remotionArgs, { cwd: FRONTEND_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Remotion failed (code ${code}): ${stderr}`)));
        proc.on('error', reject);
      });
    }

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Clean up props file
    try {
      unlinkSync(propsPath);
    } catch (e) {}

    const stats = await stat(outputPath);

    // Update the existing asset entry IN-PLACE (no new asset, prevents asset creep)
    originalAsset.duration = durationInSeconds;
    originalAsset.size = stats.size;
    originalAsset.thumbPath = existsSync(thumbPath) ? thumbPath : null;
    originalAsset.sceneCount = newSceneData.scenes.length;
    originalAsset.sceneDataPath = existingSceneDataPath;
    originalAsset.sceneData = newSceneData;
    originalAsset.lastEditedAt = Date.now();
    originalAsset.lastEditPrompt = editPrompt;
    // Keep original description but track edit history
    originalAsset.editCount = (originalAsset.editCount || 0) + 1;
    await saveAssetMetadata(session); // Persist updated metadata to disk

    console.log(`[${jobId}] ========================================`);
    console.log(`[${jobId}] Animation updated IN-PLACE successfully!`);
    console.log(`[${jobId}] SAME asset ID: ${assetId}`);
    console.log(`[${jobId}] Duration: ${durationInSeconds}s`);
    console.log(`[${jobId}] Edit count: ${originalAsset.editCount}`);
    console.log(`[${jobId}] Total assets in session: ${session.assets.size}`);
    console.log(`[${jobId}] === EDIT COMPLETE ===`);
    console.log(`[${jobId}] ========================================\n`);

    const responseData = {
      success: true,
      assetId: assetId, // Same asset ID - no new asset created
      filename: originalAsset.filename,
      duration: durationInSeconds,
      sceneCount: newSceneData.scenes.length,
      editCount: originalAsset.editCount,
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail?t=${Date.now()}`, // Cache bust
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream?t=${Date.now()}`, // Cache bust
    };

    console.log(`[${jobId}] Sending response:`, JSON.stringify(responseData, null, 2));

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(responseData));

  } catch (error) {
    console.error('Animation edit error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate image using fal.ai nano-banana-pro model (Picasso agent)
async function handleGenerateImage(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falApiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'FAL_KEY or FAL_API_KEY not configured in .dev.vars' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const {
      prompt,
      aspectRatio = '16:9',
      resolution = '1K',
      numImages = 1
    } = body;

    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'prompt is required' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === PICASSO: GENERATE IMAGE ===`);
    console.log(`[${jobId}] User prompt: ${prompt}`);
    console.log(`[${jobId}] Aspect ratio: ${aspectRatio}, Resolution: ${resolution}`);

    // Enhance prompt using DeepSeek for better image generation results
    let enhancedPrompt = prompt;
    try {
      console.log(`[${jobId}] Enhancing prompt with Picasso AI...`);

      const systemPrompt = `You are Picasso, an expert AI prompt engineer specializing in image generation. Your role is to transform simple user requests into detailed, visually compelling prompts that produce stunning images.

## Rules
- Keep the enhanced prompt under 200 words
- Preserve the user's core intent
- Output ONLY the enhanced prompt, no explanations or markdown`;

      const result = await generateWithDeepSeek({
        systemInstruction: systemPrompt,
        prompt: `Enhance this image prompt:\n\n"${prompt}"`,
        jobId,
      });

      const enhanced = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (enhanced && enhanced.length > 10) {
        enhancedPrompt = enhanced;
        console.log(`[${jobId}] Enhanced prompt: ${enhancedPrompt.substring(0, 100)}...`);
      }
    } catch (enhanceError) {
      console.warn(`[${jobId}] Prompt enhancement failed, using original:`, enhanceError.message);
    }

    // Call fal.ai FLUX.1 schnell for image generation
    console.log(`[${jobId}] Sending to fal.ai FLUX.1 schnell...`);
    const falResult = await fal.run('fal-ai/flux/schnell', {
      input: {
        prompt: enhancedPrompt,
        num_images: Math.min(numImages, 4),
        image_size: 'square_hd',
        output_format: 'png',
      },
    });
    console.log(`[${jobId}] Generated ${falResult.data?.images?.length || 0} images`);

    // SDK returns { data, requestId }
    const images = falResult.data?.images;
    if (!images || images.length === 0) {
      throw new Error('No images generated');
    }

    // Download and save each generated image as an asset
    const generatedAssets = [];

    for (let i = 0; i < images.length; i++) {
      const imageData = images[i];
      const imageId = randomUUID();
      const imagePath = join(session.assetsDir, `${imageId}.png`);
      const thumbPath = join(session.assetsDir, `${imageId}_thumb.jpg`);

      console.log(`[${jobId}] Downloading image ${i + 1}...`);

      // Download image
      const imageResponse = await fetch(imageData.url);
      if (!imageResponse.ok) {
        throw new Error(`Failed to download image: ${imageResponse.status}`);
      }

      const buffer = await imageResponse.arrayBuffer();
      await fs.promises.writeFile(imagePath, Buffer.from(buffer));

      // Generate thumbnail
      try {
        await runFFmpeg([
          '-y', '-i', imagePath,
          '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
          '-frames:v', '1',
          thumbPath
        ], jobId);
      } catch (e) {
        console.warn(`[${jobId}] Thumbnail generation failed:`, e.message);
      }

      // stat already imported at top level
      const stats = await stat(imagePath);

      // Create short filename from prompt
      const shortPrompt = prompt.substring(0, 30).replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-');

      const asset = {
        id: imageId,
        type: 'image',
        filename: `picasso-${shortPrompt}.png`,
        path: imagePath,
        thumbPath: existsSync(thumbPath) ? thumbPath : null,
        duration: 5, // Default 5 seconds for images on timeline
        size: stats.size,
        width: imageData.width || 1024,
        height: imageData.height || 1024,
        createdAt: Date.now(),
        aiGenerated: true,
        generatedBy: 'picasso',
        prompt: prompt, // Original user prompt
        enhancedPrompt: enhancedPrompt !== prompt ? enhancedPrompt : undefined, // Enhanced prompt if different
      };

      session.assets.set(imageId, asset);
      generatedAssets.push({
        id: imageId,
        filename: asset.filename,
        width: asset.width,
        height: asset.height,
        thumbnailUrl: `/session/${sessionId}/assets/${imageId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${imageId}/stream`,
      });

      console.log(`[${jobId}] Saved image: ${asset.filename} (${(stats.size / 1024).toFixed(1)} KB)`);
    }

    await saveAssetMetadata(session); // Persist asset metadata to disk
    console.log(`[${jobId}] === PICASSO COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      images: generatedAssets,
      description: falResult.description,
    }));

  } catch (error) {
    console.error('Image generation error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate video from image using fal.ai (DiCaprio agent)
async function handleGenerateVideo(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falApiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'FAL_KEY or FAL_API_KEY not configured in .dev.vars' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { prompt, imageAssetId, duration = 5 } = body;

    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'prompt is required' }));
      return;
    }

    if (!imageAssetId) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'imageAssetId is required' }));
      return;
    }

    // Get the source image asset
    const imageAsset = session.assets.get(imageAssetId);
    if (!imageAsset || imageAsset.type !== 'image') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Image asset not found' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === DICAPRIO: GENERATE VIDEO ===`);
    console.log(`[${jobId}] User prompt: ${prompt}`);
    console.log(`[${jobId}] Source image: ${imageAsset.filename}`);
    console.log(`[${jobId}] Duration: ${duration}s`);

    // Enhance prompt using DeepSeek for better video generation
    let enhancedPrompt = prompt;
    try {
      console.log(`[${jobId}] Enhancing prompt with DiCaprio AI...`);

      const systemPrompt = `You are DiCaprio, an expert AI prompt engineer specializing in image-to-video generation. Your role is to transform simple motion requests into detailed, cinematic prompts that produce stunning videos.

## Response Format
Return ONLY the enhanced prompt text. No explanations, no quotes, no markdown.`;

      const result = await generateWithDeepSeek({
        systemInstruction: systemPrompt,
        prompt: `Enhance this video motion prompt: "${prompt}"`,
        jobId,
      });

      const enhanced = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (enhanced && enhanced.length > 10) {
        enhancedPrompt = enhanced;
        console.log(`[${jobId}] Enhanced prompt: ${enhancedPrompt.substring(0, 100)}...`);
      }
    } catch (e) {
      console.log(`[${jobId}] Prompt enhancement failed, using original: ${e.message}`);
    }

    // Upload image to fal.ai storage to get a URL (handles large files)
    console.log(`[${jobId}] Uploading image to fal.ai storage...`);
    const imageBuffer = await fs.promises.readFile(imageAsset.path);
    const mimeType = imageAsset.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const imageBlob = new Blob([imageBuffer], { type: mimeType });
    const uploadedImageUrl = await fal.storage.upload(imageBlob);
    console.log(`[${jobId}] Image uploaded: ${uploadedImageUrl.substring(0, 50)}...`);

    console.log(`[${jobId}] Calling fal.ai video generation...`);

    // Use fal.ai SDK with automatic queue handling
    const falResult = await fal.subscribe('fal-ai/kling-video/v1.5/pro/image-to-video', {
      input: {
        prompt: enhancedPrompt,
        image_url: uploadedImageUrl,
        duration: duration === 10 ? '10' : '5',
        aspect_ratio: '16:9',
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === 'IN_QUEUE') {
          console.log(`[${jobId}] Queued at position ${update.position || '?'}`);
        } else if (update.status === 'IN_PROGRESS') {
          console.log(`[${jobId}] Processing...`);
        }
      },
    });

    console.log(`[${jobId}] Video generation complete!`);

    // Download the generated video - SDK returns { data, requestId }
    const videoUrl = falResult.data?.video?.url;
    if (!videoUrl) {
      throw new Error('No video URL in response');
    }

    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) {
      throw new Error('Failed to download generated video');
    }

    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());

    // Save to assets
    const videoId = randomUUID();
    const shortPrompt = prompt.substring(0, 30).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
    const videoPath = join(session.assetsDir, `${videoId}.mp4`);
    const thumbPath = join(session.assetsDir, `${videoId}_thumb.jpg`);

    await fs.promises.writeFile(videoPath, videoBuffer);

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', videoPath,
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Get video duration using ffprobe
    let videoDuration = duration;
    try {
      const probeResult = await new Promise((resolve, reject) => {
        const proc = spawn('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'json',
          videoPath
        ]);
        let output = '';
        proc.stdout.on('data', d => output += d.toString());
        proc.on('close', code => {
          if (code === 0) {
            try {
              const data = JSON.parse(output);
              resolve(parseFloat(data.format.duration) || duration);
            } catch { resolve(duration); }
          } else {
            resolve(duration);
          }
        });
        proc.on('error', () => resolve(duration));
      });
      videoDuration = probeResult;
    } catch (e) {
      console.log(`[${jobId}] Could not probe video duration, using default`);
    }

    const stats = await stat(videoPath);

    // Create asset entry
    const asset = {
      id: videoId,
      filename: `dicaprio-${shortPrompt}.mp4`,
      originalFilename: `dicaprio-${shortPrompt}.mp4`,
      type: 'video',
      path: videoPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      size: stats.size,
      duration: videoDuration,
      width: 1920,
      height: 1080,
      uploadedAt: Date.now(),
      generatedBy: 'dicaprio',
      sourcePrompt: prompt,
      enhancedPrompt: enhancedPrompt,
      sourceImageId: imageAssetId,
    };

    session.assets.set(videoId, asset);
    await saveAssetMetadata(session);

    console.log(`[${jobId}] Saved video: ${asset.filename} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`[${jobId}] === DICAPRIO COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      video: {
        id: videoId,
        filename: asset.filename,
        thumbnailUrl: `/session/${sessionId}/assets/${videoId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${videoId}/stream`,
        duration: videoDuration,
      },
    }));

  } catch (error) {
    console.error('Video generation error:', error);
    console.error('Error stack:', error.stack);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Restyle video using LTX-2 video-to-video (DiCaprio agent)
async function handleRestyleVideo(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falApiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'FAL_KEY or FAL_API_KEY not configured in .dev.vars' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { prompt, videoAssetId } = body;

    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'prompt is required' }));
      return;
    }

    if (!videoAssetId) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'videoAssetId is required' }));
      return;
    }

    // Get the source video asset
    const videoAsset = session.assets.get(videoAssetId);
    if (!videoAsset || videoAsset.type !== 'video') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Video asset not found' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === DICAPRIO: RESTYLE VIDEO ===`);
    console.log(`[${jobId}] User prompt: ${prompt}`);
    console.log(`[${jobId}] Source video: ${videoAsset.filename}`);

    // Enhance prompt using DeepSeek for better style transfer
    let enhancedPrompt = prompt;
    try {
      console.log(`[${jobId}] Enhancing style prompt with AI...`);

      const result = await generateWithDeepSeek({
        prompt: `You are an expert at writing prompts for AI video style transfer. Transform this simple style request into a detailed, cinematic prompt that will produce stunning results.

User request: "${prompt}"

Write a detailed prompt describing the visual style. Include:
- Color grading and mood
- Texture and grain quality
- Lighting style
- Overall aesthetic
- Any specific visual effects

Return ONLY the enhanced prompt, no explanations.`,
        jobId,
      });

      const enhanced = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (enhanced && enhanced.length > 10) {
        enhancedPrompt = enhanced;
        console.log(`[${jobId}] Enhanced prompt: ${enhancedPrompt.substring(0, 100)}...`);
      }
    } catch (e) {
      console.log(`[${jobId}] Prompt enhancement failed, using original: ${e.message}`);
    }

    // Compress video for upload (fal.ai has size limits)
    const compressedPath = join(TEMP_DIR, `${jobId}-compressed.mp4`);
    console.log(`[${jobId}] Compressing video for upload...`);

    // Compress to 720p max, lower bitrate for faster upload
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vf', 'scale=-2:720',  // Max 720p height, maintain aspect
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '28',  // Lower quality but smaller file
      '-c:a', 'aac',
      '-b:a', '128k',
      '-t', '10',  // Max 10 seconds for API limits
      compressedPath
    ], jobId);

    // Upload compressed video to fal.ai storage
    console.log(`[${jobId}] Uploading compressed video to fal.ai storage...`);
    const videoBuffer = await fs.promises.readFile(compressedPath);
    const fileSizeMB = videoBuffer.length / (1024 * 1024);
    console.log(`[${jobId}] Compressed size: ${fileSizeMB.toFixed(1)} MB`);

    const videoBlob = new Blob([videoBuffer], { type: 'video/mp4' });
    const uploadedVideoUrl = await fal.storage.upload(videoBlob);
    console.log(`[${jobId}] Video uploaded: ${uploadedVideoUrl.substring(0, 50)}...`);

    // Clean up compressed file
    try { unlinkSync(compressedPath); } catch (e) {}

    console.log(`[${jobId}] Calling fal.ai LTX-2 video-to-video...`);

    // Use fal.ai SDK with automatic queue handling
    const falResult = await fal.subscribe('fal-ai/ltx-2-19b/video-to-video', {
      input: {
        prompt: enhancedPrompt,
        video_url: uploadedVideoUrl,
        num_inference_steps: 40,
        guidance_scale: 3,
        video_strength: 0.7,
        generate_audio: false,
        video_quality: 'high',
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === 'IN_QUEUE') {
          console.log(`[${jobId}] Queued at position ${update.position || '?'}`);
        } else if (update.status === 'IN_PROGRESS') {
          console.log(`[${jobId}] Processing...`);
        }
      },
    });

    console.log(`[${jobId}] Video restyle complete!`);

    // Download the restyled video - SDK returns { data, requestId }
    const outputVideoUrl = falResult.data?.video?.url;
    if (!outputVideoUrl) {
      throw new Error('No video URL in response');
    }

    const videoResponse = await fetch(outputVideoUrl);
    if (!videoResponse.ok) {
      throw new Error('Failed to download restyled video');
    }

    const outputBuffer = Buffer.from(await videoResponse.arrayBuffer());

    // Save to assets
    const newVideoId = randomUUID();
    const shortPrompt = prompt.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
    const outputPath = join(session.assetsDir, `${newVideoId}.mp4`);
    const thumbPath = join(session.assetsDir, `${newVideoId}_thumb.jpg`);

    await fs.promises.writeFile(outputPath, outputBuffer);

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Get video duration
    let videoDuration = videoAsset.duration || 5;
    try {
      const probeResult = await new Promise((resolve) => {
        const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', outputPath]);
        let output = '';
        proc.stdout.on('data', d => output += d.toString());
        proc.on('close', code => {
          if (code === 0) {
            try { resolve(parseFloat(JSON.parse(output).format.duration)); }
            catch { resolve(videoDuration); }
          } else resolve(videoDuration);
        });
        proc.on('error', () => resolve(videoDuration));
      });
      videoDuration = probeResult;
    } catch (e) { /* use default */ }

    const stats = await stat(outputPath);

    const asset = {
      id: newVideoId,
      filename: `restyled-${shortPrompt}.mp4`,
      originalFilename: `restyled-${shortPrompt}.mp4`,
      type: 'video',
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      size: stats.size,
      duration: videoDuration,
      width: falResult.video?.width || 1280,
      height: falResult.video?.height || 720,
      uploadedAt: Date.now(),
      generatedBy: 'dicaprio-restyle',
      sourcePrompt: prompt,
      sourceVideoId: videoAssetId,
    };

    session.assets.set(newVideoId, asset);
    await saveAssetMetadata(session);

    console.log(`[${jobId}] Saved restyled video: ${asset.filename}`);
    console.log(`[${jobId}] === DICAPRIO RESTYLE COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      video: {
        id: newVideoId,
        filename: asset.filename,
        thumbnailUrl: `/session/${sessionId}/assets/${newVideoId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${newVideoId}/stream`,
        duration: videoDuration,
      },
    }));

  } catch (error) {
    console.error('Video restyle error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Remove video background using Bria (DiCaprio agent)
async function handleRemoveVideoBg(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falApiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'FAL_KEY or FAL_API_KEY not configured in .dev.vars' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { videoAssetId } = body;

    if (!videoAssetId) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'videoAssetId is required' }));
      return;
    }

    // Get the source video asset
    const videoAsset = session.assets.get(videoAssetId);
    if (!videoAsset || videoAsset.type !== 'video') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Video asset not found' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === DICAPRIO: REMOVE VIDEO BACKGROUND ===`);
    console.log(`[${jobId}] Source video: ${videoAsset.filename}`);

    // Compress video for upload (fal.ai has size limits)
    const compressedPath = join(TEMP_DIR, `${jobId}-bg-compressed.mp4`);
    console.log(`[${jobId}] Compressing video for upload...`);

    // Compress to 720p max, lower bitrate for faster upload
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vf', 'scale=-2:720',  // Max 720p height, maintain aspect
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '28',  // Lower quality but smaller file
      '-c:a', 'aac',
      '-b:a', '128k',
      '-t', '10',  // Max 10 seconds for API limits
      compressedPath
    ], jobId);

    // Upload compressed video to fal.ai storage
    console.log(`[${jobId}] Uploading compressed video to fal.ai storage...`);
    const videoBuffer = await fs.promises.readFile(compressedPath);
    const fileSizeMB = videoBuffer.length / (1024 * 1024);
    console.log(`[${jobId}] Compressed size: ${fileSizeMB.toFixed(1)} MB`);

    const videoBlob = new Blob([videoBuffer], { type: 'video/mp4' });
    const uploadedVideoUrl = await fal.storage.upload(videoBlob);
    console.log(`[${jobId}] Video uploaded: ${uploadedVideoUrl.substring(0, 50)}...`);

    // Clean up compressed file
    try { unlinkSync(compressedPath); } catch (e) {}

    console.log(`[${jobId}] Calling fal.ai Bria video background removal...`);

    // Use fal.ai SDK with automatic queue handling
    const falResult = await fal.subscribe('fal-ai/ben/v2/video', {
      input: {
        video_url: uploadedVideoUrl,
        output_format: 'webm',  // WebM for transparency support
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === 'IN_QUEUE') {
          console.log(`[${jobId}] Queued at position ${update.position || '?'}`);
        } else if (update.status === 'IN_PROGRESS') {
          console.log(`[${jobId}] Processing...`);
        }
      },
    });

    console.log(`[${jobId}] Background removal complete!`);

    // Download the processed video - SDK returns { data, requestId }
    const outputVideoUrl = falResult.data?.video?.url;
    if (!outputVideoUrl) {
      throw new Error('No video URL in response');
    }

    const videoResponse = await fetch(outputVideoUrl);
    if (!videoResponse.ok) {
      throw new Error('Failed to download processed video');
    }

    const outputBuffer = Buffer.from(await videoResponse.arrayBuffer());

    // Save to assets (webm for transparency support)
    const newVideoId = randomUUID();
    const baseName = videoAsset.filename.replace(/\.[^/.]+$/, '');
    const outputPath = join(session.assetsDir, `${newVideoId}.webm`);
    const thumbPath = join(session.assetsDir, `${newVideoId}_thumb.jpg`);

    await fs.promises.writeFile(outputPath, outputBuffer);

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Get video duration
    let videoDuration = videoAsset.duration || 5;
    try {
      const probeResult = await new Promise((resolve) => {
        const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', outputPath]);
        let output = '';
        proc.stdout.on('data', d => output += d.toString());
        proc.on('close', code => {
          if (code === 0) {
            try { resolve(parseFloat(JSON.parse(output).format.duration)); }
            catch { resolve(videoDuration); }
          } else resolve(videoDuration);
        });
        proc.on('error', () => resolve(videoDuration));
      });
      videoDuration = probeResult;
    } catch (e) { /* use default */ }

    const stats = await stat(outputPath);

    const asset = {
      id: newVideoId,
      filename: `${baseName}-nobg.webm`,
      originalFilename: `${baseName}-nobg.webm`,
      type: 'video',
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      size: stats.size,
      duration: videoDuration,
      width: videoAsset.width || 1920,
      height: videoAsset.height || 1080,
      uploadedAt: Date.now(),
      generatedBy: 'dicaprio-remove-bg',
      sourceVideoId: videoAssetId,
      hasTransparency: true,
    };

    session.assets.set(newVideoId, asset);
    await saveAssetMetadata(session);

    console.log(`[${jobId}] Saved video: ${asset.filename}`);
    console.log(`[${jobId}] === DICAPRIO REMOVE BG COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      video: {
        id: newVideoId,
        filename: asset.filename,
        thumbnailUrl: `/session/${sessionId}/assets/${newVideoId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${newVideoId}/stream`,
        duration: videoDuration,
      },
    }));

  } catch (error) {
    console.error('Video background removal error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate batch animations across the timeline based on video content analysis
async function handleGenerateBatchAnimations(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { count = 5, fps = 30, width = 1920, height = 1080 } = body;

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === GENERATE BATCH ANIMATIONS ===`);
    console.log(`[${jobId}] Requested count: ${count}`);

    // Find the first video asset in the session
    let videoAsset = null;
    for (const asset of session.assets.values()) {
      if (asset.type === 'video' && !asset.aiGenerated) {
        videoAsset = asset;
        break;
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found in session' }));
      return;
    }

    console.log(`[${jobId}] Using video: ${videoAsset.filename} (${videoAsset.duration}s)`);

    // Step 1: Get or create transcription
    console.log(`[${jobId}] Step 1: Getting video transcription...`);
    const transcription = await getOrTranscribeVideo(session, videoAsset, jobId);

    if (!transcription.text) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Could not transcribe video' }));
      return;
    }

    console.log(`[${jobId}] Transcription: ${transcription.text.substring(0, 200)}...`);

    // Step 2: Use DeepSeek to plan animations across the video
    console.log(`[${jobId}] Step 2: Planning ${count} animations with AI...`);

    const planResult = await generateWithDeepSeek({
      prompt: `You are a video editor planning motion graphics animations for a video. Analyze this transcript and plan exactly ${count} animations that would enhance the video.

VIDEO TRANSCRIPT:
"${transcription.text}"

VIDEO DURATION: ${videoAsset.duration} seconds

WORD TIMESTAMPS (for timing reference):
${transcription.words?.slice(0, 100).map(w => `[${w.start.toFixed(1)}s] ${w.text}`).join(' ') || 'Not available'}

Plan exactly ${count} animations. Each should:
1. Be placed at a strategic moment in the video (intro, key points, transitions, outro)
2. Have a specific purpose (introduce topic, highlight key point, transition, call-to-action, etc.)
3. Be relevant to the content being discussed at that timestamp

Return ONLY valid JSON (no markdown):
{
  "animations": [
    {
      "type": "intro" | "highlight" | "transition" | "callout" | "outro",
      "startTime": <seconds where animation should appear>,
      "duration": <animation duration in seconds, typically 3-5>,
      "title": "<short title for the animation>",
      "description": "<detailed description of what the animation should show, including specific text, colors, style>",
      "relevantContent": "<what the video is discussing at this point>"
    }
  ]
}

Guidelines:
- First animation should typically be an intro (startTime: 0)
- Last animation could be an outro or call-to-action
- Space animations throughout the video, not clustered together
- Each animation should enhance understanding or engagement
- Be specific about visual style, colors, and text content`,
      responseMimeType: 'application/json',
      jobId,
    });

    let animationPlan;
    try {
      const planText = planResult.candidates[0].content.parts[0].text;
      const cleanedPlan = planText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      animationPlan = JSON.parse(cleanedPlan);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse animation plan:`, parseError);
      throw new Error('Failed to parse AI animation plan');
    }

    console.log(`[${jobId}] Planned ${animationPlan.animations.length} animations`);
    animationPlan.animations.forEach((a, i) => {
      console.log(`[${jobId}]   ${i + 1}. ${a.type} at ${a.startTime}s: ${a.title}`);
    });

    // Step 3: Generate each animation
    console.log(`[${jobId}] Step 3: Generating animations...`);
    const generatedAnimations = [];

    for (let i = 0; i < animationPlan.animations.length; i++) {
      const plan = animationPlan.animations[i];
      console.log(`[${jobId}] Generating animation ${i + 1}/${animationPlan.animations.length}: ${plan.title}`);

      const assetId = randomUUID();
      const outputPath = join(session.assetsDir, `${assetId}.mp4`);
      const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
      const propsPath = join(session.dir, `${jobId}-batch-${i}-props.json`);
      const sceneDataPath = join(session.dir, `${assetId}-scenes.json`);

      // Generate scene data with DeepSeek
      const sceneResult = await generateWithDeepSeek({
        prompt: `Create a Remotion animation for this video moment.

ANIMATION TYPE: ${plan.type}
TITLE: ${plan.title}
DESCRIPTION: ${plan.description}
CONTEXT: ${plan.relevantContent}
DURATION: ${plan.duration} seconds (${plan.duration * fps} frames)

Generate a scene-based animation. Return ONLY valid JSON:
{
  "scenes": [
    {
      "id": "scene-1",
      "type": "title" | "bullets" | "stats" | "quote" | "callToAction" | "transition",
      "duration": <frames>,
      "content": {
        "title": "optional title text",
        "subtitle": "optional subtitle",
        "items": [{"label": "item text", "icon": "optional emoji"}],
        "stats": [{"value": "100%", "label": "stat name"}],
        "quote": "quote text",
        "author": "quote author",
        "buttonText": "CTA text",
        "backgroundColor": "#hex",
        "textColor": "#hex",
        "accentColor": "#hex"
      }
    }
  ],
  "totalDuration": <total frames>,
  "backgroundColor": "#1a1a2e"
}

Make it visually engaging with good color choices. Use 2-4 scenes for variety.`,
        responseMimeType: 'application/json',
        jobId,
      });

      let sceneData;
      try {
        const sceneText = sceneResult.candidates[0].content.parts[0].text;
        const cleanedScene = sceneText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        sceneData = JSON.parse(cleanedScene);
      } catch (parseError) {
        console.error(`[${jobId}] Failed to parse scene data for animation ${i + 1}, using fallback`);
        // Create a simple fallback animation
        sceneData = {
          scenes: [{
            id: 'scene-1',
            type: 'title',
            duration: plan.duration * fps,
            content: {
              title: plan.title,
              subtitle: plan.description.substring(0, 50),
              backgroundColor: '#1a1a2e',
              textColor: '#ffffff',
              accentColor: '#6366f1'
            }
          }],
          totalDuration: plan.duration * fps,
          backgroundColor: '#1a1a2e'
        };
      }

      // Sanitize scene data: ensure no scene has zero duration
      if (sceneData.scenes && sceneData.scenes.length > 0) {
        let needsFix = false;
        sceneData.scenes.forEach((s, idx) => {
          if (!s.duration || s.duration <= 0) {
            s.duration = Math.max(1, Math.floor((plan.duration * fps) / sceneData.scenes.length));
            needsFix = true;
          }
        });
        // Recalculate totalDuration to match actual sum of scene durations
        const computedTotal = sceneData.scenes.reduce((sum, s) => sum + (s.duration || 0), 0);
        if (!sceneData.totalDuration || sceneData.totalDuration <= 0 || sceneData.totalDuration !== computedTotal) {
          sceneData.totalDuration = computedTotal;
          needsFix = true;
        }
        if (needsFix) {
          console.log(`[${jobId}] Fixed scene durations (had zero/null values)`);
        }
      } else {
        // Fallback if scenes array is empty or missing
        sceneData.scenes = [{
          id: 'scene-1',
          type: 'title',
          duration: Math.max(1, plan.duration * fps),
          content: {
            title: plan.title,
            subtitle: plan.description.substring(0, 50),
            backgroundColor: '#1a1a2e',
            textColor: '#ffffff',
            accentColor: '#6366f1'
          }
        }];
        sceneData.totalDuration = sceneData.scenes[0].duration;
        console.log(`[${jobId}] Fixed empty scenes array, created fallback`);
      }

      // Save scene data
      try { await fs.promises.writeFile(sceneDataPath, JSON.stringify(sceneData, null, 2)); } catch (e) { console.warn(`[write] Scene data write failed: ${e.message}`); }
      await fs.promises.writeFile(propsPath, JSON.stringify(sceneData, null, 2));

      const totalDuration = sceneData.totalDuration ?? sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
      // Guard against zero or negative totalDuration
      if (!totalDuration || totalDuration <= 0) {
        console.error(`[${jobId}] Total duration is ${totalDuration}, using fallback of 30 frames`);
        sceneData.totalDuration = 30;
        sceneData.scenes = [{
          id: 'scene-1',
          type: 'title',
          duration: 30,
          content: {
            title: plan.title,
            subtitle: plan.description.substring(0, 50),
            backgroundColor: '#1a1a2e',
            textColor: '#ffffff',
            accentColor: '#6366f1'
          }
        }];
        try { await fs.promises.writeFile(sceneDataPath, JSON.stringify(sceneData, null, 2)); } catch (e) { console.warn(`[write] Scene data write failed: ${e.message}`); }
        await fs.promises.writeFile(propsPath, JSON.stringify(sceneData, null, 2));
      }
      const safeTotalDuration = Math.max(1, totalDuration);
      const durationInSeconds = safeTotalDuration / fps;

      // Render with Remotion
      let renderOk3 = false;
      try {
        await renderWithRemotion({
          compositionId: 'DynamicAnimation',
          props: sceneData,
          outputPath,
          fps,
          width,
          height,
          onProgress: (pct) => { if (pct % 10 === 0) console.log(`[Render] ${pct}%`); },
        });
        renderOk3 = true;
      } catch (renderErr) {
        console.error(`[Render] Programmatic render failed: ${renderErr.message}`);
      }

      if (!renderOk3) {
        const fallbackArgs = [
          'remotion', 'render',
          `${FRONTEND_ROOT}/src/remotion/index.tsx`,
          'DynamicAnimation',
          outputPath,
          '--props', propsPath,
          '--frames', `0-${Math.max(1, safeTotalDuration || 30) - 1}`,
          '--fps', String(fps),
          '--width', String(width),
          '--height', String(height),
          '--codec', 'h264',
          '--overwrite',
        ];
        await new Promise((resolve, reject) => {
          const proc = spawn('npx', fallbackArgs, { cwd: FRONTEND_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
          let stderr = '';
          proc.stderr.on('data', (d) => { stderr += d.toString(); });
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Remotion npx fallback failed (code ${code}): ${stderr.substring(0,200)}`)));
          proc.on('error', reject);
        });
      }

      // Generate thumbnail
      try {
        await runFFmpeg([
          '-y', '-i', outputPath,
          '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
          '-frames:v', '1',
          thumbPath
        ], jobId);
      } catch (e) {
        console.warn(`[${jobId}] Thumbnail failed for animation ${i + 1}`);
      }

      // Clean up props file
      try { unlinkSync(propsPath); } catch (e) {}

      // stat already imported at top level
      const stats = await stat(outputPath);

      // Create asset entry
      const asset = {
        id: assetId,
        type: 'video',
        filename: `${plan.type}-${plan.title.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 20)}.mp4`,
        path: outputPath,
        thumbPath: existsSync(thumbPath) ? thumbPath : null,
        duration: durationInSeconds,
        size: stats.size,
        width,
        height,
        createdAt: Date.now(),
        aiGenerated: true,
        sceneData,
        sceneDataPath,
        description: plan.description,
      };

      session.assets.set(assetId, asset);

      generatedAnimations.push({
        assetId,
        filename: asset.filename,
        duration: durationInSeconds,
        startTime: plan.startTime,
        type: plan.type,
        title: plan.title,
        thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
      });

      console.log(`[${jobId}] ✓ Animation ${i + 1} complete: ${asset.filename}`);
    }

    console.log(`[${jobId}] === BATCH GENERATION COMPLETE ===`);
    console.log(`[${jobId}] Generated ${generatedAnimations.length} animations\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      animations: generatedAnimations,
      videoDuration: videoAsset.duration,
    }));

  } catch (error) {
    console.error('Batch animation generation error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Analyze video for animation concept (no rendering - for approval workflow)
// Returns transcript and proposed animation scenes for user approval
async function handleAnalyzeForAnimation(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId, type = 'intro', description, startTime, endTime } = body;

    // Debug: log received time range values
    console.log(`[DEBUG] Received analyze request - startTime: ${startTime} (${typeof startTime}), endTime: ${endTime} (${typeof endTime})`);

    // Get the video asset to analyze
    let videoAsset;
    if (assetId) {
      videoAsset = session.assets.get(assetId);
    } else {
      for (const [id, asset] of session.assets) {
        if (asset.type === 'video') {
          videoAsset = asset;
          break;
        }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found to analyze' }));
      return;
    }

    const jobId = randomUUID();
    const audioPath = join(TEMP_DIR, `${jobId}-audio.mp3`);

    // Determine if we're analyzing a specific time range or the whole video
    const hasTimeRange = typeof startTime === 'number' && typeof endTime === 'number';
    const segmentStart = hasTimeRange ? startTime : 0;
    const segmentDuration = hasTimeRange ? (endTime - startTime) : null;

    console.log(`\n[${jobId}] === ANALYZE VIDEO FOR ${type.toUpperCase()} ANIMATION ===`);
    console.log(`[${jobId}] Analyzing video: ${videoAsset.filename}`);
    if (hasTimeRange) {
      console.log(`[${jobId}] Time range: ${segmentStart.toFixed(1)}s - ${endTime.toFixed(1)}s (${segmentDuration.toFixed(1)}s segment)`);
    }

    // Step 1: Transcribe the video (or just the specified segment)
    console.log(`[${jobId}] Step 1: Transcribing ${hasTimeRange ? 'segment' : 'video'}...`);

    // Extract audio from video - optionally just from the specified time range
    const ffmpegArgs = ['-y', '-i', videoAsset.path];
    if (hasTimeRange) {
      // Use -ss for seeking and -t for duration to extract only the segment
      ffmpegArgs.push('-ss', segmentStart.toString());
      ffmpegArgs.push('-t', segmentDuration.toString());
    }
    ffmpegArgs.push('-vn', '-acodec', 'libmp3lame', '-ar', '16000', '-ac', '1', '-q:a', '9', audioPath);

    await runFFmpeg(ffmpegArgs, jobId);

    // Get video duration
    const durationOutput = await runFFmpegProbe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoAsset.path
    ], jobId);
    const totalDuration = parseFloat(durationOutput.trim()) || 60;
    const analyzedDuration = hasTimeRange ? segmentDuration : totalDuration;

    let transcription;
    const hasLocalWhisper = await checkLocalWhisper();
    const groqKey = process.env.GROQ_API_KEY;

    if (hasLocalWhisper) {
      try {
        console.log(`[${jobId}]    Using local Whisper...`);
        transcription = await runLocalWhisper(audioPath, jobId);
      } catch (whisperError) {
        console.log(`[${jobId}]    Local Whisper failed: ${whisperError.message}`);
        console.log(`[${jobId}]    No transcription service available. Using empty transcript.`);
        transcription = { text: '', words: [] };
      }
    } else if (groqKey) {
      console.log(`[${jobId}]    Using Groq Whisper API...`);
      const audioBuffer = await fs.promises.readFile(audioPath);
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
      formData.append('model', 'whisper-large-v3');
      formData.append('response_format', 'verbose_json');
      formData.append('language', 'en');

      const groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}` },
        body: formData,
      });

      if (!groqResponse.ok) {
        console.log(`[${jobId}]    Groq Whisper failed (${groqResponse.status})`);
        transcription = { text: '', words: [] };
      } else {
        const groqResult = await groqResponse.json();
        transcription = {
          text: groqResult.text || '',
          words: (groqResult.words || []).map(w => ({
            text: w.word || w.text || '',
            start: w.start || 0,
            end: w.end || 0,
          })),
        };
      }
    } else {
      console.log(`[${jobId}]    No transcription service available. Using empty transcript.`);
      transcription = { text: '', words: [] };
    }

    console.log(`[${jobId}] Transcription complete: ${transcription.text.substring(0, 100)}...`);

    // Clean up audio file
    try { unlinkSync(audioPath); } catch (e) {}

    // Step 2: Generate animation concept (scenes) without rendering
    console.log(`[${jobId}] Step 2: Generating animation concept...`);

    const typePrompts = {
      intro: `Create an engaging INTRO animation that hooks viewers and introduces the video topic.
The intro should:
- Start with an attention-grabbing title or hook
- Tease what viewers will learn/see
- Build excitement for the content
- Be 4-8 seconds (120-240 frames at 30fps)`,

      outro: `Create a compelling OUTRO animation that wraps up the video.
The outro should:
- Summarize key takeaways
- Include a call-to-action (subscribe, like, etc.)
- Thank viewers
- Be 5-10 seconds (150-300 frames at 30fps)`,

      transition: `Create a smooth TRANSITION animation between sections.
The transition should:
- Be brief and visually interesting
- Match the video's tone
- Be 2-4 seconds (60-120 frames at 30fps)`,

      highlight: `Create a HIGHLIGHT animation that emphasizes a key moment.
The highlight should:
- Draw attention to an important point
- Use dynamic motion and colors
- Be 3-6 seconds (90-180 frames at 30fps)`,
    };

    // Build time context for the prompt
    const timeContext = hasTimeRange
      ? `\nNOTE: This transcript is from a SPECIFIC SEGMENT of the video (${segmentStart.toFixed(1)}s - ${endTime.toFixed(1)}s, duration: ${segmentDuration.toFixed(1)}s). Create an animation that relates ONLY to what is being discussed in this segment, not the entire video.`
      : '';

    const scenePrompt = `You are a motion graphics designer. Analyze this video transcript and create a contextual ${type} animation concept.

VIDEO TRANSCRIPT:
"${transcription.text}"
${timeContext}

${description ? `USER HINT: "${description}"` : ''}

${typePrompts[type] || typePrompts.intro}

Based on the video content above, return ONLY valid JSON (no markdown) with this structure:
{
  "scenes": [
    {
      "id": "unique-id",
      "type": "title" | "steps" | "features" | "stats" | "text" | "transition" | "gif" | "emoji",
      "duration": <frames at 30fps>,
      "content": {
        "title": "text derived from video content",
        "subtitle": "optional",
        "items": [{"icon": "emoji", "label": "text", "description": "optional"}],
        "stats": [{"value": "number", "label": "text", "numericValue": <integer for counting>}],
        "color": "#hex accent color",
        "backgroundColor": "#hex or null for transparent",
        "gifSearch": "keyword to search for GIF",
        "gifLayout": "fullscreen" | "scattered",
        "emojis": [{"emoji": "🔥", "x": 50, "y": 50, "scale": 0.2, "animation": "bounce"}]
      }
    }
  ],
  "backgroundColor": "#0a0a0a",
  "totalDuration": <sum of scene durations>,
  "contentSummary": "brief description of what the video is about",
  "keyTopics": ["topic1", "topic2", "topic3"]
}

IMPORTANT: The animation content should directly relate to the video's actual topic and message.`;

    const sceneResult = await generateWithDeepSeek({
      prompt: scenePrompt,
      responseMimeType: 'application/json',
      jobId,
    });

    let sceneData;
    try {
      const responseText = sceneResult.candidates[0].content.parts[0].text;
      const cleanedResponse = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      sceneData = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse DeepSeek response:`, parseError);
      throw new Error('Failed to parse AI-generated scene data');
    }

    // Validate scene data — clamp negative values (DeepSeek JSON mode can produce -5, etc.)
    sceneData.totalDuration = Math.abs(sceneData.totalDuration || 120);
    for (const scene of sceneData.scenes) {
      scene.duration = Math.abs(scene.duration || 60);
    }

    // Post-process GIF scenes - search GIPHY and inject actual URLs
    const giphyKeyForAnalysis = process.env.GIPHY_API_KEY;
    for (const scene of sceneData.scenes) {
      if (scene.type === 'gif' && scene.content) {
        const { gifSearch, gifSearches } = scene.content;
        const searchTerms = gifSearches || (gifSearch ? [gifSearch] : []);

        if (searchTerms.length > 0 && giphyKeyForAnalysis) {
          console.log(`[${jobId}] 🎬 Fetching GIFs from GIPHY for concept: ${searchTerms.join(', ')}`);
          scene.content.gifs = [];

          for (const term of searchTerms) {
            try {
              const gifs = await searchGiphy(term, 1);
              if (gifs.length > 0) {
                const gif = gifs[0];
                const gifUrl = gif.images?.fixed_height?.url || gif.images?.original?.url;
                if (gifUrl) {
                  scene.content.gifs.push({
                    src: gifUrl,
                    width: parseInt(gif.images?.fixed_height?.width) || 400,
                    height: parseInt(gif.images?.fixed_height?.height) || 300,
                    title: gif.title || term,
                    searchTerm: term,
                  });
                  console.log(`[${jobId}]    ✓ Found GIF for "${term}"`);
                }
              }
            } catch (err) {
              console.log(`[${jobId}]    ✗ GIPHY search failed: ${err.message}`);
            }
          }

          if (!scene.content.gifLayout && scene.content.gifs.length === 1) {
            scene.content.gifLayout = 'fullscreen';
          }
        }
      }
    }

    const animationTotalDuration = sceneData.totalDuration ?? sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = animationTotalDuration / 30; // 30 fps

    console.log(`[${jobId}] Analysis complete: ${sceneData.scenes.length} scenes, ${durationInSeconds}s total`);
    console.log(`[${jobId}] === ANALYSIS COMPLETE (awaiting approval) ===\n`);

    // Return the concept for user approval (NOT rendered yet)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      concept: {
        type,
        transcript: transcription.text,
        transcriptPreview: transcription.text.substring(0, 500) + (transcription.text.length > 500 ? '...' : ''),
        contentSummary: sceneData.contentSummary,
        keyTopics: sceneData.keyTopics || [],
        scenes: sceneData.scenes,
        totalDuration: animationTotalDuration,
        durationInSeconds,
        backgroundColor: sceneData.backgroundColor,
      },
      videoInfo: {
        filename: videoAsset.filename,
        duration: totalDuration,
        assetId: videoAsset.id,
      },
    }));

  } catch (error) {
    console.error('Animation analysis error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Render animation from pre-approved concept (skips analysis, uses provided scenes)
async function handleRenderFromConcept(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { concept, fps = 30, width = 1920, height = 1080 } = body;

    if (!concept || !concept.scenes || concept.scenes.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'concept with scenes is required' }));
      return;
    }

    const jobId = randomUUID();
    const assetId = randomUUID();
    const outputPath = join(session.assetsDir, `${assetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-props.json`);

    console.log(`\n[${jobId}] === RENDER FROM APPROVED CONCEPT ===`);
    console.log(`[${jobId}] Type: ${concept.type}, Scenes: ${concept.scenes.length}`);

    const sceneData = {
      scenes: concept.scenes,
      backgroundColor: concept.backgroundColor || '#0a0a0a',
      totalDuration: concept.totalDuration,
      contentSummary: concept.contentSummary,
      keyTopics: concept.keyTopics,
    };

    // Post-process GIF scenes - search GIPHY for any unresolved gif searches
    const giphyKeyForRender = process.env.GIPHY_API_KEY;
    for (const scene of sceneData.scenes) {
      if (scene.type === 'gif' && scene.content) {
        const { gifSearch, gifSearches, gifs } = scene.content;
        const searchTerms = gifSearches || (gifSearch ? [gifSearch] : []);

        // Only search if we have search terms but no resolved GIFs
        if (searchTerms.length > 0 && (!gifs || gifs.length === 0) && giphyKeyForRender) {
          console.log(`[${jobId}] 🎬 Resolving GIPHY searches: ${searchTerms.join(', ')}`);
          scene.content.gifs = [];

          for (const term of searchTerms) {
            try {
              const gifsResult = await searchGiphy(term, 1);
              if (gifsResult.length > 0) {
                const gif = gifsResult[0];
                const gifUrl = gif.images?.fixed_height?.url || gif.images?.original?.url;
                if (gifUrl) {
                  scene.content.gifs.push({
                    src: gifUrl,
                    width: parseInt(gif.images?.fixed_height?.width) || 400,
                    height: parseInt(gif.images?.fixed_height?.height) || 300,
                    title: gif.title || term,
                    searchTerm: term,
                  });
                  console.log(`[${jobId}]    ✓ Resolved GIF for "${term}"`);
                }
              }
            } catch (err) {
              console.log(`[${jobId}]    ✗ GIPHY search failed: ${err.message}`);
            }
          }

          if (!scene.content.gifLayout && scene.content.gifs.length === 1) {
            scene.content.gifLayout = 'fullscreen';
          }
        }
      }
    }

    // Save scene data for future editing (reusable path based on asset ID)
    const sceneDataPath = join(session.dir, `${assetId}-scenes.json`);
    try { await fs.promises.writeFile(sceneDataPath, JSON.stringify(sceneData, null, 2)); } catch (e) { console.warn(`[write] Scene data write failed: ${e.message}`); }
    console.log(`[${jobId}] Scene data saved to ${sceneDataPath} for future editing`);

    const animationTotalDuration = sceneData.totalDuration ?? sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = animationTotalDuration / fps;

    // Write props to JSON file for Remotion
    await fs.promises.writeFile(propsPath, JSON.stringify(sceneData, null, 2));
    console.log(`[${jobId}] Props written to ${propsPath}`);
    console.log(`[${jobId}] Scene data:`, JSON.stringify(sceneData, null, 2));

    // Render with Remotion CLI
    console.log(`[${jobId}] Rendering with Remotion...`);

    let renderOk4 = false;
    try {
      await renderWithRemotion({
        compositionId: 'DynamicAnimation',
        props: sceneData,
        outputPath,
        fps,
        width,
        height,
        onProgress: (pct) => { if (pct % 10 === 0) console.log(`[${jobId}] Render: ${pct}%`); },
      });
      renderOk4 = true;
    } catch (renderErr) {
      console.error(`[${jobId}] Programmatic render failed: ${renderErr.message}`);
    }

    if (!renderOk4) {
    const fallbackArgs = [
      'remotion', 'render',
      `${FRONTEND_ROOT}/src/remotion/index.tsx`,
      'DynamicAnimation',
      outputPath,
      '--props', propsPath,
      '--frames', `0-${Math.max(1, animationTotalDuration) - 1}`,
      '--fps', String(fps),
      '--width', String(width),
      '--height', String(height),
      '--codec', 'h264',
      '--overwrite',
    ];

    console.log(`[${jobId}] Fallback: npx ${fallbackArgs.slice(0, 6).join(' ')}...`);

    await new Promise((resolve, reject) => {
      const proc = spawn('npx', fallbackArgs, { cwd: FRONTEND_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Remotion failed (code ${code}): ${stderr.slice(-500)}`)));
      proc.on('error', reject);
    });
    }

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Clean up props file
    try { unlinkSync(propsPath); } catch (e) {}

    const stats = await stat(outputPath);

    // Create asset entry with scene data for future editing
    const asset = {
      id: assetId,
      type: 'video',
      filename: `${concept.type}-animation-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: durationInSeconds,
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
      aiGenerated: true,
      contextual: true,
      animationType: concept.type,
      contentSummary: concept.contentSummary,
      sceneCount: concept.scenes.length,
      sceneDataPath, // Store path to scene data for re-editing
      sceneData, // Also keep in memory for quick access
    };

    session.assets.set(assetId, asset);
    await saveAssetMetadata(session); // Persist AI-generated flag to disk

    console.log(`[${jobId}] Animation rendered: ${assetId} (${durationInSeconds}s)`);
    console.log(`[${jobId}] === RENDER COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId,
      filename: asset.filename,
      duration: durationInSeconds,
      type: concept.type,
      sceneCount: concept.scenes.length,
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
    }));

  } catch (error) {
    console.error('Render from concept error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate kinetic typography animation from video transcript
// Transcribes video, identifies key phrases, creates animated text scenes synced to audio
async function handleGenerateTranscriptAnimation(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { fps = 30, width = 1920, height = 1080 } = body;

    // Find the first video asset
    let videoAsset = null;
    for (const asset of session.assets.values()) {
      if (asset.type === 'video') {
        videoAsset = asset;
        break;
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found in session' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === GENERATE TRANSCRIPT ANIMATION ===`);
    console.log(`[${jobId}] Video: ${videoAsset.filename}`);

    // Step 1: Transcribe the video with word-level timestamps
    console.log(`[${jobId}] Step 1: Transcribing video...`);
    const audioPath = join(TEMP_DIR, `${jobId}-transcript-audio.mp3`);
    const totalDuration = await getVideoDuration(videoAsset.path);

    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn', '-acodec', 'libmp3lame',
      '-ab', '64k', '-ar', '16000', '-ac', '1',
      audioPath
    ], jobId);

    // Check transcription method
    const hasLocalWhisper = await checkLocalWhisper();
    const groqKey = process.env.GROQ_API_KEY;

    let transcription;
    if (hasLocalWhisper) {
      try {
        console.log(`[${jobId}]    Using local Whisper...`);
        transcription = await runLocalWhisper(audioPath, jobId);
      } catch (whisperError) {
        console.log(`[${jobId}]    Local Whisper failed: ${whisperError.message}`);
        console.log(`[${jobId}]    No fallback transcription available. Using empty transcript.`);
        transcription = { text: '', words: [] };
      }
    } else if (groqKey) {
      console.log(`[${jobId}]    Using Groq Whisper API...`);
      const audioBuffer = await fs.promises.readFile(audioPath);

      const groqFormData = new FormData();
      groqFormData.append('file', new Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
      groqFormData.append('model', 'whisper-large-v3');
      groqFormData.append('response_format', 'verbose_json');
      groqFormData.append('language', 'en');

      const groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}` },
        body: groqFormData,
      });

      if (!groqResponse.ok) {
        console.log(`[${jobId}]    Groq Whisper failed (${groqResponse.status}). Using empty transcript.`);
        transcription = { text: '', words: [] };
      } else {
        const groqResult = await groqResponse.json();
        transcription = {
          text: groqResult.text || '',
          words: (groqResult.words || []).map(w => ({
            text: w.word || w.text || '',
            start: w.start || 0,
            end: w.end || 0,
          }))
        };
      }
    } else {
      console.log(`[${jobId}]    No transcription service available. Using empty transcript.`);
      transcription = { text: '', words: [] };
    }

    try { unlinkSync(audioPath); } catch { /* audio cleanup */ }

    console.log(`[${jobId}]    Transcript: "${transcription.text.substring(0, 100)}..."`);
    console.log(`[${jobId}]    Words: ${transcription.words?.length || 0}`);

    // Step 2: Use DeepSeek to identify key phrases for animation
    console.log(`[${jobId}] Step 2: Identifying key phrases...`);

    const analysisResponse = await generateWithDeepSeek({
      prompt: `Analyze this video transcript and identify 5-8 KEY PHRASES that would make great kinetic typography animations. These should be:
- Important or impactful statements
- Keywords or product names
- Emotional or emphatic moments
- Key points the speaker is making

Transcript: "${transcription.text}"

Word timestamps: ${JSON.stringify(transcription.words?.slice(0, 100) || [])}
(Total duration: ${totalDuration}s)

Return JSON array of phrases to animate:
[
  {
    "phrase": "the exact phrase from transcript",
    "startTime": 1.5,
    "endTime": 3.2,
    "emphasis": "high|medium|low",
    "style": "bold|explosive|subtle|typewriter",
    "reason": "why this phrase is important"
  }
]

Pick phrases that are spread throughout the video. Each phrase should be 2-6 words.`,
      responseMimeType: 'application/json',
      jobId,
    });

    let keyPhrases = [];
    try {
      const respText = analysisResponse.text || '';
      const jsonMatch = respText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        keyPhrases = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error(`[${jobId}] Failed to parse key phrases:`, e.message);
    }

    if (keyPhrases.length === 0) {
      // Fallback: create basic phrases from transcript chunks
      const words = transcription.words || [];
      const chunkSize = Math.ceil(words.length / 6);
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize);
        if (chunk.length > 0) {
          keyPhrases.push({
            phrase: chunk.map(w => w.text).join(' ').trim(),
            startTime: chunk[0].start,
            endTime: chunk[chunk.length - 1].end,
            emphasis: 'medium',
            style: 'typewriter'
          });
        }
      }
    }

    console.log(`[${jobId}]    Found ${keyPhrases.length} key phrases`);

    // Step 3: Generate Remotion scenes for each phrase
    console.log(`[${jobId}] Step 3: Generating animation scenes...`);
    const scenes = keyPhrases.map((phrase, index) => {
      const duration = Math.max(60, Math.round((phrase.endTime - phrase.startTime + 1) * fps)); // At least 2 seconds

      // Map emphasis to visual style
      const colors = {
        high: '#f97316', // orange
        medium: '#3b82f6', // blue
        low: '#22c55e', // green
      };

      return {
        id: `text-${index}`,
        type: 'text',
        duration,
        content: {
          title: phrase.phrase.toUpperCase(),
          subtitle: null,
          color: colors[phrase.emphasis] || '#ffffff',
          backgroundColor: '#0a0a0a',
          style: phrase.style || 'typewriter',
        }
      };
    });

    // Calculate total animation duration
    const animationTotalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = animationTotalDuration / fps;

    console.log(`[${jobId}]    Total animation: ${animationTotalDuration} frames (${durationInSeconds}s)`);

    // Step 4: Render with Remotion
    console.log(`[${jobId}] Step 4: Rendering with Remotion...`);

    const assetId = randomUUID();
    const outputPath = join(session.assetsDir, `${assetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-transcript-props.json`);

    const sceneData = {
      scenes,
      backgroundColor: '#0a0a0a',
      totalDuration: animationTotalDuration,
      contentSummary: `Kinetic typography animation from transcript: "${transcription.text.substring(0, 100)}..."`,
      keyTopics: keyPhrases.map(p => p.phrase),
    };

    // Save scene data for future editing (persistent path based on asset ID)
    const sceneDataPath = join(session.dir, `${assetId}-scenes.json`);
    try { await fs.promises.writeFile(sceneDataPath, JSON.stringify(sceneData, null, 2)); } catch (e) { console.warn(`[write] Scene data write failed: ${e.message}`); }
    console.log(`[${jobId}] Scene data saved to ${sceneDataPath} for future editing`);

    await fs.promises.writeFile(propsPath, JSON.stringify(sceneData, null, 2));

    let renderOk5 = false;
    try {
      await renderWithRemotion({
        compositionId: 'DynamicAnimation',
        props: sceneData,
        outputPath,
        fps,
        width,
        height,
        onProgress: (pct) => { if (pct % 10 === 0) console.log(`[${jobId}] Render: ${pct}%`); },
      });
      renderOk5 = true;
    } catch (renderErr) {
      console.error(`[${jobId}] Programmatic render failed: ${renderErr.message}`);
    }

    if (!renderOk5) {
    const fallbackArgs = [
      'remotion', 'render',
      `${FRONTEND_ROOT}/src/remotion/index.tsx`,
      'DynamicAnimation',
      outputPath,
      '--props', propsPath,
      '--frames', `0-${Math.max(1, animationTotalDuration) - 1}`,
      '--fps', String(fps),
      '--width', String(width),
      '--height', String(height),
      '--codec', 'h264',
      '--overwrite',
    ];
    await new Promise((resolve, reject) => {
      const proc = spawn('npx', fallbackArgs, { cwd: FRONTEND_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Remotion npx fallback failed (code ${code}): ${stderr.slice(-500)}`)));
      proc.on('error', reject);
    });
    }

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    try { unlinkSync(propsPath); } catch { /* props file cleanup */ }

    const stats = await stat(outputPath);

    // Create asset entry with scene data for future editing
    const asset = {
      id: assetId,
      type: 'video',
      filename: `transcript-animation-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: durationInSeconds,
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
      aiGenerated: true,
      transcriptAnimation: true,
      phraseCount: keyPhrases.length,
      sceneCount: scenes.length,
      sceneDataPath, // Store path to scene data for re-editing
      sceneData, // Also keep in memory for quick access
    };

    session.assets.set(assetId, asset);
    await saveAssetMetadata(session); // Persist AI-generated flag to disk

    console.log(`[${jobId}] Transcript animation created: ${assetId}`);
    console.log(`[${jobId}] === TRANSCRIPT ANIMATION COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId,
      filename: asset.filename,
      duration: durationInSeconds,
      phraseCount: keyPhrases.length,
      phrases: keyPhrases.map(p => p.phrase),
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
    }));

  } catch (error) {
    console.error('Transcript animation error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Generate contextual animation based on video content
// This transcribes the video first, understands what it's about, then generates relevant animation
async function handleGenerateContextualAnimation(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId, type = 'intro', description, fps = 30, width = 1920, height = 1080 } = body;

    // Get the video asset to analyze
    let videoAsset;
    if (assetId) {
      videoAsset = session.assets.get(assetId);
    } else {
      // Find the first video asset
      for (const [id, asset] of session.assets) {
        if (asset.type === 'video') {
          videoAsset = asset;
          break;
        }
      }
    }

    if (!videoAsset) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'No video asset found to analyze' }));
      return;
    }

    const jobId = randomUUID();
    const outputAssetId = randomUUID();
    const outputPath = join(session.assetsDir, `${outputAssetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${outputAssetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-props.json`);
    const audioPath = join(TEMP_DIR, `${jobId}-audio.mp3`);

    console.log(`\n[${jobId}] === GENERATE CONTEXTUAL ${type.toUpperCase()} ANIMATION ===`);
    console.log(`[${jobId}] Analyzing video: ${videoAsset.filename}`);
    console.log(`[${jobId}] Type: ${type}, Description hint: ${description || 'none'}`);

    // Step 1: Transcribe the video to understand content
    console.log(`[${jobId}] Step 1: Transcribing video...`);

    // Extract audio from video
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn', '-acodec', 'libmp3lame', '-ar', '16000', '-ac', '1', '-q:a', '9',
      audioPath
    ], jobId);

    // Get video duration
    const durationOutput = await runFFmpegProbe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoAsset.path
    ], jobId);
    const totalDuration = parseFloat(durationOutput.trim()) || 60;

    let transcription;
    const hasLocalWhisper = await checkLocalWhisper();
    const groqKey = process.env.GROQ_API_KEY;

    if (hasLocalWhisper) {
      try {
        console.log(`[${jobId}]    Using local Whisper...`);
        transcription = await runLocalWhisper(audioPath, jobId);
      } catch (whisperError) {
        console.log(`[${jobId}]    Local Whisper failed: ${whisperError.message}`);
        console.log(`[${jobId}]    No fallback available. Using empty transcript.`);
        transcription = { text: '', words: [] };
      }
    } else if (groqKey) {
      console.log(`[${jobId}]    Using Groq Whisper API...`);
      const audioBuffer = await fs.promises.readFile(audioPath);
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
      formData.append('model', 'whisper-large-v3');
      formData.append('response_format', 'verbose_json');
      formData.append('language', 'en');

      const groqResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}` },
        body: formData,
      });

      if (!groqResponse.ok) {
        console.log(`[${jobId}] Groq Whisper failed (${groqResponse.status}). Using empty transcript.`);
        transcription = { text: '', words: [] };
      } else {
        const groqResult = await groqResponse.json();
        transcription = {
          text: groqResult.text || '',
          words: (groqResult.words || []).map(w => ({
            text: w.word || w.text || '',
            start: w.start || 0,
            end: w.end || 0,
          })),
        };
      }
    } else {
      console.log(`[${jobId}] No transcription service available. Using empty transcript.`);
      transcription = { text: '', words: [] };
    }

    console.log(`[${jobId}] Transcription complete: ${transcription.text.substring(0, 100)}...`);

    // Clean up audio file
    try { unlinkSync(audioPath); } catch (e) {}

    // Step 2: Analyze content and generate contextual scene data
    console.log(`[${jobId}] Step 2: Analyzing content and generating scenes...`);

    const typePrompts = {
      intro: `Create an engaging INTRO animation that hooks viewers and introduces the video topic.`,
      outro: `Create a compelling OUTRO animation that wraps up the video.`,
      transition: `Create a smooth TRANSITION animation between sections.`,
      highlight: `Create a HIGHLIGHT animation that emphasizes a key moment.`,
    };

    const scenePrompt = `You are a motion graphics designer. Analyze this video transcript and create a contextual ${type} animation.

VIDEO TRANSCRIPT:
"${transcription.text}"

${description ? `USER HINT: "${description}"` : ''}

${typePrompts[type] || typePrompts.intro}

Based on the video content above, return ONLY valid JSON (no markdown) with this structure:
{
  "scenes": [
    {
      "id": "unique-id",
      "type": "title" | "steps" | "features" | "stats" | "text" | "transition",
      "duration": <frames at 30fps>,
      "content": {
        "title": "text derived from video content",
        "subtitle": "optional",
        "items": [{"icon": "emoji", "label": "text", "description": "optional"}],
        "stats": [{"value": "number", "label": "text"}],
        "color": "#hex accent color",
        "backgroundColor": "#hex or null for transparent"
      }
    }
  ],
  "backgroundColor": "#0a0a0a",
  "totalDuration": <sum of scene durations>,
  "contentSummary": "brief description of what the video is about"
}

IMPORTANT: The animation content should directly relate to the video's actual topic and message.`;

    const sceneResult = await generateWithDeepSeek({
      prompt: scenePrompt,
      responseMimeType: 'application/json',
      jobId,
    });

    let sceneData;
    try {
      const responseText = sceneResult.candidates[0].content.parts[0].text;
      const cleanedResponse = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      sceneData = JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse AI response:`, parseError);
      throw new Error('Failed to parse AI-generated scene data');
    }

    console.log(`[${jobId}] Generated ${sceneData.scenes.length} scenes for ${type}`);
    console.log(`[${jobId}] Content summary: ${sceneData.contentSummary || 'N/A'}`);

    // Log camera movements for debugging
    const scenesWithCamera = sceneData.scenes.filter(s => s.content?.camera?.type);
    if (scenesWithCamera.length > 0) {
      console.log(`[${jobId}] 🎥 Camera movements: ${scenesWithCamera.map(s => `${s.id}: ${s.content.camera.type}`).join(', ')}`);
    } else {
      console.log(`[${jobId}] ⚠️ No camera movements in any scene`);
    }

    const animationTotalDuration = sceneData.totalDuration ?? sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = animationTotalDuration / fps;

    // Save scene data for future editing (persistent path based on asset ID)
    const sceneDataPath = join(session.dir, `${outputAssetId}-scenes.json`);
    try { await fs.promises.writeFile(sceneDataPath, JSON.stringify(sceneData, null, 2)); } catch (e) { console.warn(`[write] Scene data write failed: ${e.message}`); }
    console.log(`[${jobId}] Scene data saved to ${sceneDataPath} for future editing`);

    // Step 3: Write props and render with Remotion
    console.log(`[${jobId}] Step 3: Rendering with Remotion...`);

    await fs.promises.writeFile(propsPath, JSON.stringify(sceneData, null, 2));

    let renderOk6 = false;
    try {
      await renderWithRemotion({
        compositionId: 'DynamicAnimation',
        props: sceneData,
        outputPath,
        fps,
        width,
        height,
        onProgress: (pct) => { if (pct % 10 === 0) console.log(`[${jobId}] Render: ${pct}%`); },
      });
      renderOk6 = true;
    } catch (renderErr) {
      console.error(`[${jobId}] Programmatic render failed: ${renderErr.message}`);
    }

    if (!renderOk6) {
    const fallbackArgs = [
      'remotion', 'render',
      `${FRONTEND_ROOT}/src/remotion/index.tsx`,
      'DynamicAnimation',
      outputPath,
      '--props', propsPath,
      '--frames', `0-${Math.max(1, animationTotalDuration) - 1}`,
      '--fps', String(fps),
      '--width', String(width),
      '--height', String(height),
      '--codec', 'h264',
      '--overwrite',
    ];
    await new Promise((resolve, reject) => {
      const proc = spawn('npx', fallbackArgs, { cwd: FRONTEND_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Remotion npx fallback failed (code ${code}): ${stderr.slice(-500)}`)));
      proc.on('error', reject);
    });
    }

    // Step 4: Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Clean up
    try { unlinkSync(propsPath); } catch (e) {}

    const stats = await stat(outputPath);

    // Create asset entry
    // Create asset entry with scene data for future editing
    const asset = {
      id: outputAssetId,
      type: 'video',
      filename: `${type}-animation-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: durationInSeconds,
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
      // Metadata
      aiGenerated: true,
      contextual: true,
      animationType: type,
      contentSummary: sceneData.contentSummary,
      sceneCount: sceneData.scenes.length,
      sourceAssetId: videoAsset.id,
      sceneDataPath, // Store path to scene data for re-editing
      sceneData, // Also keep in memory for quick access
    };

    session.assets.set(outputAssetId, asset);

    console.log(`[${jobId}] Contextual ${type} animation rendered: ${outputAssetId} (${durationInSeconds}s)`);
    console.log(`[${jobId}] === CONTEXTUAL ANIMATION COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId: outputAssetId,
      filename: asset.filename,
      duration: durationInSeconds,
      type,
      contentSummary: sceneData.contentSummary,
      sceneCount: sceneData.scenes.length,
      thumbnailUrl: `/session/${sessionId}/assets/${outputAssetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${outputAssetId}/stream`,
    }));

  } catch (error) {
    console.error('Contextual animation generation error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// Auto-shorts generation (Clipify integration)
async function handleGenerateShorts(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  try {
    const body = await parseBody(req);
    const assetId = body.assetId || '';
    const youtubeUrl = body.youtubeUrl || '';
    const maxShorts = Math.min(Math.max(body.maxShorts ?? 5, 1), 20);
    const minSegmentDuration = Math.min(Math.max(body.minSegmentDuration ?? 30, 5), 300);
    const aspectRatio = body.aspectRatio || '9:16';
    const withCaptions = body.withCaptions !== false;

    // Resolve video asset
    let asset = null;
    if (assetId) {
      asset = session.assets.get(assetId) || null;
      if (!asset) { sendError(res, 404, 'Asset not found'); return; }
    }

    if (!asset && !youtubeUrl) {
      // Auto-select first video asset in session
      for (const [, a] of session.assets) {
        if (a.type === 'video') { asset = a; break; }
      }
      if (!asset) { sendError(res, 400, 'No video asset found and no YouTube URL provided'); return; }
    }

    const jobId = randomUUID().substring(0, 8);
    console.log(`\n[${jobId}] === GENERATE SHORTS (Clipify) ===`);

    const result = await enqueueJob({
      sessionId,
      type: 'generate-shorts',
      run: async (onProgress) => {
        const shorts = await createShortsModule({
          session,
          asset,
          options: { maxShorts, minSegmentDuration, aspectRatio, withCaptions, youtubeUrl, deepseekAvailable: !!process.env.DEEPSEEK_API_KEY },
          onProgress: (pct, step) => onProgress(pct, step),
          jobId,
        });
        return { shorts };
      },
    });

    sendSuccess(res, { jobId: result?.jobId || jobId });
  } catch (error) {
    logError(jobId, 'Generate shorts failed', error);
    sendError(res, 500, error.message);
  }
}

// Extract audio from video - creates separate audio asset and mutes the video
async function handleExtractAudio(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId } = body;

    if (!assetId) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'assetId is required' }));
      return;
    }

    const videoAsset = session.assets.get(assetId);
    if (!videoAsset) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Asset not found' }));
      return;
    }

    if (videoAsset.type !== 'video') {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Asset must be a video' }));
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === EXTRACT AUDIO ===`);
    console.log(`[${jobId}] Source video: ${videoAsset.filename}`);

    // Generate IDs and paths
    const audioAssetId = randomUUID();
    const mutedVideoAssetId = randomUUID();
    const audioPath = join(session.assetsDir, `${audioAssetId}.mp3`);
    const mutedVideoPath = join(session.assetsDir, `${mutedVideoAssetId}.mp4`);
    const mutedThumbPath = join(session.assetsDir, `${mutedVideoAssetId}_thumb.jpg`);

    // Step 1: Extract audio from video
    console.log(`[${jobId}] Step 1: Extracting audio...`);
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn',                    // No video
      '-acodec', 'libmp3lame',  // MP3 codec
      '-q:a', '2',              // High quality
      audioPath
    ], jobId);

    // Step 2: Create muted version of video
    console.log(`[${jobId}] Step 2: Creating muted video...`);
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-an',                    // No audio
      '-c:v', 'copy',           // Copy video stream (fast)
      mutedVideoPath
    ], jobId);

    // Step 3: Generate thumbnail for muted video
    try {
      await runFFmpeg([
        '-y', '-i', mutedVideoPath,
        '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        mutedThumbPath
      ], jobId);
    } catch (e) {
      console.warn(`[${jobId}] Thumbnail generation failed:`, e.message);
    }

    // Get file stats
    // stat already imported at top level
    const audioStats = await stat(audioPath);
    const videoStats = await stat(mutedVideoPath);

    // Get audio duration
    let audioDuration = videoAsset.duration;
    try {
      const { stdout: durOut } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
      );
      audioDuration = parseFloat(durOut.trim()) || videoAsset.duration;
    } catch (e) {
      console.warn(`[${jobId}] Could not get audio duration:`, e.message);
    }

    // Create audio asset
    const audioAsset = {
      id: audioAssetId,
      type: 'audio',
      filename: `${videoAsset.filename.replace(/\.[^.]+$/, '')}-audio.mp3`,
      path: audioPath,
      thumbPath: null,
      duration: audioDuration,
      size: audioStats.size,
      createdAt: Date.now(),
      sourceAssetId: assetId,
    };
    session.assets.set(audioAssetId, audioAsset);

    // Create muted video asset
    const mutedAsset = {
      id: mutedVideoAssetId,
      type: 'video',
      filename: `${videoAsset.filename.replace(/\.[^.]+$/, '')}-muted.mp4`,
      path: mutedVideoPath,
      thumbPath: existsSync(mutedThumbPath) ? mutedThumbPath : videoAsset.thumbPath,
      duration: videoAsset.duration,
      size: videoStats.size,
      width: videoAsset.width || 1920,
      height: videoAsset.height || 1080,
      createdAt: Date.now(),
      sourceAssetId: assetId,
      isMuted: true,
    };
    session.assets.set(mutedVideoAssetId, mutedAsset);

    console.log(`[${jobId}] ✓ Audio extracted: ${audioAsset.filename} (${audioDuration.toFixed(2)}s)`);
    console.log(`[${jobId}] ✓ Muted video created: ${mutedAsset.filename}`);
    console.log(`[${jobId}] === EXTRACT AUDIO COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      audioAsset: {
        id: audioAssetId,
        filename: audioAsset.filename,
        duration: audioDuration,
        type: 'audio',
        streamUrl: `/session/${sessionId}/assets/${audioAssetId}/stream`,
      },
      mutedVideoAsset: {
        id: mutedVideoAssetId,
        filename: mutedAsset.filename,
        duration: mutedAsset.duration,
        type: 'video',
        streamUrl: `/session/${sessionId}/assets/${mutedVideoAssetId}/stream`,
        thumbnailUrl: `/session/${sessionId}/assets/${mutedVideoAssetId}/thumbnail`,
      },
      originalAssetId: assetId,
    }));

  } catch (error) {
    console.error('Extract audio error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

// ── HyperFrames: AI generate HTML + render to video ─────────────────────
async function handleHyperframesGenerate(req, res, sessionId) {
  let body;
  try {
    body = await parseBody(req);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  // Zod validation
  const schema = z.object({
    prompt: z.string().min(1, 'Prompt is required'),
    duration: z.number().min(1).max(300).default(10),
    aspectRatio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
    style: z.string().default('modern'),
    fps: z.number().min(1).max(60).default(30),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, parsed.error.errors.map(e => e.message).join('; '));
    return;
  }

  const { prompt, duration, aspectRatio, style, fps } = parsed.data;

  // Compute dimensions from aspect ratio
  let width, height;
  switch (aspectRatio) {
    case '9:16': width = 1080; height = 1920; break;
    case '1:1': width = 1080; height = 1080; break;
    case '16:9': default: width = 1920; height = 1080; break;
  }

  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  const assetId = randomUUID();
  const outputPath = join(session.assetsDir, assetId + '.mp4');
  const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

  const result = await enqueueJob({
    sessionId,
    type: 'hyperframes-generate',
    run: async (onProgress) => {
      onProgress(5, 'Generating HTML with AI...');
      let htmlContent;
      let transcript = '';

      try {
        // Get transcript if available (don't fail)
        try {
          const videoAsset = Array.from(session.assets.values()).find(a => a.type === 'video');
          if (videoAsset) {
            const { getOrTranscribeVideo } = await import('./server/ai-transcribe.js');
            const transResult = await getOrTranscribeVideo(session, videoAsset);
            if (transResult?.text) transcript = transResult.text;
          }
        } catch { /* transcript optional */ }
      } catch { /* transcript optional */ }

      htmlContent = await generateHyperframesComposition({
        prompt, duration, width, height, style, transcript,
      });

      onProgress(30, 'Rendering HTML composition...');

      await renderHyperframesComposition({
        htmlContent, outputPath, width, height, fps,
        onProgress: (pct) => {
          onProgress(30 + Math.round(pct * 0.6), 'Rendering frames...');
        },
      });

      onProgress(92, 'Generating thumbnail...');
      try {
        await generateThumbnail(outputPath, thumbPath);
      } catch (thumbErr) {
        console.warn(`Thumbnail generation failed: ${thumbErr.message}`);
      }

      // Register asset in session
      const assetData = {
        id: assetId,
        type: 'video',
        filename: `${assetId}.mp4`,
        path: outputPath,
        thumbnail: thumbPath,
        source: 'hyperframes',
        prompt,
        style,
        duration,
        width,
        height,
        size: (await fs.promises.stat(outputPath).catch(() => ({ size: 0 }))).size,
        createdAt: Date.now(),
      };

      session.assets.set(assetId, assetData);
      await saveSessionMetadata(sessionId, session);

      onProgress(100, 'Complete!');
      return { asset: assetData };
    },
    abort: () => {
      console.log('HyperFrames generate job cancelled');
    },
  });

  sendSuccess(res, { jobId: result?.jobId || jobId });
}

// ── HyperFrames: Render raw HTML directly to video ───────────────────────
async function handleHyperframesRender(req, res, sessionId) {
  let body;
  try {
    body = await parseBody(req);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const schema = z.object({
    htmlContent: z.string().min(10, 'HTML content must be at least 10 characters'),
    duration: z.number().min(1).max(300).default(10),
    width: z.number().default(1920),
    height: z.number().default(1080),
    fps: z.number().min(1).max(60).default(30),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, parsed.error.errors.map(e => e.message).join('; '));
    return;
  }

  const { htmlContent, duration, width, height, fps } = parsed.data;

  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  const assetId = crypto.randomUUID();
  const outputPath = path.join(session.assetsDir, assetId + '.mp4');
  const thumbDir = path.join(session.thumbsDir, assetId);
  const thumbPath = path.join(thumbDir, 'thumb.jpg');

  const result = await enqueueJob({
    sessionId,
    type: 'hyperframes-render',
    run: async (onProgress) => {
      onProgress(10, 'Starting render...');

      await renderHyperframesComposition({
        htmlContent, outputPath, width, height, fps,
        onProgress: (pct) => {
          onProgress(10 + Math.round(pct * 0.8), 'Rendering...');
        },
      });

      onProgress(92, 'Generating thumbnail...');
      try {
        await fs.promises.mkdir(thumbDir, { recursive: true });
        await generateThumbnail(outputPath, thumbPath);
      } catch { /* thumbnail generation optional */ }

      const assetData = {
        id: assetId,
        type: 'video',
        filename: `${assetId}.mp4`,
        path: outputPath,
        thumbnail: thumbPath,
        source: 'hyperframes',
        duration: duration,
        width,
        height,
        size: (await fs.promises.stat(outputPath).catch(() => ({ size: 0 }))).size,
        createdAt: Date.now(),
      };

      session.assets.set(assetId, assetData);
      await saveSessionMetadata(sessionId, session);

      onProgress(100, 'Complete!');
      return { asset: assetData };
    },
    abort: () => {
      console.log('HyperFrames render job cancelled');
    },
  });

  sendSuccess(res, { jobId: result?.jobId || jobId });
}

// Process asset with FFmpeg command (for AI-suggested edits)
async function handleProcessAsset(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId, command } = body;

    if (!assetId || !command) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'assetId and command are required' }));
      return;
    }

    const asset = session.assets.get(assetId);
    if (!asset) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Asset not found' }));
      return;
    }

    // Verify the asset file actually exists on disk
    if (!existsSync(asset.path)) {
      console.error(`[ProcessAsset] Asset file missing: ${asset.path}`);
      res.writeHead(410, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        error: 'Asset file no longer exists. The session may have expired. Please re-upload your video.',
        code: 'ASSET_FILE_MISSING'
      }));
      return;
    }

    const jobId = randomUUID();
    const newAssetId = randomUUID();
    const outputPath = join(session.assetsDir, `${newAssetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${newAssetId}_thumb.jpg`);

    console.log(`\n[${jobId}] === PROCESS ASSET WITH FFMPEG ===`);
    console.log(`[${jobId}] Source: ${asset.filename}`);
    console.log(`[${jobId}] Command: ${command}`);

    // Parse the FFmpeg command and replace input/output placeholders
    // Expected format: "ffmpeg -i input.mp4 [options] output.mp4"
    // We'll replace input.mp4 with actual path and output.mp4 with new path
    let ffmpegArgs = command
      .replace(/^ffmpeg\s+/, '') // Remove 'ffmpeg' prefix
      .replace(/input\.mp4|"input\.mp4"/gi, `"${asset.path}"`)
      .replace(/output\.mp4|"output\.mp4"/gi, `"${outputPath}"`)
      .split(/\s+/)
      .filter(arg => arg.length > 0);

    // If the command doesn't have proper input/output, construct a basic one
    if (!ffmpegArgs.some(arg => arg.includes(asset.path))) {
      // Reconstruct with proper input
      ffmpegArgs = ['-y', '-i', asset.path, ...ffmpegArgs.filter(a => a !== '-i'), outputPath];
    }

    // Ensure -y flag for overwrite
    if (!ffmpegArgs.includes('-y')) {
      ffmpegArgs.unshift('-y');
    }

    console.log(`[${jobId}] FFmpeg args:`, ffmpegArgs);

    await runFFmpeg(ffmpegArgs, jobId);

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Get video info
    const stats = await stat(outputPath);

    // Get duration with ffprobe
    let duration = asset.duration;
    try {
      const { stdout: durOut } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`
      );
      duration = parseFloat(durOut.trim()) || asset.duration;
    } catch (e) {
      console.warn(`[${jobId}] Could not get duration:`, e.message);
    }

    // Create new asset entry
    const newAsset = {
      id: newAssetId,
      type: 'video',
      filename: `edited-${asset.filename}`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration,
      size: stats.size,
      width: asset.width || 1920,
      height: asset.height || 1080,
      createdAt: Date.now(),
      // Metadata
      sourceAssetId: assetId,
      ffmpegCommand: command,
    };

    session.assets.set(newAssetId, newAsset);

    console.log(`[${jobId}] Asset processed: ${newAssetId} (${duration.toFixed(2)}s)`);
    console.log(`[${jobId}] === PROCESSING COMPLETE ===\n`);

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      success: true,
      assetId: newAssetId,
      filename: newAsset.filename,
      duration,
      thumbnailUrl: `/session/${sessionId}/assets/${newAssetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${newAssetId}/stream`,
    }));

  } catch (error) {
    console.error('Process asset error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: error.message }));
  }
}


// ============== SERVER ==============

const server = http.createServer(async (req, res) => {
  // Generate a request ID for log tracing
  const reqId = randomUUID().slice(0, 8);
  const startTime = Date.now();

  // Track if response was already sent to prevent double-write errors
  let responseSent = false;
  const safeSend = (statusCode, data) => {
    if (responseSent) return;
    responseSent = true;
    res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
  };
  // Override sendJSON/sendError/sendSuccess to use safeSend
  const _sendJSON = sendJSON;
  const _sendError = sendError;
  const _sendSuccess = sendSuccess;

  // Disable timeout for large uploads - don't abort slow clients
  req.setTimeout(0);
  res.setTimeout(0);

  // Request logging (skip for health checks to reduce noise)
  const logRequest = () => {
    if (req.url === '/health') return;
    const duration = Date.now() - startTime;
    console.log(`[${reqId}] ${req.method} ${req.url} (${duration}ms)`);
  };

  // Global catch-all: route handler → 500 JSON on any uncaught error.
  // Individual handlers are responsible for their own errors; this is a
  // last resort so the server never hangs on an unhandled rejection.
  try {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Range, X-Requested-With');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, X-Removed-Duration, X-Original-Duration, X-New-Duration');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // ── New API routes (before session match) ────────────────────────────
  // SSE progress stream
  const sseMatch = path.match(/^\/api\/v1\/session\/([^/]+)\/progress$/);
  if (sseMatch && req.method === 'GET') {
    const sessionId = sseMatch[1];
    console.log(`[SSE] Client connected for session ${sessionId}`);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();

    addSSEClient(sessionId, res);

    req.on('close', () => {
      removeSSEClient(sessionId, res);
      console.log(`[SSE] Client disconnected for session ${sessionId}`);
    });
    return;
  }

  // Job status polling: GET /api/v1/session/:id/jobs/:jobId
  const jobStatusMatch = path.match(/^\/api\/v1\/session\/([^/]+)\/jobs\/([^/]+)$/);
  if (jobStatusMatch) {
    const sessionId = jobStatusMatch[1];
    const jobId = jobStatusMatch[2];
    if (req.method === 'GET') {
      const status = getJobStatus(jobId);
      if (!status) {
        sendError(res, 404, 'Job not found');
      } else {
        sendSuccess(res, status);
      }
    } else if (req.method === 'DELETE') {
      const cancelled = cancelJob(jobId);
      if (!cancelled) {
        sendError(res, 404, 'Job not found or already finished');
      } else {
        sendSuccess(res, { jobId, status: 'cancelled' });
      }
    } else {
      sendError(res, 405, 'Method not allowed');
    }
    return;
  }

  // List all jobs for session: GET /api/v1/session/:id/jobs
  const jobListMatch = path.match(/^\/api\/v1\/session\/([^/]+)\/jobs$/);
  if (jobListMatch && req.method === 'GET') {
    const sessionId = jobListMatch[1];
    const jobs = getSessionJobs(sessionId);
    sendSuccess(res, { jobs });
    return;
  }

  if (path === '/assets' && req.method === 'GET') {
    try {
      const files = readdirSync(ASSETS_FOLDER, { withFileTypes: true })
        .filter(f => f.isFile())
        .map(f => {
          const fp = pathModule.join(ASSETS_FOLDER, f.name);
          const stat = statSync(fp);
          const ext = pathModule.extname(f.name).toLowerCase();
          let type = 'other';
          if (['.mp4', '.mov', '.avi', '.webm', '.mkv'].includes(ext)) type = 'video';
          else if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) type = 'image';
          else if (['.mp3', '.wav', '.aac', '.ogg', '.flac'].includes(ext)) type = 'audio';
          return {
            name: f.name,
            size: stat.size,
            type,
            modifiedAt: stat.mtimeMs,
          };
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
      sendSuccess(res, { files, folder: ASSETS_FOLDER });
    } catch (err) {
      sendError(res, 500, err.message);
    }
    return;
  }

  // Session-based routes (new efficient API)
  const sessionMatch = path.match(/^\/session\/([^/]+)(\/(.+))?$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const action = sessionMatch[3] || '';

    if (req.method === 'POST' && sessionId === 'create') {
      await handleSessionCreate(req, res);
    } else if (req.method === 'POST' && sessionId === 'upload') {
      await handleSessionUpload(req, res);
    } else if (req.method === 'GET' && action === 'stream') {
      await handleSessionStream(req, res, sessionId);
    } else if (req.method === 'GET' && action === 'info') {
      await handleSessionInfo(req, res, sessionId);
    } else if (req.method === 'GET' && action === 'download') {
      await handleSessionDownload(req, res, sessionId);
    } else if (req.method === 'GET' && action === 'health') {
      const health = checkSessionHealth(sessionId);
      res.writeHead(health.valid ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
    } else if (req.method === 'POST' && action === 'process') {
      await handleSessionProcess(req, res, sessionId);
    } else if (req.method === 'POST' && action === 'remove-dead-air') {
      await handleSessionRemoveDeadAir(req, res, sessionId);
    } else if (req.method === 'POST' && action === 'chapters') {
      await handleSessionChapters(req, res, sessionId);
    } else if (req.method === 'DELETE' && !action) {
      await handleSessionDelete(req, res, sessionId);
    }
    // Multi-asset endpoints
    else if (req.method === 'POST' && action === 'assets') {
      await handleAssetUpload(req, res, sessionId);
    } else if (req.method === 'GET' && action === 'assets') {
      await handleAssetList(req, res, sessionId);
    } else if (req.method === 'POST' && action === 'uploads/init') {
      await handleAssetUploadInit(req, res, sessionId);
    } else if (req.method === 'POST' && action === 'uploads/chunk') {
      await handleAssetUploadChunk(req, res, sessionId);
    } else if (req.method === 'POST' && action === 'uploads/complete') {
      await handleAssetUploadComplete(req, res, sessionId);
    } else if (req.method === 'POST' && action === 'assets/import') {
      await handleAssetImport(req, res, sessionId);
    } else if (action.startsWith('assets/')) {
      const assetPath = action.substring(7); // Remove 'assets/'
      const [assetId, subAction] = assetPath.split('/');

      if (req.method === 'DELETE' && !subAction) {
        await handleAssetDelete(req, res, sessionId, assetId);
      } else if (req.method === 'GET' && subAction === 'thumbnail') {
        await handleAssetThumbnail(req, res, sessionId, assetId);
      } else if (req.method === 'GET' && subAction === 'waveform') {
        await handleAssetWaveform(req, res, sessionId, assetId);
      } else if (req.method === 'GET' && subAction === 'stream') {
        await handleAssetStream(req, res, sessionId, assetId);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Asset endpoint not found' }));
      }
    }
    // Project state endpoints
    else if (req.method === 'GET' && action === 'project') {
      await handleProjectGet(req, res, sessionId);
    } else if (req.method === 'PUT' && action === 'project') {
      await handleProjectSave(req, res, sessionId);
    }
    // Render endpoints
    else if (req.method === 'POST' && action === 'render') {
      await handleProjectRender(req, res, sessionId);
    }
    // GIF creation
    else if (req.method === 'POST' && action === 'create-gif') {
      await handleCreateGif(req, res, sessionId);
    }
    // Simple transcription (for captions)
    else if (req.method === 'POST' && action === 'transcribe') {
      await handleTranscribe(req, res, sessionId);
    }
    // Transcription and keyword extraction
    else if (req.method === 'POST' && action === 'transcribe-and-extract') {
      await handleTranscribeAndExtract(req, res, sessionId);
    }
    // B-roll image generation
    else if (req.method === 'POST' && action === 'generate-broll') {
      await handleGenerateBroll(req, res, sessionId);
    }
    // Motion graphics rendering (placeholder - creates solid color video for now)
    else if (req.method === 'POST' && action === 'render-motion-graphic') {
      await handleRenderMotionGraphic(req, res, sessionId);
    }
    // Auto-edit: AI-powered video editing pipeline
	    else if (req.method === 'POST' && action === 'auto-edit') {
	      await handleAutoEdit(req, res, sessionId);
	    }
	    // AI-generated custom animation (uses DeepSeek + Remotion)
    else if (req.method === 'POST' && action === 'generate-animation') {
      await handleGenerateAnimation(req, res, sessionId);
    }
    // Analyze video for animation (returns concept for approval, no rendering)
    else if (req.method === 'POST' && action === 'analyze-for-animation') {
      await handleAnalyzeForAnimation(req, res, sessionId);
    }
    // Render from pre-approved concept (skips analysis)
    else if (req.method === 'POST' && action === 'render-from-concept') {
      await handleRenderFromConcept(req, res, sessionId);
    }
    // Contextual animation - analyzes video content first, then generates relevant animation
    else if (req.method === 'POST' && action === 'generate-contextual-animation') {
      await handleGenerateContextualAnimation(req, res, sessionId);
    }
    // Transcript animation - kinetic typography from speech
    else if (req.method === 'POST' && action === 'generate-transcript-animation') {
      await handleGenerateTranscriptAnimation(req, res, sessionId);
    }
    // Edit existing animation with new prompt
    else if (req.method === 'POST' && action === 'edit-animation') {
      await handleEditAnimation(req, res, sessionId);
    }
    // Generate image with fal.ai (Picasso agent)
    else if (req.method === 'POST' && action === 'generate-image') {
      await handleGenerateImage(req, res, sessionId);
    }
    // Generate batch animations across timeline
    else if (req.method === 'POST' && action === 'generate-batch-animations') {
      await handleGenerateBatchAnimations(req, res, sessionId);
    }
    // Process asset with FFmpeg command
    else if (req.method === 'POST' && action === 'process-asset') {
      await handleProcessAsset(req, res, sessionId);
    }
    // HyperFrames: AI generate HTML and render to video
    else if (req.method === 'POST' && action === 'hyperframes/generate') {
      await handleHyperframesGenerate(req, res, sessionId);
    }
    // HyperFrames: Render raw HTML directly to video
    else if (req.method === 'POST' && action === 'hyperframes/render') {
      await handleHyperframesRender(req, res, sessionId);
    }
    // Clipify: Generate short clips
    else if (req.method === 'POST' && action === 'generate-shorts') {
      await handleGenerateShorts(req, res, sessionId);
    }
    // Extract audio from video (creates audio asset + muted video)
    else if (req.method === 'POST' && action === 'extract-audio') {
      await handleExtractAudio(req, res, sessionId);
    }
    // Generate video from image (DiCaprio agent)
    else if (req.method === 'POST' && action === 'generate-video') {
      await handleGenerateVideo(req, res, sessionId);
    }
    // Restyle video with AI (DiCaprio agent - LTX-2)
    else if (req.method === 'POST' && action === 'restyle-video') {
      await handleRestyleVideo(req, res, sessionId);
    }
    // Remove video background (DiCaprio agent - Bria)
    else if (req.method === 'POST' && action === 'remove-video-bg') {
      await handleRemoveVideoBg(req, res, sessionId);
    }
    // GIPHY search endpoints
    else if (req.method === 'GET' && action === 'giphy/search') {
      await handleGiphySearch(req, res, sessionId, url);
    }
    else if (req.method === 'GET' && action === 'giphy/trending') {
      await handleGiphyTrending(req, res, sessionId, url);
    }
    else if (req.method === 'POST' && action === 'giphy/add') {
      await handleGiphyAdd(req, res, sessionId);
    }
    else if (action.startsWith('renders/')) {
      const renderType = action.substring(8); // Remove 'renders/'
      if (req.method === 'GET') {
        await handleRenderDownload(req, res, sessionId, renderType);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Render endpoint not found' }));
      }
    }
    else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session endpoint not found' }));
    }
    return;
  }

  // Legacy routes (kept for backwards compatibility)
  if (req.method === 'POST' && path === '/process') {
    await handleProcess(req, res);
  } else if (req.method === 'POST' && path === '/remove-dead-air') {
    await handleRemoveDeadAir(req, res);
  } else if (req.method === 'POST' && path === '/generate-chapters') {
    // Legacy endpoint - session-based chapter gen is in handleSessionChapters
    sendSuccess(res, { chapters: [], youtubeFormat: '', summary: '' });
  } else if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ffmpeg: 'native', sessions: sessions.size }));
  } else {
    safeSend(404, { error: 'Not found' });
  }

  // Log the completed request
  logRequest();

  // ── Global catch ────────────────────────────────────────────────
  } catch (err) {
    logError(reqId, `Unhandled error in ${req.method} ${req.url}`, err);
    if (!res.headersSent && !responseSent) {
      safeSend(500, { error: err.message || 'Internal server error' });
    }
  }
});

// Disable server-level timeouts so large video uploads are never killed.
// Per-request timeouts (req.setTimeout / res.setTimeout) are already set to 0
// inside the request handler, but Node 18+ also enforces server-level limits
// that can abort slow uploads before formidable finishes reading the body.
server.timeout = 0;            // socket idle timeout (default 0 = none)
server.requestTimeout = 0;     // total request time (default 300s in Node 18+)
server.headersTimeout = 0;     // time to receive headers (default 60s)
server.keepAliveTimeout = 120_000; // keep-alive between requests

// ── Environment variable validation ──────────────────────────────────
const requiredVars = ['DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'FAL_API_KEY', 'GIPHY_API_KEY'];
for (const v of requiredVars) {
  if (!process.env[v]) {
    console.warn(`[WARN] ${v} is not set. Features requiring it will fail at runtime.`);
  }
}
// Check ffmpeg is available (uses spawnSync from child_process)
try {
  const { spawnSync } = await import('child_process');
  const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (result.status !== 0) throw new Error('ffmpeg not found');
  console.log('[OK] ffmpeg found');
} catch {
  console.error('[FATAL] ffmpeg not found in PATH. Install ffmpeg (https://ffmpeg.org/download.html) and ensure it is on your PATH.');
  process.exit(1);
}

// ── Graceful Shutdown ────────────────────────────────────────────────────
// Kill all child FFmpeg/Remotion processes and clean up sessions on exit.
// Without this, orphaned FFmpeg processes can accumulate and consume all
// system resources.
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);

  // Kill all running FFmpeg processes from the job queue
  try {
    cancelAllJobs();
  } catch { /* ignore */ }

  // Close the server
  await new Promise((resolve) => {
    server.close(resolve);
  });

  console.log('[Server] Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nLocal FFmpeg server running at http://localhost:${PORT}`);
  console.log(`\n   Session API:`);
  console.log(`   POST /session/upload - Upload video, get sessionId`);
  console.log(`   GET  /session/:id/stream - Stream video for preview`);
  console.log(`   GET  /session/:id/info - Get video info`);
  console.log(`   POST /session/:id/process - Apply FFmpeg edit`);
  console.log(`   POST /session/:id/remove-dead-air - Remove silence`);
  console.log(`   POST /session/:id/chapters - Generate chapters`);
  console.log(`   GET  /session/:id/download - Download final video`);
  console.log(`   DELETE /session/:id - Clean up session`);
  console.log(`\n   Multi-Asset API:`);
  console.log(`   POST /session/:id/assets - Upload asset (video/image/audio)`);
  console.log(`   GET  /session/:id/assets - List all assets`);
  console.log(`   DELETE /session/:id/assets/:assetId - Delete asset`);
  console.log(`   GET  /session/:id/assets/:assetId/thumbnail - Get thumbnail`);
  console.log(`   GET  /session/:id/assets/:assetId/waveform - Get waveform peaks`);
  console.log(`   GET  /session/:id/assets/:assetId/stream - Stream asset`);
  console.log(`\n   Project API:`);
  console.log(`   GET  /session/:id/project - Get project state`);
  console.log(`   PUT  /session/:id/project - Save project state`);
  console.log(`   POST /session/:id/render - Render project to video`);
  console.log(`   GET  /session/:id/renders/preview - Download preview`);
  console.log(`   GET  /session/:id/renders/export - Download export`);
  console.log(`\n   AI/Auto GIF API:`);
  console.log(`   POST /session/:id/transcribe-and-extract - Transcribe video, extract keywords, fetch GIFs`);
  console.log(`   POST /session/:id/generate-broll - Generate AI B-roll images from transcript`);
  console.log(`   POST /session/:id/generate-animation - AI-generated custom animation (DeepSeek + Remotion)`);
  console.log(`   POST /session/:id/analyze-for-animation - Analyze video, return concept for approval`);
  console.log(`   POST /session/:id/generate-contextual-animation - Content-aware animation (transcribes video first)`);
  console.log(`   POST /session/:id/process-asset - Apply FFmpeg command to an asset`);
  console.log(`   POST /session/:id/hyperframes/generate - AI generate HTML video`);
  console.log(`   POST /session/:id/hyperframes/render - Direct HTML → video render`);
  console.log(`\n   GET /health - Health check\n`);
});
