/**
 * HyperFrames Renderer Module
 *
 * Integrates HyperFrames HTML-to-video rendering into HyperEdit.
 * Two main exports:
 * 1. renderHyperframesComposition — renders HTML to MP4 via @hyperframes/producer
 * 2. generateHyperframesComposition — uses DeepSeek AI to generate HTML from prompt
 */
import path from 'path';
import fs from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createLogger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..'); // scripts/server/ → project root
const HF_CLI_BIN = path.resolve(PROJECT_ROOT, 'hyperframes-main', 'hyperframes-main', 'packages', 'cli', 'dist', 'cli.js');

const log = createLogger('hyperframes');

/**
 * Generate a HyperFrames HTML composition from a text prompt using DeepSeek AI.
 *
 * @param {object} options
 * @param {string} options.prompt - User's description of the video
 * @param {number} [options.duration=10] - Video duration in seconds
 * @param {number} [options.width=1920] - Output width
 * @param {number} [options.height=1080] - Output height
 * @param {string} [options.style='modern'] - Visual style (modern|minimal|bold|corporate|playful|cinematic)
 * @param {string} [options.transcript=''] - Optional transcript for context
 * @param {Array} [options.assets=[]] - Optional available assets
 * @returns {Promise<string>} The generated HTML string
 */
export async function generateHyperframesComposition({
  prompt,
  duration = 10,
  width = 1920,
  height = 1080,
  style = 'modern',
  transcript = '',
  assets = [],
}) {
  const { generateWithDeepSeek } = await import('./ai-deepseek.js');

  const styleGuide = {
    modern: 'Clean sans-serif, minimal, lots of whitespace, subtle shadows, accent color #6366f1 (indigo)',
    minimal: 'Ultra minimal, black and white, thin fonts, lots of negative space, subtle fade transitions',
    bold: 'Large bold typography, high contrast colors, dramatic animations, accent colors #ef4444 (red) and #f97316 (orange)',
    corporate: 'Professional blue tones (#2563eb), structured layouts, clean sans-serif, subtle slide transitions',
    playful: 'Rounded corners, bright colors (#ec4899 pink, #8b5cf6 purple), bouncy animations, fun emoji',
    cinematic: 'Dark backgrounds, gold accent (#f59e0b), serif fonts for titles, dramatic slow fades, letterbox bars',
  };

  const systemPrompt = `You are a HyperFrames HTML video composition expert. Generate a complete, self-contained HTML page that creates a motion graphics video.

STYLE: ${styleGuide[style] || styleGuide.modern}

SPECIFICATIONS:
- Duration: ${duration} seconds
- Resolution: ${width}x${height}
- Background: dark (#0f0f0f or similar dark tone)
- Font: system-ui, sans-serif

REQUIRED FORMAT:
1. Root element: <div id="stage" data-composition-id="comp1" data-width="${width}" data-height="${height}">
2. All animated elements MUST have:
   - data-start="seconds" — when the element appears
   - data-duration="seconds" — how long it stays visible
   - data-track-index="number" — z-index layering (higher = on top)
3. GSAP is available as a global: gsap
4. Use Tailwind CSS v4 browser runtime CDN: <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
5. Include GSAP CDN: <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
6. Register GSAP animations on window load for timeline seeking support
7. Style your elements with inline styles or Tailwind classes
8. The video will be rendered at 30 fps

KEYFRAME ANIMATION APPROACH:
- Use CSS @keyframes for simple animations (fade in, slide, scale)
- Use GSAP for complex timeline animations
- Register GSAP animations like: window.__hfAnimations = gsap.timeline()
- Each element should have a smooth entrance and exit

DESIGN GUIDELINES:
- Create visually stunning compositions, not just text on background
- Use gradients, overlapping elements, geometric shapes
- Each scene should feel deliberate and polished
- Text should be large and readable
- Use color overlays and semi-transparent backgrounds for text readability`;

  const userPrompt = transcript
    ? `Create a HyperFrames HTML video composition for this prompt: "${prompt}"

Additional context — this video will appear alongside content with this transcript:
"${transcript.substring(0, 500)}"

Duration: ${duration} seconds at ${width}x${height}.
Style: ${style}.

Return ONLY the complete HTML as a raw string. No markdown, no explanations.`
    : `Create a HyperFrames HTML video composition for this prompt: "${prompt}"

Duration: ${duration} seconds at ${width}x${height}.
Style: ${style}.

Return ONLY the complete HTML as a raw string. No markdown, no explanations.`;

  log.info(`Generating HTML composition for prompt: "${prompt.substring(0, 80)}..."`);

  const result = await generateWithDeepSeek({
    systemInstruction: systemPrompt,
    prompt: userPrompt,
  });

  // Extract HTML from the response
  let html = '';
  if (typeof result === 'string') {
    html = result;
  } else if (result?.text) {
    html = result.text;
  } else if (result?.candidates?.[0]?.content?.parts?.[0]?.text) {
    html = result.candidates[0].content.parts[0].text;
  } else {
    html = JSON.stringify(result);
  }

  // Strip code fences if present
  html = html.replace(/```html\n?/gi, '').replace(/```\n?/g, '').trim();

  if (!html || html.length < 50) {
    throw new Error('DeepSeek returned empty or invalid HTML');
  }

  log.info(`Generated HTML (${html.length} bytes)`);
  return html;
}

