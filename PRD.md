# HyperEdit - AI-Powered Video Editor
## Product Requirements Document (PRD)

> **Version:** 2.0  
> **Last Updated:** May 2026  
> **Project Name:** HyperEdit (formerly ClipWise / Patil's Editor)  
> **Platform:** Web Application (React + Node.js)

---

# 1. Executive Summary

## 1.1 Product Vision
HyperEdit is an AI-powered video editor that enables users to create professional-quality video content with minimal effort. It combines the power of AI (DeepSeek, Gemini) with traditional video editing capabilities (FFmpeg, Remotion) to offer a seamless, intelligent editing experience.

## 1.2 Target Audience
- Content creators (YouTubers, TikTok creators)
- Social media managers
- Small business owners
- Marketing teams
- Anyone needing quick video editing without technical expertise

## 1.3 Key Value Propositions
- **One-Click AI Editing:** Magic Auto Edit feature analyzes and edits videos automatically
- **AI-Powered Creativity:** Generate images, videos, animations via AI agents
- **Professional Motion Graphics:** 11+ built-in Remotion templates
- **Real-time Collaboration:** Multi-track timeline with 6 tracks
- **Cloud-Ready:** Deployed on Cloudflare Workers with D1/R2

---

# 2. Product Architecture

## 2.1 Technology Stack

### Frontend
| Technology | Version | Purpose |
|------------|---------|---------|
| React | 19 | UI Framework |
| TypeScript | 5.x | Type Safety |
| Vite | 7.x | Build Tool |
| Tailwind CSS | 3.x | Styling |
| @remotion/player | 4.x | Motion Graphics Preview |
| Lucide React | latest | Icons |

### Backend
| Technology | Purpose |
|------------|---------|
| Node.js (FFmpeg Server) | Video processing, transcription |
| Cloudflare Workers | Production API (Hono) |
| D1 Database | Project metadata storage |
| R2 Storage | Asset/file storage |

### AI/ML Services
| Service | Purpose |
|---------|---------|
| DeepSeek | Video editing decisions, captions |
| Gemini | AI agent commands, animation code generation |
| fal.ai (Picasso) | Image generation |
| fal.ai (DiCaprio) | Video generation (image-to-video, restyle) |
| OpenAI Whisper | Audio transcription |

## 2.2 System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT (React 19)                       │
├─────────────────────────────────────────────────────────────────┤
│  VideoPreview  │  Timeline  │  AssetLibrary  │  AI Panels      │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              useProject (State Management)              │   │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────────────┬──────────────────────────────────┘
                             │ Vite Proxy / Direct
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LOCAL SERVER (Node.js)                       │
├─────────────────────────────────────────────────────────────────┤
│  Sessions  │  Assets  │  Transcription  │  Rendering  │  AI    │
│                                                                 │
│  /session/create    POST /session/{id}/assets                  │
│  POST /transcribe   POST /render   POST /generate-animation    │
└────────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  CLOUDFLARE WORKER (Production)                 │
├─────────────────────────────────────────────────────────────────┤
│  D1 Database  │  R2 Storage  │  AI API (Gemini)                │
└─────────────────────────────────────────────────────────────────┘
```

## 2.3 Data Flow

1. **Asset Upload:** User uploads video → FFmpeg server generates thumbnail → Returns asset metadata
2. **Timeline Editing:** User drags clips → State updates in useProject → Auto-save to server
3. **AI Processing:** User sends prompt → Server calls AI API → Applies edit to timeline
4. **Rendering:** User triggers render → FFmpeg processes timeline → Outputs MP4

---

# 3. Feature Specifications

## 3.1 Core Features

### 3.1.1 Multi-Track Timeline
**Description:** 6-track timeline system for complex video editing

| Track | ID | Purpose | Default Height |
|-------|-----|---------|----------------|
| Captions | T1 | Subtitle/caption track | 48px |
| Overlay Top | V3 | B-roll images, top overlays | 56px |
| Overlay | V2 | AI animations, PiP | 56px |
| Base Video | V1 | Main video content | 56px |
| Audio 2 | A2 | Secondary audio/music | 44px |
| Audio 1 | A1 | Primary audio | 44px |

**Operations:**
- Drag clips to move
- Drag edges to trim
- Split at playhead (I/O keys)
- Delete selected (Delete/Backspace)
- Ripple delete (autoSnap)

**Controls:**
- Zoom: 25% - 400%
- Playback: Play/Pause/Stop
- Frame-by-frame navigation (Shift+Arrow)

### 3.1.2 Asset Library
**Description:** Central repository for all media files

**Features:**
- Drag & drop upload
- Auto thumbnail generation
- Search by filename
- Filter by type (video/image/audio)
- Delete assets
- Multi-file upload

**File Support:**
- Video: MP4, MOV, WebM, AVI
- Image: JPG, PNG, WebP, GIF, SVG
- Audio: MP3, WAV, AAC

**Limits:**
- Max file size: 2GB
- Max files per session: Unlimited (storage dependent)

### 3.1.3 Video Preview
**Description:** Real-time preview of timeline composition

**Features:**
- Multi-layer rendering (V1, V2, V3, T1)
- Transform controls (scale, position, rotation, opacity)
- Aspect ratio support (16:9, 9:16)
- Playback synchronization

### 3.1.4 Caption System
**Description:** Auto-generated captions with styling

**Features:**
- Whisper transcription (word-level timing)
- Style customization (font, size, color, position)
- Animation options (fade, karaoke, pop, bounce, typewriter)
- Time offset adjustment
- Platform presets (YouTube, TikTok, Cinematic)

---

## 3.2 AI Features

### 3.2.1 Auto Edit (Magic Edit)
**Description:** One-click automatic video editing

**Process:**
1. Scene detection (FFmpeg)
2. Speech transcription (Whisper)
3. Audio analysis (beats, silence detection)
4. Mood detection (valence/arousal)
5. AI edit plan (DeepSeek)
6. Apply cuts, transitions, captions
7. Add motion graphics (intro/outro)

**Frontend UI:** AutoEditPanel component

### 3.2.2 AI Director (AIPromptPanel)
**Description:** Natural language video editing commands

**Supported Commands:**
- "Add intro/outro"
- "Remove dead air"
- "Add captions"
- "Generate chapters"
- "Add B-roll"
- "Speed up"
- "Add lower third"

**Preset Commands:** 8 quick-action buttons

### 3.2.3 Picasso (Image Generation)
**Description:** AI-powered image generation via fal.ai

**Model:** nano-banana-pro
**Features:**
- Text-to-image generation
- Style presets
- Aspect ratio options

### 3.2.4 DiCaprio (Video Generation)
**Description:** AI-powered video generation via fal.ai

**Models:**
- Animate Image (Kling v1.5) - Image to video
- Restyle Video (LTX-2 19B) - Video-to-video style transfer
- Remove Background (Bria) - Video background removal

### 3.2.5 Clipify (Shorts Generation)
**Description:** Auto-generate short clips from long videos

**Features:**
- Best segment detection (AI-powered)
- Up to 15 shorts generation
- Manual segment selection
- Background music option
- YouTube URL download

### 3.2.6 HyperFrames
**Description:** AI-powered key frame extraction

**Features:**
- Intelligent key frame detection
- Style transfer options
- Multiple frame extraction

---

## 3.3 Motion Graphics

### 3.3.1 Static Templates (11 built-in)
| Category | Templates |
|----------|-----------|
| Text | Title, Lower Third, Animated Text |
| Engagement | Call to Action, Social Proof, Progress Bar |
| Data | Data Chart, Counter |
| Branding | Logo Reveal, Screen Frame |
| Showcase | Zoom/Pan, Comparison |

### 3.3.2 AI-Generated Animations
**Component:** DynamicAnimation (Remotion)

**Supported Scene Types:**
- title
- steps
- features
- stats
- chart
- countdown
- emoji
- gif
- lottie
- shapes
- hero

---

## 3.4 Rendering & Export

### 3.4.1 Quality Presets
| Preset | Resolution | Bitrate | FPS | Use Case |
|--------|------------|---------|-----|----------|
| Draft | 1280x720 | 2M | 30 | Fast preview |
| Standard | 1920x1080 | 8M | 30 | YouTube ready |
| High | 1920x1080 | 15M | 60 | High quality |
| Ultra | 3840x2160 | 35M | 60 | 4K export |

### 3.4.2 Render Features
- Real-time progress via SSE
- Cancel render option
- Auto-add to timeline on complete

---

## 3.5 Enhancements (Post-Launch)

### 3.5.1 Timeline Markers
- Color-coded markers (red, yellow, green, blue, purple)
- Click to jump to timestamp
- Add via keyboard shortcut (M)

### 3.5.2 Track Locking
- Lock tracks to prevent accidental edits
- Visual indicator for locked tracks

### 3.5.3 Asset Search & Filter
- Search by filename
- Filter by type (all/video/image/audio)

### 3.5.4 Large File Warning
- 2GB max file size validation
- User-friendly error messages

---

# 4. User Interface

## 4.1 Layout Structure

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              TOOLBAR                                        │
│  [Upload] [Save] [Render] [Undo] [Redo] | Zoom | Aspect | Quality          │
├──────────────┬─────────────────────────────────────────────┬────────────────┤
│              │                                             │                │
│   ASSET      │          VIDEO PREVIEW                       │    AI AGENT   │
│   LIBRARY    │                                             │    PANELS     │
│              │                                             │                │
│  - Upload    │    ┌─────────────────────────────┐           │  [Director]   │
│  - Search    │    │                             │           │  [Auto Edit]  │
│  - Filter    │    │       Video Display         │           │  [Picasso]    │
│  - Assets    │    │                             │           │  [DiCaprio]   │
│              │    └─────────────────────────────┘           │  [Clipify]    │
├──────────────┴─────────────────────────────────────────────┤  [HyperFrames]│
│  PROPERTIES  │          TIMELINE                           │                │
│  - Clip      │  ┌─────────────────────────────────────┐    │                │
│  - Caption   │  │ V3 │ V2 │ V1 │ A1 │ A2 │ T1 │       │    │                │
│              │  ├─────────────────────────────────────┤    │                │
│              │  │ ████│    │ ████│ ██ │   │ ██ │       │    │                │
│              │  └─────────────────────────────────────┘    │                │
└──────────────┴─────────────────────────────────────────────┴────────────────┘
```

## 4.2 Component Hierarchy

```
Home (Main Page)
├── Toolbar
├── ResizablePanel (Left - Asset Library)
│   ├── AssetLibrary
│   │   ├── Upload Button
│   │   ├── Search/Filter Bar
│   │   └── Asset Grid
│   └── ResizableVerticalPanel (Properties)
│       ├── ClipPropertiesPanel
│       └── CaptionPropertiesPanel
├── VideoPreview
└── ResizablePanel (Right - AI Agents)
    ├── Agent Tabs (Director, Auto Edit, Picasso, etc.)
    ├── AIPromptPanel
    ├── AutoEditPanel
    ├── PicassoPanel
    ├── DiCaprioPanel
    ├── ClipifyPanel
    └── HyperFramesPanel
```

## 4.3 Key UI Components

| Component | File | Purpose |
|-----------|------|---------|
| Home | pages/Home.tsx | Main editor layout |
| Timeline | components/Timeline.tsx | Timeline with 6 tracks |
| VideoPreview | components/VideoPreview.tsx | Preview playback |
| AssetLibrary | components/AssetLibrary.tsx | Media management |
| AIPromptPanel | components/AIPromptPanel.tsx | AI chat interface |
| MotionGraphicsPanel | components/MotionGraphicsPanel.tsx | Template selection |
| ClipPropertiesPanel | components/ClipPropertiesPanel.tsx | Clip settings |
| CaptionPropertiesPanel | components/CaptionPropertiesPanel.tsx | Caption styling |
| MarkerModal | components/MarkerModal.tsx | Timeline markers |

---

# 5. API Specification

## 5.1 Local FFmpeg Server Endpoints

### Session Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/session/create` | Create new editing session |
| GET | `/session/{id}` | Get session info |
| POST | `/session/{id}/save` | Save project |
| GET | `/session/{id}/load` | Load project |

### Asset Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/session/{id}/assets` | Upload asset |
| GET | `/session/{id}/assets` | List assets |
| DELETE | `/session/{id}/assets/{assetId}` | Delete asset |

### Video Processing
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/session/{id}/transcribe` | Whisper transcription |
| POST | `/session/{id}/render` | Render final video |
| POST | `/session/{id}/remove-dead-air` | Remove silence |
| POST | `/session/{id}/extract-audio` | Split video/audio |

### AI Features
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/session/{id}/auto-edit` | Magic Auto Edit |
| POST | `/session/{id}/generate-image` | Picasso image gen |
| POST | `/session/{id}/generate-video` | DiCaprio video gen |
| POST | `/session/{id}/create-gif` | Animated GIF |
| POST | `/session/{id}/generate-animation` | AI animation |
| POST | `/session/{id}/clipify` | Generate shorts |

### Motion Graphics
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/session/{id}/render-motion-graphic` | Render template |
| POST | `/session/{id}/generate-animation` | AI-generated animation |
| POST | `/session/{id}/edit-animation` | Edit existing animation |

---

# 6. State Management

## 6.1 useProject Hook
**File:** `src/react-app/hooks/useProject.ts`

### Core State
```typescript
interface ProjectState {
  // Session
  session: SessionInfo | null;
  serverAvailable: boolean | null;

  // Assets
  assets: Asset[];
  
  // Timeline
  tracks: Track[];
  clips: TimelineClip[];
  activeTabId: string;
  timelineTabs: TimelineTab[];

  // Playback
  currentTime: number;
  isPlaying: boolean;

  // Captions
  captionData: Record<string, CaptionData>;

  // Project
  projectName: string;
  aspectRatio: '16:9' | '9:16';
}
```

### Key Methods
- `addClip(asset, trackId, start)`
- `moveClip(clipId, newStart, newTrackId)`
- `resizeClip(clipId, newInPoint, newOutPoint)`
- `deleteClip(clipId, ripple)`
- `splitClip(clipId, splitTime)`
- `addCaptionClip(trackId, start, captionData)`
- `renderProject(quality)`

---

# 7. Error Handling

## 7.1 Error Types
| Type | Handling |
|------|----------|
| Network Errors | Retry with exponential backoff |
| Upload Errors | User-friendly alert with message |
| Render Errors | Error panel with retry option |
| AI Errors | Chat panel error display |
| Session Expiry | Auto-redirect to new session |

## 7.2 Empty Catch Blocks Fixed
All 47+ empty catch blocks in local-ffmpeg-server.js now have descriptive comments explaining why the error is swallowed (mostly for cleanup operations).

## 7.3 Keyboard Shortcuts
Fixed to ignore shortcuts when user is typing in input fields (INPUT, TEXTAREA, contenteditable).

---

# 8. Security Considerations

## 8.1 Data Privacy
- Session data stored locally (dev) or in D1/R2 (prod)
- No third-party tracking
- User assets not shared

## 8.2 Input Validation
- File type validation on upload
- Max file size enforcement (2GB)
- Sanitized file names

---

# 9. Performance Targets

| Operation | Target |
|-----------|--------|
| App Load | < 3 seconds |
| Asset Upload (100MB) | < 30 seconds |
| Timeline Response | < 100ms |
| Video Preview | 30fps |
| Render (1080p, 1min) | < 2 minutes |
| Auto Edit (2min video) | < 5 minutes |

---

# 10. Roadmap & Future Features

## Phase 1 (Completed)
- [x] Multi-track timeline (6 tracks)
- [x] Asset library with upload
- [x] AI Director (AIPromptPanel)
- [x] Picasso (image generation)
- [x] DiCaprio (video generation)
- [x] Clipify (shorts generation)
- [x] Motion graphics templates (11)
- [x] AutoEditPanel UI

## Phase 2 (Current)
- [x] Timeline markers
- [x] Track locking
- [x] Asset search/filter
- [x] Large file warning
- [x] AI Director presets
- [x] Caption templates
- [ ] AutoEdit backend implementation
- [ ] Video transitions
- [ ] Video effects

## Phase 3 (Future)
- [ ] Music recommendation
- [ ] Smart cut suggestions
- [ ] Project templates
- [ ] Render queue
- [ ] Direct YouTube upload
- [ ] Team collaboration

---

# 11. Glossary

| Term | Definition |
|------|------------|
| **Timeline** | Horizontal track-based video editing interface |
| **Clip** | Media segment placed on timeline |
| **Track** | Layer in timeline (video/audio/text) |
| **Asset** | Source file in library |
| **Caption** | Subtitles with timing and styling |
| **Motion Graphic** | Animated graphic (via Remotion) |
| **Composition** | Remotion's timeline/sequence container |
| **Session** | Editing session with unique ID |
| **SSE** | Server-Sent Events for real-time updates |

---

# 12. Appendix

## A. File Structure
```
hyperedit/
├── src/
│   ├── react-app/        # Frontend React SPA
│   │   ├── components/   # 20+ React components
│   │   ├── hooks/         # useProject, useFFmpeg, etc.
│   │   └── pages/         # Home.tsx
│   ├── remotion/         # Motion graphics system
│   │   ├── templates/     # 11 built-in templates
│   │   └── DynamicAnimation.tsx
│   └── worker/           # Cloudflare Worker
├── scripts/
│   ├── local-ffmpeg-server.js  # Main server (~8000 lines)
│   └── server/                 # Server modules
├── package.json
└── vite.config.ts
```

## B. Build Commands
```bash
npm install --legacy-peer-deps
npm run dev              # Start Vite dev server
npm run ffmpeg-server    # Start FFmpeg server (port 3333)
npm run build           # Production build
npm run lint            # ESLint
npm run check           # Full validation
```

## C. Environment Variables
```
GEMINI_API_KEY      # Google AI for editing
FAL_API_KEY         # fal.ai for image/video gen
GIPHY_API_KEY       # GIF search
OPENAI_API_KEY      # Additional AI features
```

---

**Document Version:** 2.0  
**Status:** Complete  
**Last Updated:** May 2026