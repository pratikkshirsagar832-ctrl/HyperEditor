/**
 * YouTube video downloader via yt-dlp.
 * Wraps yt-dlp as a child process with progress parsing.
 */
import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

let ytDlpAvailable = null; // null = not checked yet

/**
 * Check if yt-dlp is installed.
 * @returns {Promise<boolean>}
 */
export async function isYtDlpAvailable() {
  if (ytDlpAvailable !== null) return ytDlpAvailable;
  return new Promise((resolve) => {
    const check = spawn('yt-dlp', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    check.stdout.on('data', (d) => { output += d.toString(); });
    check.on('close', (code) => {
      ytDlpAvailable = code === 0 && output.trim().length > 0;
      resolve(ytDlpAvailable);
    });
    check.on('error', () => {
      ytDlpAvailable = false;
      resolve(false);
    });
  });
}

/**
 * Download a YouTube video to a directory.
 * @param {string} url - YouTube URL
 * @param {string} outputDir - Directory to save the video
 * @param {function} [onProgress] - Callback(percent: number)
 * @param {string} [jobId] - For logging
 * @returns {Promise<string>} Path to downloaded video file
 */
export async function downloadYouTubeVideo(url, outputDir, onProgress, jobId = '') {
  if (!await isYtDlpAvailable()) {
    throw new Error('yt-dlp is not installed. Install it with: pip install yt-dlp');
  }

  return new Promise((resolve, reject) => {
    const outputTemplate = join(outputDir, '%(title)s.%(ext)s');
    const proc = spawn('yt-dlp', [
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '-o', outputTemplate,
      '--no-playlist',
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let downloadedFile = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      // yt-dlp outputs progress lines like: [download] 45.2% of ~50.00MiB
      const match = text.match(/(\d+\.?\d*)%/);
      if (match && onProgress) {
        onProgress(parseFloat(match[1]));
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp failed (exit ${code}): ${stderr.slice(-200)}`));
        return;
      }
      // yt-dlp outputs the final filename in the last stderr line
      // e.g., "[download] Destination: /path/to/video.mp4"
      const destMatch = stderr.match(/\[download\]\s+Destination:\s+(.+)/i);
      if (destMatch) {
        downloadedFile = destMatch[1].trim();
      } else {
        // Fallback: list output dir for the newest mp4
        const files = readdirSync(outputDir).filter(f => f.endsWith('.mp4'));
        if (files.length > 0) {
          downloadedFile = join(outputDir, files[files.length - 1]);
        }
      }

      if (!downloadedFile || !existsSync(downloadedFile)) {
        reject(new Error('Could not find downloaded video file'));
        return;
      }

      if (onProgress) onProgress(100);
      resolve(downloadedFile);
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });
  });
}

export default { downloadYouTubeVideo, isYtDlpAvailable };