/**
 * Render an HTML composition to MP4 using HyperFrames producer or CLI fallback.
 *
 * @param {object} options
 * @param {string} options.htmlContent - The HTML string to render
 * @param {string} options.outputPath - Path for the output MP4 file
 * @param {number} [options.width=1920] - Output width
 * @param {number} [options.height=1080] - Output height
 * @param {number} [options.fps=30] - Frames per second
 * @param {function} [options.onProgress] - Progress callback(percent)
 * @param {AbortSignal} [options.signal] - Abort signal for cancellation
 * @returns {Promise<string>} The outputPath on success
 */
export async function renderHyperframesComposition({
  htmlContent,
  outputPath,
  width = 1920,
  height = 1080,
  fps = 30,
  onProgress,
  signal,
}) {
  const jobId = randomUUID().substring(0, 8);
  const tempDir = path.join(tmpdir(), 'hyperedit-hf');
  await fs.promises.mkdir(tempDir, { recursive: true });

  // Write HTML to temp file
  const htmlPath = path.join(tempDir, `composition-${jobId}.html`);
  await fs.promises.writeFile(htmlPath, htmlContent, 'utf-8');

  log.info(`Rendering HTML composition: ${outputPath}`, { jobId });

  // Ensure output directory exists
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  // Try CLI render (preferred method since packages use bun workspace deps)
  await renderWithCLI({
    htmlPath,
    outputPath,
    width,
    height,
    fps,
    onProgress,
    signal,
    jobId,
  });

  // Cleanup temp HTML
  try { await fs.promises.unlink(htmlPath); } catch { /* html cleanup */ }

  // Verify output
  try {
    await fs.promises.access(outputPath);
    const stats = await fs.promises.stat(outputPath);
    if (stats.size === 0) throw new Error('Output file is empty');
  } catch (err) {
    throw new Error(`Render failed: ${err.message}`);
  }

  log.info(`Render complete: ${outputPath}`, { jobId });
  return outputPath;
}

/**
 * Render using the HyperFrames CLI.
 */
async function renderWithCLI({
  htmlPath,
  outputPath,
  width,
  height,
  fps,
  onProgress,
  signal,
  jobId,
}) {
  return new Promise((resolve, reject) => {
    // Check if CLI binary exists
    let binPath = HF_CLI_BIN;
    let useNpx = false;

    if (!fs.existsSync(binPath)) {
      // Try npx fallback
      useNpx = true;
    }

    const args = useNpx
      ? ['hyperframes', 'render', htmlPath, '-o', outputPath, '--width', String(width), '--height', String(height), '--fps', String(fps)]
      : [binPath, 'render', htmlPath, '-o', outputPath, '--width', String(width), '--height', String(height), '--fps', String(fps)];

    const cmd = useNpx ? 'npx' : 'node';

    if (onProgress) onProgress(10, 'Starting CLI render...');

    const proc = spawn(cmd, args, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // shell needed on Windows for PATH resolution
    });

    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      // Parse progress: look for percentage patterns
      const match = text.match(/(\d+)%/);
      if (match && onProgress) {
        onProgress(Math.min(parseInt(match[1], 10), 95), 'Rendering...');
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      // CLI sometimes outputs progress to stderr
      const match = stderr.match(/(\d+)%/);
      if (match && onProgress) {
        onProgress(Math.min(parseInt(match[1], 10), 95), 'Rendering...');
      }
    });

    if (signal) {
      const onAbort = () => {
        proc.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
        reject(Object.assign(new Error('Render cancelled'), { code: 'CANCELLED' }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.on('close', (code) => {
      if (code === 0) {
        if (onProgress) onProgress(100, 'Complete!');
        resolve();
      } else {
        reject(new Error(`CLI render failed (exit ${code}): ${stderr.slice(-300)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start HyperFrames CLI: ${err.message}`));
    });
  });
}
