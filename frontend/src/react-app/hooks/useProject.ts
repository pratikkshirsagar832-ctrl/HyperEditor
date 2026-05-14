import { useState, useCallback, useRef, useEffect } from 'react';

// ── Undo/Redo command pattern ──────────────────────────────────────────────
const MAX_UNDO_STACK = 30;

interface UndoCommand {
  label: string;
  undo: () => void;
  redo: () => void;
}

// Toast callback type so Home.tsx can display undo/redo feedback
export type UndoRedoListener = (message: string) => void;
let undoRedoListener: UndoRedoListener | null = null;
export function setUndoRedoListener(fn: UndoRedoListener | null) { undoRedoListener = fn; }
function notifyUndoRedo(msg: string) { undoRedoListener?.(msg); }

// All API calls and uploads go through the Vite proxy (same origin = port 5173).
// The Vite dev/preview server proxies /session/*, /assets/*, /health → backend:3333.
// This avoids CORS issues entirely since everything is same-origin.
export const LOCAL_FFMPEG_URL = '';
export const FFMPEG_SERVER_PORT = 3333;
const SESSION_STORAGE_KEY = 'clipwise-session';

// Asset - source file in library
export interface Asset {
  id: string;
  type: 'video' | 'image' | 'audio';
  filename: string;
  duration: number;
  size: number;
  width?: number;
  height?: number;
  thumbnailUrl: string | null;
  streamUrl?: string; // URL with cache-busting timestamp
  aiGenerated?: boolean; // True if this is a Remotion-generated animation
}

// LocalAsset — file from the project's /assets folder
export interface LocalAsset {
  name: string;
  size: number;
  type: 'video' | 'image' | 'audio' | 'other';
  modifiedAt: number;
}

// TimelineClip - instance on timeline
export interface TimelineClip {
  id: string;
  assetId: string;
  trackId: string;
  start: number;
  duration: number;
  inPoint: number;
  outPoint: number;
  muted?: boolean;
  volume?: number;
  transform?: {
    x?: number;
    y?: number;
    scale?: number;
    rotation?: number;
    opacity?: number;
    cropTop?: number;
    cropBottom?: number;
    cropLeft?: number;
    cropRight?: number;
  };
}

// Track
export interface Track {
  id: string;
  type: 'video' | 'audio' | 'text';
  name: string;
  order: number;
  isLocked?: boolean;
}

// Caption word with timing
export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

// Caption styling options
export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: 'normal' | 'bold' | 'black';
  color: string;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  position: 'bottom' | 'center' | 'top';
  animation: 'none' | 'karaoke' | 'fade' | 'pop' | 'bounce' | 'typewriter';
  highlightColor?: string;
  timeOffset?: number; // Offset in seconds to adjust sync (negative = earlier, positive = later)
}

// Caption clip data (stored alongside TimelineClip)
export interface CaptionData {
  words: CaptionWord[];
  style: CaptionStyle;
}

// Project settings
export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
}

// Marker for timeline
export interface Marker {
  id: string;
  time: number;
  label: string;
  color: 'red' | 'yellow' | 'green' | 'blue' | 'purple';
}

// Project state
export interface ProjectState {
  tracks: Track[];
  clips: TimelineClip[];
  settings: ProjectSettings;
}

// Timeline tab for editing clips in isolation
export interface TimelineTab {
  id: string;
  name: string;
  type: 'main' | 'clip';
  assetId?: string; // For clip tabs, the asset being edited
  clips: TimelineClip[];
}

// Session info
export interface SessionInfo {
  sessionId: string;
  createdAt: number;
}

const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'Inter',
  fontSize: 24,
  fontWeight: 'bold',
  color: '#FFFFFF',
  strokeColor: '#000000',
  strokeWidth: 2,
  position: 'bottom',
  animation: 'karaoke',
  highlightColor: '#FFD700',
};

// Helper to load session from localStorage
function loadSessionFromStorage(): SessionInfo | null {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load session from storage:', e);
  }
  return null;
}

