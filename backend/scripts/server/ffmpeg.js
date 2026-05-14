/**
 * FFmpeg/FFprobe helper functions extracted from local-ffmpeg-server.js.
 * All functions are async, returning Promises. No sync exec calls.
 */
import { spawn, spawnSync } from 'child_process';
import { createLogger } from './utils/logger.js';

const log = createLogger('ffmpeg');

/**
 * Run FFmpeg command and return a promise.
 * @param {string[]} args - FFmpeg arguments (excluding 'ffmpeg' binary)
 * @param {string} [jobId] - For logging
 * @param {object} [opts] - { signal?: AbortSignal }
 * @returns {Promise<string>} stderr output
 */
export function runFFmpeg(args, jobId = '', opts = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeout || 600000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`FFmpeg timed out after ${timeoutMs}ms`)), timeoutMs);
    const spawnOpts = { signal: controller.signal };
    const ffmpeg = spawn('ffmpeg', args, spawnOpts);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.includes('time=') || line.includes('frame=')) {
          process.stdout.write(`\r[${jobId}] ${line.trim()}`);
        }
      }
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      process.stdout.write('\n');
      if (code === 0) {
        resolve(stderr);
      } else {
        reject(new Error(`FFmpeg failed with code ${code}: ${stderr.slice(-500)}`));
      }
    });
    ffmpeg.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Run FFprobe command and return stdout.
 * @param {string[]} args
 * @param {string} [jobId]
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
export function runFFprobe(args, jobId = '', opts = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeout || 30000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`FFprobe timed out after ${timeoutMs}ms`)), timeoutMs);
    const ffprobe = spawn('ffprobe', args, { signal: controller.signal });
    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', (data) => { stdout += data.toString(); });
    ffprobe.stderr.on('data', (data) => { stderr += data.toString(); });

    ffprobe.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`FFprobe failed with code ${code}: ${stderr.slice(-500)}`));
      }
    });
    ffprobe.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Run FFprobe synchronously (use sparingly — blocks event loop).
 * Only for non-performance-critical startup operations.
 * Uses spawnSync to avoid shell injection.
 */
export function runFFprobeSync(args) {
  const result = spawnSync('ffprobe', args, { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr || `FFprobe exited with code ${result.status}`);
  return result.stdout;
}

/**
 * Detect silence periods in a video/audio file.
 * @param {string} inputPath
 * @param {string} [jobId]
 * @param {object} [options] - { silenceThreshold, minSilenceDuration }
 * @returns {Promise<Array<{start: number, end: number}>>}
 */
export async function detectSilence(inputPath, jobId = '', options = {}) {
  const silenceThreshold = options.silenceThreshold ?? -40;
  const minSilenceDuration = options.minSilenceDuration ?? 0.5;

  log.info('Detecting silence', { jobId }, `(threshold: ${silenceThreshold}dB, min duration: ${minSilenceDuration}s)`);

  const stderr = await runFFmpeg([
    '-i', inputPath,
    '-af', `silencedetect=noise=${silenceThreshold}dB:d=${minSilenceDuration}`,
    '-f', 'null',
    '-'
  ], jobId);

  const silencePeriods = [];
  const lines = stderr.split('\n');
  let currentStart = null;

  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([\d.]+)/);
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);
    if (startMatch) currentStart = parseFloat(startMatch[1]);
    if (endMatch && currentStart !== null) {
      silencePeriods.push({ start: currentStart, end: parseFloat(endMatch[1]) });
      currentStart = null;
    }
  }

  log.info(`Found ${silencePeriods.length} silence periods`, { jobId });
  return silencePeriods;
}

/**
 * Get media file duration via ffprobe.
 * @param {string} inputPath
 * @returns {Promise<number>} duration in seconds, 0 on failure
 */
export async function getDuration(inputPath) {
  try {
    const stdout = await runFFprobe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ]);
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? 0 : duration;
  } catch {
    return 0;
  }
}

/**
 * Get media dimensions and duration via ffprobe.
 * @param {string} inputPath
 * @returns {Promise<{width: number, height: number, duration: number}>}
 */
export async function getMediaInfo(inputPath) {
  try {
    const result = await runFFprobe([
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration',
      '-of', 'json',
      inputPath,
    ]);
    const info = JSON.parse(result);
    const stream = info.streams?.[0] || {};
    return {
      width: stream.width ?? 0,
      height: stream.height ?? 0,
      duration: parseFloat(stream.duration) || 0,
    };
  } catch {
    return { width: 0, height: 0, duration: 0 };
  }
}

/**
 * Quick check if a media file contains an audio stream.
 */
export function hasAudioStream(filePath) {
  try {
    const result = runFFprobeSync([
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]).trim();
    return result === 'audio';
  } catch {
    return false;
  }
}

/**
 * Calculate segments to keep (inverse of silence periods).
 */
export function calculateKeepSegments(silencePeriods, totalDuration, minSegmentDuration = 0.1) {
  if (silencePeriods.length === 0) {
    return [{ start: 0, end: totalDuration }];
  }
  const keepSegments = [];
  let lastEnd = 0;
  for (const silence of silencePeriods) {
    if (silence.start > lastEnd + minSegmentDuration) {
      keepSegments.push({ start: lastEnd, end: silence.start });
    }
    lastEnd = silence.end;
  }
  if (lastEnd < totalDuration - minSegmentDuration) {
    keepSegments.push({ start: lastEnd, end: totalDuration });
  }
  return keepSegments;
}

/**
 * Generate thumbnail for video/image asset.
 */
export async function generateThumbnail(inputPath, outputPath, isImage = false) {
  if (isImage) {
    await runFFmpeg([
      '-y', '-i', inputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      outputPath,
    ], 'thumb');
  } else {
    const duration = await getDuration(inputPath);
    const seekTime = Math.min(1, duration * 0.1);
    await runFFmpeg([
      '-y', '-ss', String(seekTime),
      '-i', inputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      outputPath,
    ], 'thumb');
  }
}

/**
 * Parse an FFmpeg command string into an args array.
 */
/**
 * Format seconds as ASS timestamp: H:MM:SS.cc
 */
export function formatAssTime(seconds) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const cs = Math.floor((total - Math.floor(total)) * 100);
  const pad = (n) => String(n).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(cs)}`;
}
