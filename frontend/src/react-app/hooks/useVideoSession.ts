import { useState, useCallback, useRef } from 'react';
import { LOCAL_FFMPEG_URL } from './useProject';

interface SessionInfo {
  sessionId: string;
  duration: number;
  size: number;
  name: string;
  editCount: number;
}

interface ChapterResult {
  chapters: Array<{ start: number; title: string }>;
  youtubeFormat: string;
  summary: string;
  videoDuration: number;
}

export function useVideoSession() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState('');
  const [serverAvailable, setServerAvailable] = useState<boolean | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);

  // Check if local server is available
  const checkServer = useCallback(async (): Promise<boolean> => {
    if (serverAvailable !== null) return serverAvailable;

    try {
      const response = await fetch(`${LOCAL_FFMPEG_URL}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000)
      });
      const data = await response.json();
      const available = data.status === 'ok';
      setServerAvailable(available);
      return available;
    } catch {
      setServerAvailable(false);
      return false;
    }
  }, [serverAvailable]);

  // Upload video and create session (only uploads once!)
  const uploadVideo = useCallback(async (file: File): Promise<SessionInfo> => {
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
    const fileSizeGB = (file.size / (1024 * 1024 * 1024)).toFixed(2);

    console.log(`[Session] Uploading ${file.name} (${fileSizeMB} MB)`);
    setProcessing(true);
    setStatus(`Uploading video (${file.size > 1024 * 1024 * 1024 ? fileSizeGB + ' GB' : fileSizeMB + ' MB'})...`);

    try {
      // Clean up any existing session
      if (session?.sessionId) {
        try {
          await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}`, { method: 'DELETE' });
        } catch {
          // Ignore cleanup errors
        }
      }

      uploadAbortRef.current = new AbortController();

      const formData = new FormData();
      formData.append('video', file);

      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/upload`, {
        method: 'POST',
        body: formData,
        signal: uploadAbortRef.current.signal,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Upload failed');
      }

      const result = await response.json();

      const sessionInfo: SessionInfo = {
        sessionId: result.sessionId,
        duration: result.duration,
        size: result.size,
        name: result.name,
        editCount: 0,
      };

      setSession(sessionInfo);
      setStatus('');
      console.log(`[Session] Created: ${result.sessionId}`);

      return sessionInfo;

    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error('Upload cancelled');
      }
      throw error;
    } finally {
      setProcessing(false);
      uploadAbortRef.current = null;
    }
  }, [session]);

  // Get the stream URL for video preview (no download needed!)
  const getStreamUrl = useCallback((): string | null => {
    if (!session) return null;
    return `${LOCAL_FFMPEG_URL}/session/${session.sessionId}/stream`;
  }, [session]);

  // Process video (edit in place - no re-upload!)
  const processVideo = useCallback(async (command: string): Promise<SessionInfo> => {
    if (!session) {
      throw new Error('No video session. Upload a video first.');
    }

    console.log(`[Session] Processing: ${command}`);
    setProcessing(true);
    setStatus('Processing video...');

    try {
      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Processing failed');
      }

      const result = await response.json();

      const updatedSession: SessionInfo = {
        ...session,
        duration: result.duration,
        size: result.size,
        editCount: result.editCount,
      };

      setSession(updatedSession);
      setStatus('Edit complete!');
      await new Promise(r => setTimeout(r, 500));
      setStatus('');

      return updatedSession;

    } finally {
      setProcessing(false);
    }
  }, [session]);

  // Remove dead air (no re-upload!)
  const removeDeadAir = useCallback(async (options?: {
    silenceThreshold?: number;
    minSilenceDuration?: number;
  }): Promise<{ duration: number; removedDuration: number }> => {
    if (!session) {
      throw new Error('No video session. Upload a video first.');
    }

    console.log(`[Session] Removing dead air`);
    setProcessing(true);
    setStatus('Detecting silence...');

    try {
      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/remove-dead-air`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options || {}),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Dead air removal failed');
      }

      const result = await response.json();

      const updatedSession: SessionInfo = {
        ...session,
        duration: result.duration,
        size: result.size,
        editCount: result.editCount,
      };

      setSession(updatedSession);

      if (result.removedDuration > 0) {
        setStatus(`Removed ${result.removedDuration.toFixed(1)}s of dead air!`);
      } else {
        setStatus('No silence detected');
      }
      await new Promise(r => setTimeout(r, 1500));
      setStatus('');

      return {
        duration: result.duration,
        removedDuration: result.removedDuration,
      };

    } finally {
      setProcessing(false);
    }
  }, [session]);

  // Generate chapters (no re-upload!)
  const generateChapters = useCallback(async (): Promise<ChapterResult> => {
    if (!session) {
      throw new Error('No video session. Upload a video first.');
    }

    console.log(`[Session] Generating chapters`);
    setProcessing(true);
    setStatus('Analyzing video content...');

    try {
      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/chapters`, {
        method: 'POST',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Chapter generation failed');
      }

      const result = await response.json();

      setStatus(`Generated ${result.chapters?.length || 0} chapters!`);
      await new Promise(r => setTimeout(r, 1000));
      setStatus('');

      return result;

    } finally {
      setProcessing(false);
    }
  }, [session]);

  // Download final video
  const downloadVideo = useCallback(async (): Promise<void> => {
    if (!session) {
      throw new Error('No video session');
    }

    setStatus('Preparing download...');

    // Trigger browser download
    const link = document.createElement('a');
    link.href = `${LOCAL_FFMPEG_URL}/session/${session.sessionId}/download`;
    link.download = session.name.replace(/\.[^.]+$/, '-edited.mp4');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setStatus('');
  }, [session]);

  // Get current session info
  const refreshSession = useCallback(async (): Promise<SessionInfo | null> => {
    if (!session) return null;

    try {
      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/info`);
      if (!response.ok) {
        setSession(null);
        return null;
      }

      const result = await response.json();
      const updatedSession: SessionInfo = {
        sessionId: result.sessionId,
        duration: result.duration,
        size: result.size,
        name: result.name,
        editCount: result.editCount,
      };

      setSession(updatedSession);
      return updatedSession;

    } catch {
      return session;
    }
  }, [session]);

  // Clean up session
  const closeSession = useCallback(async () => {
    if (session?.sessionId) {
      try {
        await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}`, { method: 'DELETE' });
      } catch {
        // Ignore cleanup errors
      }
    }
    setSession(null);
  }, [session]);

  // Cancel ongoing upload
  const cancelUpload = useCallback(() => {
    if (uploadAbortRef.current) {
      uploadAbortRef.current.abort();
    }
  }, []);

  return {
    // State
    session,
    processing,
    status,
    serverAvailable,

    // Actions
    checkServer,
    uploadVideo,
    getStreamUrl,
    processVideo,
    removeDeadAir,
    generateChapters,
    downloadVideo,
    refreshSession,
    closeSession,
    cancelUpload,
  };
}
