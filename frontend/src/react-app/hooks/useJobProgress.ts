import { useState, useEffect, useCallback, useRef } from 'react';
import { LOCAL_FFMPEG_URL } from './useProject';

export interface JobProgress {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  percent: number;
  step: string;
  error?: string;
}

export function useJobProgress(sessionId: string | null) {
  const [activeJob, setActiveJob] = useState<JobProgress | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const jobIdsRef = useRef<Set<string>>(new Set());

  // Connect to SSE when sessionId is available
  useEffect(() => {
    if (!sessionId) {
      setActiveJob(null);
      setShowProgress(false);
      return;
    }

    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const url = `${LOCAL_FFMPEG_URL}/api/v1/session/${sessionId}/progress`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Ignore connection keepalive
        if (data.type === 'connected') return;

        if (data.jobId) {
          jobIdsRef.current.add(data.jobId);
        }

        // Map SSE status to JobProgress
        const progress: JobProgress = {
          jobId: data.jobId || 'unknown',
          status: data.status || 'running',
          percent: data.percent ?? 0,
          step: data.step || '',
          error: data.error,
        };

        // Show progress for pending/running jobs
        if (data.status === 'pending' || data.status === 'running') {
          setActiveJob(progress);
          setShowProgress(true);
        } else if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
          // Show completed state briefly then hide
          setActiveJob(progress);
          setTimeout(() => {
            setShowProgress(false);
            setActiveJob(null);
          }, 2000);
        }
      } catch (err) {
        console.error('[JobProgress] Failed to parse SSE data:', err);
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects by default
      console.warn('[JobProgress] SSE connection error, will auto-reconnect');
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [sessionId]);

  // Cancel the active job
  const cancelJob = useCallback(async () => {
    if (!activeJob || !sessionId) return;

    try {
      await fetch(`${LOCAL_FFMPEG_URL}/api/v1/session/${sessionId}/jobs/${activeJob.jobId}`, {
        method: 'DELETE',
      });
    } catch (err) {
      console.error('[JobProgress] Failed to cancel job:', err);
    }

    setShowProgress(false);
    setActiveJob(null);
  }, [activeJob, sessionId]);

  return {
    activeJob,
    showProgress,
    cancelJob,
  };
}
