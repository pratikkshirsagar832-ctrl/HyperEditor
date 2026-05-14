# HyperEdit — AI-Powered Video Editor

Browser-based video editor with AI animations, HyperFrames HTML-to-video rendering, and Clipify short-form content generation.

## Quick Start (Ubuntu 26.04)

```bash
# 1. Run the startup script (installs deps + starts both servers)
./start.sh
```

Open http://localhost:5173

## Manual Start

```bash
# Install dependencies
cd frontend && npm install --legacy-peer-deps && cd ..
cd backend && npm install && cd ..

# Start backend (FFmpeg server on port 3333)
cd backend && node scripts/local-ffmpeg-server.js

# Start frontend (Vite dev server on port 5173) - in separate terminal
cd frontend && npx vite --host 0.0.0.0
```

## Project Structure

```
hyperedit/
├── frontend/             # React SPA + Remotion motion graphics
│   ├── src/
│   │   ├── react-app/    # UI components, hooks, pages
│   │   ├── remotion/     # Motion graphics templates (11)
│   │   └── types/        # TypeScript type definitions
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
├── backend/              # Node.js FFmpeg server + Cloudflare Worker
│   ├── scripts/
│   │   ├── local-ffmpeg-server.js  # Main server (~7800 lines)
│   │   ├── server/                 # Server modules
│   │   ├── clipify/                # Short-form clip generation
│   │   └── whisper-transcribe.py   # Local Whisper transcription
│   ├── src/worker/       # Cloudflare Worker (Hono API)
│   ├── hyperframes-main/ # HTML→video engine
│   ├── wrangler.json
│   └── package.json
├── start.sh              # One-command startup script
├── package.json          # Root convenience scripts
└── README.md
```

## API Keys

Set in `backend/.dev.vars`:

```
DEEPSEEK_API_KEY=...   # Required: AI animations, chapters, segments
GROQ_API_KEY=...        # Required: Whisper transcription
FAL_API_KEY=...         # Optional: Image/video generation
GIPHY_API_KEY=...       # Optional: GIF search
```

## Features

- **Timeline Editor** — Multi-track (6 tracks), drag-drop, trim, speed
- **HyperFrames** — Describe a video in text → AI generates HTML → renders to MP4
- **Clipify** — YouTube URL or video → auto-generated short clips
- **AI Animations** — Text prompt → Remotion motion graphics
- **AI Images** — Text prompt → FAL AI image generation
- **AI Video** — Image-to-video, style transfer via FAL AI
- **GIF Search** — GIPHY integration for adding GIFs to timeline
- **SSE Progress** — Real-time job progress with cancel support

## Tech Stack

React 19 · TypeScript 5 · Vite 7 · Remotion 4 · Tailwind CSS 3 · Node.js 22 · FFmpeg · DeepSeek AI · Groq Whisper · FAL AI · GIPHY · HyperFrames
