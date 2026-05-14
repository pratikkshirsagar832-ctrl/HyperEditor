import { useState, useRef, useCallback } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { LOCAL_FFMPEG_URL } from './useProject';

export function useFFmpeg() {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [useLocalServer, setUseLocalServer] = useState<boolean | null>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);

  // Check if local FFmpeg server is available
  const checkLocalServer = useCallback(async (): Promise<boolean> => {
    if (useLocalServer !== null) return useLocalServer;

    try {
      const response = await fetch(`${LOCAL_FFMPEG_URL}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(1000)
      });
      const data = await response.json();
      const available = data.status === 'ok';
      setUseLocalServer(available);
      console.log(`Local FFmpeg server: ${available ? 'available' : 'not available'}`);
      return available;
    } catch {
      setUseLocalServer(false);
      console.log('Local FFmpeg server: not available, will use WASM');
      return false;
    }
  }, [useLocalServer]);

  const load = useCallback(async () => {
    // Check for local server first
    const hasLocalServer = await checkLocalServer();
    if (hasLocalServer) {
      setLoaded(true);
      console.log('Using local native FFmpeg server');
      return null; // No WASM FFmpeg needed
    }

    if (loaded && ffmpegRef.current) return ffmpegRef.current;
    if (loading) {
      // Wait for existing load to complete
      while (!ffmpegRef.current && loading) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return ffmpegRef.current;
    }

    setLoading(true);
    setStatus('Loading FFmpeg...');
    try {
      console.log('Starting FFmpeg WASM load...');
      const ffmpeg = new FFmpeg();
      ffmpegRef.current = ffmpeg;

      ffmpeg.on('log', ({ message }) => {
        console.log('FFmpeg:', message);
      });

      ffmpeg.on('progress', ({ progress: p }) => {
        const percent = Math.round(p * 100);
        setProgress(percent);
        setStatus(`Processing video... ${percent}%`);
      });

      // Load FFmpeg core from CDN with single-threaded version (no SharedArrayBuffer needed)
      setStatus('Downloading FFmpeg core...');
      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';

      const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
      setStatus('Downloading FFmpeg WASM...');
      const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');

      setStatus('Initializing FFmpeg...');
      await ffmpeg.load({
        coreURL,
        wasmURL,
      });

      setLoaded(true);
      setStatus('');
      console.log('FFmpeg WASM loaded successfully');
      return ffmpeg;
    } catch (error) {
      console.error('Failed to load FFmpeg:', error);
      ffmpegRef.current = null;
      setStatus('');
      throw new Error(`Failed to load FFmpeg: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  }, [loaded, loading, checkLocalServer]);

  // Check if this is a dead air removal command
  const isDeadAirRemovalCommand = (command: string): boolean => {
    const lowerCmd = command.toLowerCase();
    return (
      command.startsWith('REMOVE_DEAD_AIR') ||
      lowerCmd.includes('silenceremove') ||
      lowerCmd.includes('silence') && (lowerCmd.includes('remove') || lowerCmd.includes('dead air'))
    );
  };

  // Remove dead air using specialized endpoint
  const removeDeadAirLocal = useCallback(async (
    inputFile: File,
    options: { silenceThreshold?: number; minSilenceDuration?: number } = {}
  ): Promise<string> => {
    const fileSizeMB = (inputFile.size / (1024 * 1024)).toFixed(1);
    console.log(`[Local FFmpeg] Removing dead air from ${fileSizeMB} MB file`);

    setStatus(`Uploading video for dead air removal (${fileSizeMB} MB)...`);

    const formData = new FormData();
    formData.append('video', inputFile);
    if (options.silenceThreshold) {
      formData.append('silenceThreshold', options.silenceThreshold.toString());
    }
    if (options.minSilenceDuration) {
      formData.append('minSilenceDuration', options.minSilenceDuration.toString());
    }

    setStatus('Detecting silence and removing dead air...');

    const response = await fetch(`${LOCAL_FFMPEG_URL}/remove-dead-air`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Dead air removal failed');
    }

    // Get metadata from headers
    const removedDuration = response.headers.get('X-Removed-Duration');
    const originalDuration = response.headers.get('X-Original-Duration');
    const newDuration = response.headers.get('X-New-Duration');

    if (removedDuration && originalDuration) {
      console.log(`[Local FFmpeg] Removed ${removedDuration}s of dead air`);
      console.log(`[Local FFmpeg] Original: ${originalDuration}s -> New: ${newDuration}s`);
      setStatus(`Removed ${parseFloat(removedDuration).toFixed(1)}s of dead air!`);
      await new Promise(resolve => setTimeout(resolve, 1500)); // Show message briefly
    }

    setStatus('Downloading processed video...');

    const blob = await response.blob();
    console.log('[Local FFmpeg] Blob received, size:', blob.size);

    if (blob.size === 0) {
      throw new Error('Received empty video file from server');
    }

    const url = URL.createObjectURL(blob);
    console.log('[Local FFmpeg] Dead air removal complete:', url);

    setStatus('');
    return url;
  }, []);

  // Process video using local native FFmpeg server
  const processVideoLocal = useCallback(async (
    inputFile: File,
    ffmpegCommand: string
  ): Promise<string> => {
    const fileSizeMB = (inputFile.size / (1024 * 1024)).toFixed(1);
    console.log(`[Local FFmpeg] Processing ${fileSizeMB} MB file`);
    console.log(`[Local FFmpeg] Command: ${ffmpegCommand}`);

    // Check if this is a dead air removal command
    if (isDeadAirRemovalCommand(ffmpegCommand)) {
      console.log('[Local FFmpeg] Detected dead air removal - using specialized endpoint');
      return await removeDeadAirLocal(inputFile);
    }

    setStatus(`Uploading video (${fileSizeMB} MB)...`);

    const formData = new FormData();
    formData.append('video', inputFile);
    formData.append('command', ffmpegCommand);

    const response = await fetch(`${LOCAL_FFMPEG_URL}/process`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Local FFmpeg processing failed');
    }

    setStatus('Downloading processed video...');
    console.log('[Local FFmpeg] Response status:', response.status);
    console.log('[Local FFmpeg] Response headers:', Object.fromEntries(response.headers.entries()));

    const blob = await response.blob();
    console.log('[Local FFmpeg] Blob received, size:', blob.size, 'type:', blob.type);

    if (blob.size === 0) {
      throw new Error('Received empty video file from server');
    }

    const url = URL.createObjectURL(blob);
    console.log('[Local FFmpeg] Created blob URL:', url);

    setStatus('');
    return url;
  }, [removeDeadAirLocal]);

  const processVideo = useCallback(async (
    inputFile: File,
    ffmpegCommand: string
  ): Promise<string> => {
    const fileSizeMB = (inputFile.size / (1024 * 1024)).toFixed(1);
    console.log('processVideo called with command:', ffmpegCommand);
    console.log(`File size: ${fileSizeMB} MB`);
    setProcessing(true);
    setProgress(0);

    try {
      // Check if local server is available
      const hasLocalServer = await checkLocalServer();

      if (hasLocalServer) {
        setStatus('Using native FFmpeg (fast mode)...');
        return await processVideoLocal(inputFile, ffmpegCommand);
      }

      // Fall back to WASM
      console.log('Using FFmpeg WASM (slower for large files)');

      // Load FFmpeg if not already loaded
      if (!ffmpegRef.current || !loaded) {
        setStatus('Loading FFmpeg (first time may take ~30s)...');
        await load();
      }

      const ffmpeg = ffmpegRef.current;
      if (!ffmpeg) {
        throw new Error('FFmpeg failed to initialize');
      }

      // Get file extension
      const inputExt = inputFile.name.split('.').pop() || 'mp4';
      const inputName = `input.${inputExt}`;
      const outputName = 'output.mp4';

      // Write input file to FFmpeg filesystem
      // Use FileReader with progress for better feedback on large files
      setStatus(`Reading video file (${fileSizeMB} MB)...`);
      console.log('Reading input file...');

      const fileData = await new Promise<Uint8Array>((resolve, reject) => {
        const reader = new FileReader();
        reader.onprogress = (event) => {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            setStatus(`Reading video file... ${percent}%`);
            console.log(`File read progress: ${percent}%`);
          }
        };
        reader.onload = () => {
          resolve(new Uint8Array(reader.result as ArrayBuffer));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(inputFile);
      });

      setStatus('Writing to FFmpeg memory...');
      console.log('Writing input file to FFmpeg FS...');
      await ffmpeg.writeFile(inputName, fileData);
      console.log('Input file written successfully');

      // Parse and execute the FFmpeg command
      // Replace input.mp4/output.mp4 placeholders with actual filenames
      const args = ffmpegCommand
        .replace(/^ffmpeg\s+/, '') // Remove "ffmpeg" prefix
        .replace(/input\.[a-z0-9]+/gi, inputName)
        .replace(/output\.[a-z0-9]+/gi, outputName);

      // Split into arguments array
      const argList = parseFFmpegArgs(args);

      setStatus('Processing video...');
      console.log('Running FFmpeg with args:', argList);

      const result = await ffmpeg.exec(argList);
      console.log('FFmpeg exec result:', result);

      // Read the output file
      setStatus('Saving processed video...');
      const data = await ffmpeg.readFile(outputName);
      const blob = new Blob([data], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      console.log('Output video created:', url);

      // Clean up
      try {
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);
      } catch (e) {
        console.log('Cleanup warning:', e);
      }

      setStatus('');
      return url;
    } catch (error) {
      console.error('FFmpeg processing error:', error);
      setStatus('');
      throw new Error(`Video processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setProcessing(false);
      setProgress(0);
    }
  }, [load, loaded, checkLocalServer, processVideoLocal]);

  // Generate chapters from video using AI
  const generateChapters = useCallback(async (
    inputFile: File
  ): Promise<{
    chapters: Array<{ start: number; title: string }>;
    youtubeFormat: string;
    summary: string;
    videoDuration: number;
  }> => {
    const fileSizeMB = (inputFile.size / (1024 * 1024)).toFixed(1);
    console.log(`[Chapters] Generating chapters for ${fileSizeMB} MB file`);

    setProcessing(true);
    setProgress(0);
    setStatus(`Uploading video for chapter analysis (${fileSizeMB} MB)...`);

    try {
      const formData = new FormData();
      formData.append('video', inputFile);

      setStatus('Analyzing video content and generating chapters...');

      const response = await fetch(`${LOCAL_FFMPEG_URL}/generate-chapters`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Chapter generation failed');
      }

      const result = await response.json();
      console.log('[Chapters] Generated:', result);

      setStatus(`Generated ${result.chapters?.length || 0} chapters!`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      setStatus('');

      return result;
    } catch (error) {
      console.error('Chapter generation error:', error);
      setStatus('');
      throw new Error(`Chapter generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setProcessing(false);
      setProgress(0);
    }
  }, []);

  return {
    loaded,
    loading,
    processing,
    progress,
    status,
    load,
    processVideo,
    generateChapters,
  };
}

// Parse FFmpeg command string into arguments array, handling quoted strings
function parseFFmpegArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

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
