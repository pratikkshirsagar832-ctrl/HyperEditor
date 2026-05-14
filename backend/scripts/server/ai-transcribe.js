/**
 * Transcription service — uses local Whisper or Groq Whisper API.
 * Extracted from local-ffmpeg-server.js.
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import fs from 'fs';
import { runFFmpeg, runFFprobe } from './ffmpeg.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('transcribe');
const TEMP_DIR = join(tmpdir(), 'hyperedit-ffmpeg');

/**
 * Check if local Whisper is available (cross-platform, no shell injection).
 */
async function checkLocalWhisper() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return await new Promise((resolve) => {
      const proc = spawn(cmd, ['whisper'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.on('close', (code) => resolve(code === 0 && out.trim().length > 0));
      proc.on('error', () => resolve(false));
    });
  } catch { return false; }
}

/**
 * Run local Whisper transcription (cross-platform, no shell injection).
 */
async function runLocalWhisper(audioPath, jobId = '') {
  return new Promise((resolve, reject) => {
    const proc = spawn('whisper', [audioPath, '--model', 'base', '--language', 'en', '--output_format', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', async (code) => {
      if (code !== 0) {
        log.warn(`Whisper exited with code ${code}`, { jobId }, stderr.slice(-200));
        reject(new Error(`Whisper failed (code ${code}): ${stderr.slice(-200)}`));
        return;
      }
      const jsonPath = audioPath.replace(/\.\w+$/, '.json');
      try {
        await fs.promises.access(jsonPath);
        const data = JSON.parse(await fs.promises.readFile(jsonPath, 'utf-8'));
        await fs.promises.unlink(jsonPath).catch(() => {});
        resolve({
          text: data.text || '',
          words: (data.segments || []).flatMap(s =>
            (s.words || []).map(w => ({ text: w.word, start: w.start, end: w.end }))
          ),
        });
      } catch {
        // Fallback: parse stdout directly
        resolve({ text: stdout.trim(), words: [] });
      }
    });
    proc.on('error', reject);
  });
}

/**
 * Get or transcribe a video asset, caching the result.
 */
export async function getOrTranscribeVideo(session, videoAsset, jobId = '') {
  if (session.transcriptCache.has(videoAsset.id)) {
    const cached = session.transcriptCache.get(videoAsset.id);
    log.info(`Using cached transcript for ${videoAsset.filename}`, { jobId });
    return { text: cached.text, words: cached.words };
  }

  log.info(`Transcribing ${videoAsset.filename}...`, { jobId });

  const hasLocalWhisper = await checkLocalWhisper();
  const groqKey = process.env.GROQ_API_KEY;

  if (!hasLocalWhisper && !groqKey) {
    log.warn('No transcription service available', { jobId });
    return { text: '', words: [] };
  }

  const audioPath = join(TEMP_DIR, `${jobId}-transcript-audio.mp3`);

  let hasAudio = false;
  try {
    const probeResult = await runFFprobe(['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', videoAsset.path]);
    hasAudio = probeResult && probeResult.trim().length > 0;
  } catch (err) { console.debug('FFprobe check failed:', err?.message); }
  if (!hasAudio) {
    log.info('Video has no audio track', { jobId });
    try { await fs.promises.unlink(audioPath).catch(() => {}); } catch { /* audio cleanup */ }
    return { text: '', words: [] };
  }

  try {
    await runFFmpeg(['-y', '-i', videoAsset.path, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', audioPath], jobId);
  } catch {
    log.warn('Audio extraction failed', { jobId });
    try { await fs.promises.unlink(audioPath).catch(() => {}); } catch { /* audio cleanup */ }
    return { text: '', words: [] };
  }

  let transcription = { text: '', words: [] };

  if (hasLocalWhisper) {
    try {
      log.info('Using local Whisper...', { jobId });
      transcription = await runLocalWhisper(audioPath, jobId);
    } catch (whisperError) {
      log.warn('Local Whisper failed, falling through to Groq', { jobId });
    }
  }

  if (!transcription.text && groqKey) {
    try {
      log.info('Using Groq Whisper API...', { jobId });
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

      if (groqResponse.ok) {
        const groqResult = await groqResponse.json();
        transcription = {
          text: groqResult.text || '',
          words: (groqResult.words || []).map(w => ({
            text: w.word || w.text || '', start: w.start || 0, end: w.end || 0,
          })),
        };
      } else {
        log.warn(`Groq Whisper failed (${groqResponse.status})`, { jobId });
      }
    } catch (groqError) {
      log.warn('Groq Whisper error', { jobId }, groqError);
    }
  }

  try { await fs.promises.unlink(audioPath).catch(() => {}); } catch { /* audio cleanup */ }

  session.transcriptCache.set(videoAsset.id, {
    text: transcription.text, words: transcription.words || [], cachedAt: Date.now(),
  });

  log.info(`Transcription cached: ${transcription.text.substring(0, 100)}...`, { jobId });
  return transcription;
}

