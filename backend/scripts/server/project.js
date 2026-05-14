/**
 * Project — save, load, render.
 * Extracted from local-ffmpeg-server.js.
 */
import { join } from 'path';
import fs, { existsSync } from 'fs';
import { getSession, getCachedSession } from './session.js';
import { runFFmpeg, formatAssTime, hasAudioStream } from './ffmpeg.js';
import { libassColor, captionAlignment } from './captions.js';
import { sendError, sendSuccess } from './middleware.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('project');

/**
 * Get project state.
 */
export function handleProjectGet(req, res, sessionId) {
  const session = getCachedSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }
  if (!existsSync(session.dir)) {
    sendError(res, 410, 'Session files no longer exist');
    return;
  }

  sendSuccess(res, {
    tracks: session.project.tracks,
    clips: session.project.clips,
    settings: session.project.settings,
    captions: session.project.captions || {},
    timelineTabs: session.project.timelineTabs || [],
    version: session.project.version || 0,
  });
}

/**
 * Save project state with Zod validation.
 */
export async function handleProjectSave(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);

    const { ProjectSchema } = await import('./schemas.js');
    const validation = ProjectSchema.safeParse(data);
    if (!validation.success) {
      const details = validation.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      sendError(res, 400, `Invalid project data: ${details}`);
      return;
    }

    // Version conflict detection — prevent concurrent save overwrites
    const clientVersion = data.version ?? 0;
    const serverVersion = session.project.version ?? 0;
    if (clientVersion > 0 && clientVersion < serverVersion) {
      sendError(res, 409, 'Version conflict — project was modified elsewhere. Please refresh.');
      return;
    }

    if (data.tracks) session.project.tracks = data.tracks;
    if (data.clips) session.project.clips = data.clips;
    if (data.settings) session.project.settings = { ...session.project.settings, ...data.settings };
    if (data.timelineTabs) session.project.timelineTabs = data.timelineTabs;
    if (data.captions) session.project.captions = data.captions;
    session.project.version = (session.project.version ?? 0) + 1;

    const projectPath = join(session.dir, 'project.json');
    await fs.promises.writeFile(projectPath, JSON.stringify(session.project, null, 2));

    log.info(`Project saved: ${session.project.clips.length} clips`, { jobId: sessionId });
    sendSuccess(res, { success: true });
  } catch (error) {
    sendError(res, 500, error.message);
  }
}

/**
 * Build an .ass subtitle file from caption clips.
 */
export function buildAssFromCaptions(clips, captions, settings) {
  const captionClips = clips
    .filter(c => c.trackId === 'T1')
    .filter(c => captions && captions[c.id]?.words?.length)
    .sort((a, b) => a.start - b.start);

  if (captionClips.length === 0) return null;

  const styled = captionClips.find(c => captions[c.id]?.style);
  const style = (styled && captions[styled.id].style) || {};
  const previewRefHeight = 650;
  const fontPx = Math.max(8, Math.round((style.fontSize || 24) * settings.height / previewRefHeight));
  const outlineWidth = Math.max(1, Math.round((style.strokeWidth ?? 2) * settings.height / previewRefHeight));
  const fontName = (style.fontFamily || 'Arial').replace(/[,&]/g, '');
  const primaryColor = libassColor(style.color || '#FFFFFF');
  const outlineColor = libassColor(style.strokeColor || '#000000');
  const alignment = captionAlignment(style.position);
  const marginV = Math.round(settings.height * 0.08);
  const bold = (style.fontWeight === 'bold' || style.fontWeight === 'black') ? -1 : 0;

  const lines = [
    '[Script Info]', 'Title: HyperEdit Captions', 'ScriptType: v4.00+',
    `PlayResX: ${settings.width}`, `PlayResY: ${settings.height}`,
    'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${fontPx},${primaryColor},&H000000FF,${outlineColor},&H00000000,${bold},0,0,0,100,100,0,0,1,${outlineWidth},0,${alignment},20,20,${marginV},1`,
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (const clip of captionClips) {
    const data = captions[clip.id];
    const text = data.words.map(w => w.text).join(' ').trim();
    if (!text) continue;
    const escaped = text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
    const start = formatAssTime(clip.start);
    const end = formatAssTime(clip.start + clip.duration);
    lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${escaped}`);
  }
  return lines.join('\n');
}