export function useProject() {
  // Initialize session from localStorage if available
  const [session, setSessionInternal] = useState<SessionInfo | null>(loadSessionFromStorage);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [tracks, setTracks] = useState<Track[]>([
    { id: 'T1', type: 'text', name: 'T1', order: 0 },   // Captions/text track (top)
    { id: 'V3', type: 'video', name: 'V3', order: 1 },  // Top overlay
    { id: 'V2', type: 'video', name: 'V2', order: 2 },  // Overlay
    { id: 'V1', type: 'video', name: 'V1', order: 3 },  // Base video track
    { id: 'A1', type: 'audio', name: 'A1', order: 4 },  // Audio track 1
    { id: 'A2', type: 'audio', name: 'A2', order: 5 },  // Audio track 2
  ]);
  const [clips, setClips] = useState<TimelineClip[]>([]);
  const [captionData, setCaptionData] = useState<Record<string, CaptionData>>({});

  // Timeline tabs for editing clips in isolation
  const [timelineTabs, setTimelineTabs] = useState<TimelineTab[]>([
    { id: 'main', name: 'Main', type: 'main', clips: [] }
  ]);
  const [activeTabId, setActiveTabId] = useState('main');

  const [settings, setSettings] = useState<ProjectSettings>({
    width: 1920,
    height: 1080,
    fps: 30,
  });
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [serverAvailable, setServerAvailable] = useState<boolean | null>(null);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadingRef = useRef(false);
  const sessionRef = useRef(session);

  // Refs to track latest state values for saveProject (avoids stale closure issues)
  const tracksRef = useRef(tracks);
  const clipsRef = useRef(clips);
  const settingsRef = useRef(settings);
  const captionDataRef = useRef<Record<string, CaptionData>>({});
  const timelineTabsRef = useRef<TimelineTab[]>([]);
  const versionRef = useRef(0);

  // Keep refs in sync with state
  useEffect(() => { sessionRef.current = session; }, [session]);

  // Keep refs in sync with state
  useEffect(() => { tracksRef.current = tracks; }, [tracks]);
  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { captionDataRef.current = captionData; }, [captionData]);
  useEffect(() => { timelineTabsRef.current = timelineTabs; }, [timelineTabs]);

  // ── Undo/Redo ────────────────────────────────────────────────────────────
  const undoStackRef = useRef<UndoCommand[]>([]);
  const redoStackRef = useRef<UndoCommand[]>([]);

  // Helper to check undo/redo availability (for UI indicators)
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const updateUndoRedoState = useCallback(() => {
    setCanUndo((undoStackRef.current?.length ?? 0) > 0);
    setCanRedo((redoStackRef.current?.length ?? 0) > 0);
  }, []);

  // Remove unused snapToTrack function

  const pushUndo = useCallback((cmd: UndoCommand) => {
    undoStackRef.current = [...undoStackRef.current.slice(-(MAX_UNDO_STACK - 1)), cmd];
    redoStackRef.current = []; // Clear redo on new action
    updateUndoRedoState();
  }, [updateUndoRedoState]);

  const undo = useCallback(() => {
    const cmd = undoStackRef.current.pop();
    if (!cmd) { notifyUndoRedo('Nothing to undo'); return; }
    cmd.undo();
    redoStackRef.current = [...redoStackRef.current, cmd];
    notifyUndoRedo(`Undo ${cmd.label}`);
    updateUndoRedoState();
  }, [updateUndoRedoState]);

  const redo = useCallback(() => {
    const cmd = redoStackRef.current.pop();
    if (!cmd) { notifyUndoRedo('Nothing to redo'); return; }
    cmd.redo();
    undoStackRef.current = [...undoStackRef.current, cmd];
    notifyUndoRedo(`Redo ${cmd.label}`);
    updateUndoRedoState();
  }, [updateUndoRedoState]);

  // Wrapper to persist session to localStorage
  const setSession = useCallback((sessionOrUpdater: SessionInfo | null | ((prev: SessionInfo | null) => SessionInfo | null)) => {
    setSessionInternal(prev => {
      const newSession = typeof sessionOrUpdater === 'function' ? sessionOrUpdater(prev) : sessionOrUpdater;
      if (newSession) {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(newSession));
      } else {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      }
      return newSession;
    });
  }, []);

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

  // Validate stored session on mount - clear if server doesn't recognize it
  useEffect(() => {
    const validateSession = async () => {
      if (!session) return;

      try {
        const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/project`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000)
        });

        if (response.status === 404) {
          // Session no longer exists on server - clear it
          console.log('Stored session is invalid, clearing...');
          localStorage.removeItem(SESSION_STORAGE_KEY);
          setSessionInternal(null);
          setAssets([]);
          setClips([]);
          setCaptionData({});
        }
      } catch {
        // Server might be down - don't clear session yet
        console.log('Could not validate session');
      }
    };

    validateSession();
  }, [session, checkServer]);

  // Create a new session
  const createSession = useCallback(async (): Promise<SessionInfo> => {
    // We'll create a session by uploading the first asset
    // For now, just generate a client-side session ID that will be
    // confirmed when we upload the first file
    const tempId = crypto.randomUUID();
    const sessionInfo: SessionInfo = {
      sessionId: tempId,
      createdAt: Date.now(),
    };
    return sessionInfo;
  }, []);

  // Upload asset through the Vite proxy using fetch.
  // Direct cross-origin XHR to localhost:3333 was getting aborted by the browser
  // before any bytes were sent for some large files.
  // Strategy: use simple multipart upload for files <10MB, chunked for larger files.
  const CHUNK_THRESHOLD = 5 * 1024 * 1024; // 5MB — use chunked upload sooner for reliability

  const uploadAsset = useCallback(async (file: File, onProgress?: (percent: number, uploadedMB: number, totalMB: number) => void): Promise<Asset> => {
    uploadingRef.current = true;
    setLoading(true);
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
    setStatus(`Uploading ${file.name} (${fileSizeMB} MB)...`);

    try {
      let currentSession = sessionRef.current;

      // If no session yet, create one first
      if (!currentSession) {
        const createResponse = await fetch(`${LOCAL_FFMPEG_URL}/session/create`, {
          method: 'POST',
        });

        if (!createResponse.ok) {
          const error = await createResponse.json();
          throw new Error(error.error || 'Failed to create session');
        }

        const createResult = await createResponse.json();
        currentSession = {
          sessionId: createResult.sessionId,
          createdAt: Date.now(),
        };
        setSession(currentSession);
      }

      const totalMB = Math.max(1, Math.round(file.size / 1024 / 1024));
      onProgress?.(0, 0, totalMB);

      const sessionId = currentSession.sessionId;

      // For small files, use simple multipart upload to avoid chunking overhead
      if (file.size < CHUNK_THRESHOLD) {
        return await simpleUpload(file, sessionId, onProgress, totalMB);
      }

      return await chunkedUpload(file, sessionId, onProgress, totalMB);
    } finally {
      setLoading(false);
      uploadingRef.current = false;
    }
  }, [setSession]);

  // Simple multipart upload for files under threshold
  async function simpleUpload(file: File, sessionId: string, onProgress?: (percent: number, uploadedMB: number, totalMB: number) => void, totalMB?: number): Promise<Asset> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const formData = new FormData();
        formData.append('file', file, file.name);

        const asset = await new Promise<Asset>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          
          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              const pct = Math.min(99, Math.round((e.loaded / e.total) * 100));
              onProgress?.(pct, Math.round(e.loaded / (1024 * 1024) * 10) / 10, totalMB || 1);
              setStatus(`Uploading ${file.name}... ${pct}%`);
            }
          });

          xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const result = JSON.parse(xhr.responseText);
                if (!result?.asset) {
                  reject(new Error('Invalid upload response'));
                  return;
                }
                const newAsset: Asset = {
                  id: result.asset.id, type: result.asset.type,
                  filename: result.asset.filename, duration: result.asset.duration,
                  size: result.asset.size, width: result.asset.width, height: result.asset.height,
                  thumbnailUrl: result.asset.thumbnailUrl ? `${LOCAL_FFMPEG_URL}${result.asset.thumbnailUrl}` : null,
                };
                onProgress?.(100, totalMB || 1, totalMB || 1);
                setAssets(prev => [...prev, newAsset]);
                setStatus('');
                resolve(newAsset);
              } catch (e) {
                reject(new Error('Failed to parse upload response'));
              }
            } else {
              let msg = `Upload failed (HTTP ${xhr.status})`;
              try { const err = JSON.parse(xhr.responseText); if (err.error) msg = err.error; } catch {}
              reject(new Error(msg));
            }
          });

          xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
          xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

          xhr.open('POST', `/session/${sessionId}/assets`);
          xhr.timeout = 600000; // 10 min timeout
          xhr.send(formData);
        });

        return asset;
      } catch (err) {
        console.warn(`Upload attempt ${attempt}/${maxAttempts} failed:`, err instanceof Error ? err.message : err);
        if (attempt === maxAttempts) {
          throw err instanceof Error ? err : new Error('Network error during upload');
        }
        // Wait before retrying (exponential backoff)
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error('Upload failed after all retries');
  }

  // Chunked upload for files >= 10MB
  async function chunkedUpload(file: File, sessionId: string, onProgress?: (percent: number, uploadedMB: number, totalMB: number) => void, totalMB?: number): Promise<Asset> {
    const parseJson = async (response: Response) => {
      const text = await response.text();
      if (!text) return null;
      try { return JSON.parse(text); }
      catch { throw new Error(`Unexpected server response (${response.status})`); }
    };

    // Initialize chunked upload (relative URL → same origin → Vite proxy → backend)
    const initResponse = await fetch(`/session/${sessionId}/uploads/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size }),
    });

    const initResult = await parseJson(initResponse);
    if (!initResponse.ok || !initResult?.uploadId) {
      throw new Error(initResult?.error || `Upload init failed: HTTP ${initResponse.status}`);
    }

    const chunkSize = Math.max(8 * 1024 * 1024, Number(initResult.chunkSize || 8 * 1024 * 1024));
    let uploadedBytes = 0;

    while (uploadedBytes < file.size) {
      const nextOffset = Math.min(uploadedBytes + chunkSize, file.size);
      const chunk = file.slice(uploadedBytes, nextOffset);

      let chunkResult = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const chunkResponse = await fetch(
            `/session/${sessionId}/uploads/chunk?uploadId=${encodeURIComponent(initResult.uploadId)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: chunk,
            }
          );

          const parsed = await parseJson(chunkResponse);
          if (!chunkResponse.ok) {
            throw new Error(parsed?.error || `Chunk failed: HTTP ${chunkResponse.status}`);
          }
          chunkResult = parsed;
          break;
        } catch (err) {
          if (attempt === 3) throw err;
          console.warn(`Chunk attempt ${attempt} failed, retrying:`, err instanceof Error ? err.message : err);
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }

      uploadedBytes = typeof chunkResult?.receivedBytes === 'number'
        ? chunkResult.receivedBytes
        : nextOffset;

      const percent = Math.min(99, Math.round((uploadedBytes / file.size) * 100));
      onProgress?.(percent, Math.round(uploadedBytes / (1024 * 1024) * 10) / 10, totalMB || 1);
      setStatus(`Uploading ${file.name}... ${percent}%`);
    }

    // Complete the upload
    let completeResult;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const completeResponse = await fetch(`/session/${sessionId}/uploads/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId: initResult.uploadId }),
        });

        completeResult = await parseJson(completeResponse);
        if (!completeResponse.ok) {
          throw new Error(completeResult?.error || `Upload completion failed: HTTP ${completeResponse.status}`);
        }
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!completeResult?.asset) {
      throw new Error('Failed to parse upload response');
    }

    onProgress?.(100, totalMB || 1, totalMB || 1);

    const asset: Asset = {
      id: completeResult.asset.id, type: completeResult.asset.type,
      filename: completeResult.asset.filename, duration: completeResult.asset.duration,
      size: completeResult.asset.size, width: completeResult.asset.width, height: completeResult.asset.height,
      thumbnailUrl: completeResult.asset.thumbnailUrl ? `${LOCAL_FFMPEG_URL}${completeResult.asset.thumbnailUrl}` : null,
    };

    setAssets(prev => [...prev, asset]);
    setStatus('');
    return asset;
  }

  // Delete asset
  const deleteAsset = useCallback(async (assetId: string): Promise<void> => {
    if (!session) return;

    const clipsToRemove = clips.filter(c => c.assetId === assetId);

    await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets/${assetId}`, {
      method: 'DELETE',
    });

    setAssets(prev => {
      const prevSnapshot = [...prev];
      pushUndo({
        label: 'Delete Asset',
        undo: () => {
          setAssets(prevSnapshot);
          setClips(p => [...p, ...clipsToRemove]);
        },
        redo: () => {
          setAssets(prevSnapshot.filter(a => a.id !== assetId));
          setClips(p => p.filter(c => c.assetId !== assetId));
        },
      });
      return prev.filter(a => a.id !== assetId);
    });
    setClips(prev => prev.filter(c => c.assetId !== assetId));
  }, [session, clips, pushUndo]);

  // Get asset stream URL
  const getAssetStreamUrl = useCallback((assetId: string): string | null => {
    if (!session) return null;
    return `${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets/${assetId}/stream`;
  }, [session]);

  // Refresh assets from server (useful after server-side asset generation)
  const refreshAssets = useCallback(async (): Promise<Asset[]> => {
    if (!session) return [];

    const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets`);
    if (!response.ok) {
      throw new Error('Failed to fetch assets');
    }

    const data = await response.json();
    const serverAssets: Asset[] = (data.assets || []).map((a: {
      id: string;
      type: 'video' | 'image' | 'audio';
      filename: string;
      duration: number;
      size: number;
      width?: number;
      height?: number;
      thumbnailUrl?: string | null;
      aiGenerated?: boolean;
    }) => ({
      id: a.id,
      type: a.type,
      filename: a.filename,
      duration: a.duration,
      size: a.size,
      width: a.width,
      height: a.height,
      thumbnailUrl: a.thumbnailUrl
        ? `${LOCAL_FFMPEG_URL}${a.thumbnailUrl}`
        : null,
      // Add cache-busting timestamp to force reload after file changes (e.g., dead air removal)
      streamUrl: `${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets/${a.id}/stream?v=${Date.now()}`,
      // Preserve aiGenerated flag for Remotion-generated animations (critical for edit workflow detection)
      aiGenerated: a.aiGenerated || false,
    }));

    setAssets(serverAssets);
    return serverAssets;
  }, [session]);
  // List files in the project's local /assets folder
  const listLocalAssets = useCallback(async (): Promise<LocalAsset[]> => {
    try {
      const response = await fetch(`${LOCAL_FFMPEG_URL}/assets`);
      if (!response.ok) throw new Error('Failed to list local assets');
      const data = await response.json();
      return data.files || [];
    } catch {
      return [];
    }
  }, []);
  // Import a file from local /assets into the current session.
  // Auto-creates a session if none exists (like uploadAsset).
  const importLocalAsset = useCallback(async (filename: string): Promise<Asset> => {
    let currentSession = sessionRef.current;
    if (!currentSession) {
      const createResponse = await fetch(`${LOCAL_FFMPEG_URL}/session/create`, { method: 'POST' });
      if (!createResponse.ok) throw new Error('Failed to create session');
      const createResult = await createResponse.json();
      currentSession = { sessionId: createResult.sessionId, createdAt: Date.now() };
      setSession(currentSession);
    }
    const sessionId = currentSession.sessionId;
    const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${sessionId}/assets/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Import failed');
    }
    const result = await response.json();
    const imported: Asset = {
      id: result.asset.id,
      type: result.asset.type,
      filename: result.asset.filename,
      duration: result.asset.duration,
      size: result.asset.size,
      width: result.asset.width,
      height: result.asset.height,
      thumbnailUrl: result.asset.thumbnailUrl ? `${LOCAL_FFMPEG_URL}${result.asset.thumbnailUrl}` : null,
    };
    setAssets(prev => [...prev, imported]);
    return imported;
  }, []);

  // Add clip to timeline
  const addClip = useCallback((
    assetId: string,
    trackId: string,
    start: number,
    duration?: number,
    inPoint?: number,
    outPoint?: number
  ): TimelineClip => {
    const asset = assets.find(a => a.id === assetId);

    let clipDuration: number;
    if (duration !== undefined) {
      clipDuration = duration;
    } else if (asset) {
      clipDuration = asset.type === 'image' ? 5 : (asset.duration > 0 ? asset.duration : 5);
    } else {
      clipDuration = 5;
      console.warn(`Asset ${assetId} not found in state, using default duration`);
    }

    const clip: TimelineClip = {
      id: crypto.randomUUID(),
      assetId,
      trackId,
      start,
      duration: clipDuration,
      inPoint: inPoint ?? 0,
      outPoint: outPoint ?? clipDuration,
    };

    setClips(prev => {
      const prevSnapshot = [...prev];
      pushUndo({
        label: 'Add Clip',
        undo: () => setClips(prevSnapshot),
        redo: () => setClips([...prevSnapshot, clip]),
      });
      return [...prev, clip];
    });
    return clip;
  }, [assets, pushUndo]);

  // Update clip
  const updateClip = useCallback((clipId: string, updates: Partial<TimelineClip>): void => {
    setClips(prev => {
      const old = prev.find(c => c.id === clipId);
      if (!old) return prev.map(c => c.id === clipId ? { ...c, ...updates } : c);
      const oldSnapshot = { ...old };
      pushUndo({
        label: 'Update Clip',
        undo: () => setClips(p => p.map(c => c.id === clipId ? { ...c, ...oldSnapshot } : c)),
        redo: () => setClips(p => p.map(c => c.id === clipId ? { ...c, ...updates } : c)),
      });
      return prev.map(c => c.id === clipId ? { ...c, ...updates } : c);
    });
  }, [pushUndo]);

  // Delete clip (with optional ripple/autosnap to shift subsequent clips)
  const deleteClip = useCallback((clipId: string, ripple: boolean = false): void => {
    setClips(prev => {
      const clipToDelete = prev.find(c => c.id === clipId);
      if (!clipToDelete) return prev.filter(c => c.id !== clipId);

      const prevSnapshot = [...prev];

      const filtered = prev.filter(c => c.id !== clipId);
      let result: TimelineClip[];

      if (ripple) {
        const deletedEnd = clipToDelete.start + clipToDelete.duration;
        const gapDuration = clipToDelete.duration;
        result = filtered.map(c => {
          if (c.trackId === clipToDelete.trackId && c.start >= deletedEnd) {
            return { ...c, start: Math.max(0, c.start - gapDuration) };
          }
          return c;
        });
      } else {
        result = filtered;
      }

      pushUndo({
        label: 'Delete Clip',
        undo: () => setClips(prevSnapshot),
        redo: () => setClips(result),
      });

      return result;
    });
  }, [pushUndo]);

  // Move clip (with auto-snap to prevent overlap)
  const moveClip = useCallback((clipId: string, newStart: number, newTrackId?: string): void => {
    setClips(prev => {
      const old = prev.find(c => c.id === clipId);
      if (!old) return prev.map(c => c.id === clipId ? { ...c, start: Math.max(0, newStart), trackId: newTrackId ?? c.trackId } : c);
      const oldStart = old.start;
      const oldTrackId = old.trackId;
      const targetTrackId = newTrackId ?? old.trackId;

      // Auto-snap: push past overlapping clips on the target track
      const sameTrack = prev.filter(c => c.trackId === targetTrackId && c.id !== clipId);
      const sorted = [...sameTrack].sort((a, b) => a.start - b.start);
      let snapped = Math.max(0, newStart);
      for (const other of sorted) {
        const otherEnd = other.start + other.duration;
        const clipEnd = snapped + old.duration;
        if (snapped < otherEnd && clipEnd > other.start) {
          snapped = otherEnd;
        }
      }

      pushUndo({
        label: 'Move Clip',
        undo: () => setClips(p => p.map(c => c.id === clipId ? { ...c, start: oldStart, trackId: oldTrackId } : c)),
        redo: () => setClips(p => p.map(c => c.id === clipId ? { ...c, start: snapped, trackId: targetTrackId } : c)),
      });
      return prev.map(c => {
        if (c.id !== clipId) return c;
        return { ...c, start: snapped, trackId: targetTrackId };
      });
    });
  }, [pushUndo]);

  // Resize clip (change in/out points or duration)
  const resizeClip = useCallback((clipId: string, newInPoint: number, newOutPoint: number, newStart?: number): void => {
    setClips(prev => {
      const old = prev.find(c => c.id === clipId);
      if (!old) return prev.map(c => {
        if (c.id !== clipId) return c;
        const nd = newOutPoint - newInPoint;
        return { ...c, inPoint: newInPoint, outPoint: newOutPoint, duration: nd, start: newStart ?? c.start };
      });
      const oldIn = old.inPoint, oldOut = old.outPoint, oldStart = old.start;
      pushUndo({
        label: 'Resize Clip',
        undo: () => setClips(p => p.map(c => c.id === clipId ? { ...c, inPoint: oldIn, outPoint: oldOut, duration: oldOut - oldIn, start: oldStart } : c)),
        redo: () => setClips(p => p.map(c => c.id === clipId ? { ...c, inPoint: newInPoint, outPoint: newOutPoint, duration: newOutPoint - newInPoint, start: newStart ?? oldStart } : c)),
      });
      return prev.map(c => {
        if (c.id !== clipId) return c;
        const newDuration = newOutPoint - newInPoint;
        return { ...c, inPoint: newInPoint, outPoint: newOutPoint, duration: newDuration, start: newStart ?? c.start };
      });
    });
  }, [pushUndo]);

  // Split clip at a specific time, creating two clips
  const splitClip = useCallback((clipId: string, splitTime: number): string | null => {
    const clip = clips.find(c => c.id === clipId);
    if (!clip) return null;

    const timeInClip = splitTime - clip.start;
    if (timeInClip <= 0.05 || timeInClip >= clip.duration - 0.05) {
      return null;
    }

    const splitInPoint = clip.inPoint + timeInClip;
    const secondClip: TimelineClip = {
      id: crypto.randomUUID(),
      assetId: clip.assetId,
      trackId: clip.trackId,
      start: splitTime,
      duration: clip.duration - timeInClip,
      inPoint: splitInPoint,
      outPoint: clip.outPoint,
      transform: clip.transform ? { ...clip.transform } : undefined,
    };

    setClips(prev => {
      const prevSnapshot = [...prev];
      const updated = [
        ...prev.map(c => {
          if (c.id !== clipId) return c;
          return { ...c, duration: timeInClip, outPoint: splitInPoint };
        }),
        secondClip,
      ];
      pushUndo({
        label: 'Split Clip',
        undo: () => setClips(prevSnapshot),
        redo: () => setClips(updated),
      });
      return updated;
    });

    return secondClip.id;
  }, [clips, pushUndo]);

  // Create a new timeline tab for editing a clip/animation in isolation
  const createTimelineTab = useCallback((name: string, assetId: string, initialClips?: TimelineClip[]): string => {
    const tabId = crypto.randomUUID();
    const newTab: TimelineTab = {
      id: tabId,
      name,
      type: 'clip',
      assetId,
      clips: initialClips || [],
    };

    setTimelineTabs(prev => [...prev, newTab]);
    setActiveTabId(tabId);

    return tabId;
  }, []);

  // Switch to a different timeline tab
  const switchTimelineTab = useCallback((tabId: string): void => {
    setActiveTabId(tabId);
  }, []);

  // Close a timeline tab (cannot close main)
  const closeTimelineTab = useCallback((tabId: string): void => {
    if (tabId === 'main') return; // Cannot close main tab

    setTimelineTabs(prev => prev.filter(tab => tab.id !== tabId));

    setActiveTabId(currentId => {
      if (currentId === tabId) {
        return 'main';
      }
      return currentId;
    });
  }, []);

  // Update clips in a specific tab
  const updateTabClips = useCallback((tabId: string, clips: TimelineClip[]): void => {
    setTimelineTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, clips } : tab
    ));
  }, []);

  // Update a tab's animation asset (used when editing an animation - now in-place)
  // This updates the V1 clip duration (asset ID stays the same for in-place edits)
  const updateTabAsset = useCallback((tabId: string, newAssetId: string, newDuration: number): void => {
    setTimelineTabs(prev => {
      const updatedTabs = prev.map(tab => {
        if (tab.id !== tabId) return tab;

        // Update the V1 clip to point to the new asset
        const updatedClips = tab.clips.map(clip => {
          if (clip.trackId === 'V1') {
            return {
              ...clip,
              assetId: newAssetId,
              duration: newDuration,
              outPoint: newDuration,
            };
          }
          return clip;
        });

        return {
          ...tab,
          assetId: newAssetId,
          clips: updatedClips,
        };
      });

      return updatedTabs;
    });
  }, []);

  // Get the active timeline tab
  const getActiveTab = useCallback((): TimelineTab | undefined => {
    return timelineTabs.find(tab => tab.id === activeTabId);
  }, [timelineTabs, activeTabId]);

  // Add caption clip to timeline
  const addCaptionClip = useCallback((
    words: CaptionWord[],
    start: number,
    duration: number,
    style?: Partial<CaptionStyle>
  ): TimelineClip => {
    const clipId = crypto.randomUUID();

    // Create the timeline clip
    const clip: TimelineClip = {
      id: clipId,
      assetId: '', // No asset for captions
      trackId: 'T1',
      start,
      duration,
      inPoint: 0,
      outPoint: duration,
    };

    // Store caption data separately
    const captionInfo: CaptionData = {
      words,
      style: { ...DEFAULT_CAPTION_STYLE, ...style },
    };

    setClips(prev => [...prev, clip]);
    setCaptionData(prev => ({ ...prev, [clipId]: captionInfo }));

    return clip;
  }, []);

  // Add multiple caption clips at once (batched for performance)
  const addCaptionClipsBatch = useCallback((
    captions: Array<{
      words: CaptionWord[];
      start: number;
      duration: number;
      style?: Partial<CaptionStyle>;
    }>
  ): TimelineClip[] => {
    const newClips: TimelineClip[] = [];
    const newCaptionData: Record<string, CaptionData> = {};

    for (const caption of captions) {
      const clipId = crypto.randomUUID();

      newClips.push({
        id: clipId,
        assetId: '',
        trackId: 'T1',
        start: caption.start,
        duration: caption.duration,
        inPoint: 0,
        outPoint: caption.duration,
      });

      newCaptionData[clipId] = {
        words: caption.words,
        style: { ...DEFAULT_CAPTION_STYLE, ...caption.style },
      };
    }

    // Single state update for all clips
    setClips(prev => [...prev, ...newClips]);
    setCaptionData(prev => ({ ...prev, ...newCaptionData }));

    return newClips;
  }, []);

  // Update caption style
  const updateCaptionStyle = useCallback((clipId: string, styleUpdates: Partial<CaptionStyle>): void => {
    setCaptionData(prev => {
      const existing = prev[clipId];
      if (!existing) return prev;
      return {
        ...prev,
        [clipId]: {
          ...existing,
          style: { ...existing.style, ...styleUpdates },
        },
      };
    });
  }, []);

  // Get caption data for a clip
  const getCaptionData = useCallback((clipId: string): CaptionData | null => {
    return captionData[clipId] || null;
  }, [captionData]);

  // Save project to server (debounced)
  // Uses refs to always get latest state, avoiding stale closure issues
  const saveProject = useCallback(async (): Promise<void> => {
    if (!session) return;

    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce saves - use refs to get latest state values
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/project`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tracks: tracksRef.current,
            clips: clipsRef.current,
            settings: settingsRef.current,
            captions: captionDataRef.current,
            timelineTabs: timelineTabsRef.current,
            version: versionRef.current,
          }),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || 'Project save failed');
        }
        const result = await response.json().catch(() => ({}));
        versionRef.current = typeof result.version === 'number'
          ? result.version
          : versionRef.current + 1;
        setStatus('Project saved');
        setTimeout(() => setStatus(''), 1200);
        console.log('[Project] Saved');
      } catch (error) {
        console.error('[Project] Save failed:', error);
        setStatus(error instanceof Error ? error.message : 'Project save failed');
      }
    }, 500);
  }, [session]);

  // Load project from server (including assets)
  const loadProject = useCallback(async (): Promise<void> => {
    if (!session) return;

    try {
      // Fetch assets first
      const assetsResponse = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets`);
      if (assetsResponse.ok) {
        const assetsData = await assetsResponse.json();
        const serverAssets: Asset[] = (assetsData.assets || []).map((a: {
          id: string;
          type: 'video' | 'image' | 'audio';
          filename: string;
          duration: number;
          size: number;
          width?: number;
          height?: number;
          thumbnailUrl?: string | null;
          aiGenerated?: boolean;
        }) => ({
          id: a.id,
          type: a.type,
          filename: a.filename,
          duration: a.duration,
          size: a.size,
          width: a.width,
          height: a.height,
          thumbnailUrl: a.thumbnailUrl
            ? `${LOCAL_FFMPEG_URL}${a.thumbnailUrl}`
            : null,
          // Add cache-busting timestamp to force reload after file changes
          streamUrl: `${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets/${a.id}/stream?v=${Date.now()}`,
          // Preserve aiGenerated flag for Remotion-generated animations (critical for edit workflow detection)
          aiGenerated: a.aiGenerated || false,
        }));
        setAssets(serverAssets);
      }

      // Then fetch project
      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/project`);
      if (response.ok) {
        const data = await response.json();
        // Don't load tracks from server - always use client's default tracks
        // Server tracks may be outdated (e.g., missing T1, V3, A2)
        if (data.clips) setClips(data.clips);
        if (data.settings) setSettings(data.settings);
        setCaptionData(data.captions || {});
        // Store server version for conflict detection
        if (data.version !== undefined) {
          versionRef.current = data.version;
        }
        // Restore edit tabs (animations being edited in a separate tab).
        // The 'main' tab is hard-coded in initial state and never persisted.
        if (Array.isArray(data.timelineTabs) && data.timelineTabs.length > 0) {
          setTimelineTabs(prev => {
            const main = prev.find(t => t.id === 'main') || prev[0];
            const restored = data.timelineTabs.filter((t: TimelineTab) => t.id !== 'main');
            return main ? [main, ...restored] : restored;
          });
        }
      }
    } catch (error) {
      console.error('[Project] Load failed:', error);
    }
  }, [session]);

  // Render project
  // Uses refs to always get latest state
  const renderProject = useCallback(async (preview = false, quality = 'standard'): Promise<string> => {
    if (!session) throw new Error('No session');

    setLoading(true);
    setStatus(preview ? 'Rendering preview...' : 'Rendering export...');

    try {
      // Save project first - use refs to get latest state
      const saveResponse = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/project`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tracks: tracksRef.current,
          clips: clipsRef.current,
          settings: settingsRef.current,
          captions: captionDataRef.current,
          timelineTabs: timelineTabsRef.current,
        }),
      });
      if (!saveResponse.ok) {
        const error = await saveResponse.json().catch(() => ({}));
        throw new Error(error.error || 'Failed to save project before render');
      }

      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview, quality, captions: captionDataRef.current }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Render failed');
      }

      const result = await response.json();
      setStatus('Render complete!');

      // Return download URL
      return `${LOCAL_FFMPEG_URL}${result.downloadUrl}`;
    } finally {
      setLoading(false);
      setTimeout(() => setStatus(''), 2000);
    }
  }, [session]);

  // Get total project duration
  const getDuration = useCallback((): number => {
    if (clips.length === 0) return 0;
    return Math.max(...clips.map(c => c.start + c.duration));
  }, [clips]);

  // Create animated GIF from an image asset
  const createGif = useCallback(async (
    sourceAssetId: string,
    options: {
      effect?: 'pulse' | 'zoom' | 'rotate' | 'bounce' | 'fade' | 'shake';
      duration?: number;
      fps?: number;
      width?: number;
      height?: number;
    } = {}
  ): Promise<Asset> => {
    if (!session) throw new Error('No session');

    setLoading(true);
    setStatus('Creating animated GIF...');

    try {
      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/create-gif`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceAssetId,
          ...options,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'GIF creation failed');
      }

      const result = await response.json();
      const asset: Asset = {
        id: result.asset.id,
        type: result.asset.type,
        filename: result.asset.filename,
        duration: result.asset.duration,
        size: result.asset.size,
        width: result.asset.width,
        height: result.asset.height,
        thumbnailUrl: result.asset.thumbnailUrl
          ? `${LOCAL_FFMPEG_URL}${result.asset.thumbnailUrl}`
          : null,
      };

      setAssets(prev => [...prev, asset]);
      setStatus('GIF created!');
      return asset;
    } finally {
      setLoading(false);
      setTimeout(() => setStatus(''), 2000);
    }
  }, [session]);

  // Ensure a real server session exists; create one if needed. Returns the sessionId.
  // Used by agents that need to interact with the server before the user has
  // uploaded their first asset.
  const ensureSession = useCallback(async (): Promise<string> => {
    if (session?.sessionId) return session.sessionId;

    const createResponse = await fetch(`${LOCAL_FFMPEG_URL}/session/create`, {
      method: 'POST',
    });
    if (!createResponse.ok) {
      const error = await createResponse.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to create session');
    }
    const createResult = await createResponse.json();
    const newSession: SessionInfo = {
      sessionId: createResult.sessionId,
      createdAt: Date.now(),
    };
    setSession(newSession);
    return newSession.sessionId;
  }, [session, setSession]);

  // Close session
  const closeSession = useCallback(async (): Promise<void> => {
    if (session) {
      try {
        await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}`, {
          method: 'DELETE',
        });
      } catch {
        // Ignore cleanup errors
      }
    }
    setSession(null);
    setAssets([]);
    setClips([]);
  }, [session, setSession]);

  // Remove all gaps on a specific track by shifting clips to the left (no gaps between them)
  const removeAllGaps = useCallback((trackId: string): void => {
    setClips(prev => {
      const prevSnapshot = [...prev];
      const trackClips = prev.filter(c => c.trackId === trackId);
      const otherClips = prev.filter(c => c.trackId !== trackId);

      // Sort clips by start time, then shift each to just after the previous
      const sorted = [...trackClips].sort((a, b) => a.start - b.start);
      let cursor = 0;
      const shifted = sorted.map(clip => {
        const shiftedClip = { ...clip, start: cursor };
        cursor = cursor + clip.duration;
        return shiftedClip;
      });

      const result = [...otherClips, ...shifted];

      pushUndo({
        label: 'Remove Gaps',
        undo: () => setClips(prevSnapshot),
        redo: () => setClips(result),
      });

      return result;
    });
  }, [pushUndo]);

  // Auto-save when clips change
  // Note: This is commented out to prevent excessive saves during drag operations
  // useEffect(() => {
  //   if (session && clips.length > 0) {
  //     saveProject();
  //   }
  // }, [clips, session, saveProject]);

  return {
    // State
    session,
    assets,
    tracks,
    clips,
    settings,
    loading,
    status,
    serverAvailable,

    // Session
    checkServer,
    createSession,
    ensureSession,
    closeSession,

    // Assets
    uploadAsset,
    deleteAsset,
    getAssetStreamUrl,
    refreshAssets,
    createGif,
    listLocalAssets,
    importLocalAsset,

    // Clips
    addClip,
    updateClip,
    deleteClip,
    moveClip,
    resizeClip,
    splitClip,

    // Captions
    captionData,
    addCaptionClip,
    addCaptionClipsBatch,
    updateCaptionStyle,
    getCaptionData,

    // Project
    saveProject,
    loadProject,
    renderProject,
    getDuration,

    // Setters for direct state manipulation
    setTracks,
    setClips,
    setSettings,

    // Timeline tabs
    timelineTabs,
    activeTabId,
    createTimelineTab,
    switchTimelineTab,
    closeTimelineTab,
    updateTabClips,
    updateTabAsset,
    getActiveTab,

    // Undo/Redo
    undo,
    redo,
    canUndo,
    canRedo,

    // Remove gaps
    removeAllGaps,
  };
}
