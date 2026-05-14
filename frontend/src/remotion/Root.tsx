import React from 'react';
import { Composition } from 'remotion';
import { DynamicAnimation } from './DynamicAnimation';

// Props passed from the CLI via --props
export interface DynamicAnimationProps {
  scenes: Scene[];
  title?: string;
  backgroundColor?: string;
  totalDuration?: number;
}

export interface ShapeConfig {
  type: 'circle' | 'rect' | 'triangle' | 'star' | 'polygon' | 'ellipse';
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  delay?: number;
  radius?: number;
  width?: number;
  height?: number;
  cornerRadius?: number;
  length?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  points?: number;
  innerRadius?: number;
  outerRadius?: number;
  rx?: number;
  ry?: number;
  animation?: 'none' | 'pop' | 'spin' | 'bounce' | 'float' | 'pulse' | 'draw';
}

export interface EmojiConfig {
  emoji: string; // Emoji character or name
  x?: number;
  y?: number;
  scale?: number;
  delay?: number;
  animation?: 'none' | 'pop' | 'bounce' | 'float' | 'pulse' | 'spin' | 'shake' | 'wave';
}

export interface GifConfig {
  src: string; // URL to the GIF
  x?: number; // Position as percentage (0-100)
  y?: number; // Position as percentage (0-100)
  width?: number; // Width in pixels
  height?: number; // Height in pixels
  scale?: number; // Size multiplier
  delay?: number; // Animation delay in frames
  loop?: boolean; // Whether to loop the GIF
  fit?: 'fill' | 'contain' | 'cover';
  playbackRate?: number; // Speed multiplier
  animation?: 'none' | 'pop' | 'bounce' | 'float' | 'pulse' | 'spin' | 'shake';
}

export interface LottieConfig {
  src: string; // URL to Lottie JSON file
  x?: number; // Position as percentage (0-100)
  y?: number; // Position as percentage (0-100)
  width?: number; // Width in pixels
  height?: number; // Height in pixels
  scale?: number; // Size multiplier
  delay?: number; // Animation delay in frames
  loop?: boolean; // Whether to loop
  playbackRate?: number; // Speed multiplier
  direction?: 'forward' | 'backward';
}

export interface Scene {
  id: string;
  type: 'title' | 'steps' | 'features' | 'stats' | 'text' | 'transition' | 'media' | 'chart' | 'countdown' | 'comparison' | 'shapes' | 'emoji' | 'gif' | 'lottie';
  duration: number; // in frames
  content: SceneContent;
  transition?: {
    type: 'none' | 'fade' | 'swipe-left' | 'swipe-right' | 'swipe-up' | 'swipe-down' | 'zoom-in' | 'zoom-out' | 'wipe-left' | 'wipe-right' | 'blur' | 'flip';
    duration?: number;
  };
}

export interface SceneContent {
  // For title/text scenes
  title?: string;
  subtitle?: string;
  // For steps/features scenes
  items?: Array<{
    icon?: string;
    label: string;
    description?: string;
    value?: number;
    color?: string;
  }>;
  // For stats scenes with counting animation
  stats?: Array<{
    value: string;
    label: string;
    numericValue?: number; // For animated counting
    prefix?: string;
    suffix?: string;
  }>;
  // Styling
  color?: string;
  backgroundColor?: string;
  // For shapes scenes
  shapes?: ShapeConfig[];
  shapesLayout?: 'scattered' | 'grid' | 'circle' | 'custom';
  // For emoji scenes
  emojis?: EmojiConfig[];
  emojiLayout?: 'scattered' | 'grid' | 'circle' | 'row' | 'custom';
  // For gif scenes
  gifs?: GifConfig[];
  gifLayout?: 'scattered' | 'grid' | 'circle' | 'row' | 'fullscreen' | 'custom';
  gifBackground?: string; // URL to background GIF
  // For lottie scenes
  lotties?: LottieConfig[];
  lottieLayout?: 'scattered' | 'grid' | 'circle' | 'row' | 'fullscreen' | 'custom';
  lottieBackground?: string; // URL to background Lottie JSON
  // Camera movement (on entire scene)
  camera?: {
    type: 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down' | 'ken-burns' | 'shake';
    intensity?: number;
  };
  // For media scenes - enhanced
  mediaAssetId?: string;
  mediaPath?: string;
  mediaType?: 'image' | 'video';
  mediaStyle?: 'fullscreen' | 'framed' | 'pip' | 'background' | 'split-left' | 'split-right' | 'circle' | 'phone-frame';
  // Video-specific controls
  videoStartFrom?: number; // Start from this frame
  videoEndAt?: number; // End at this frame
  videoVolume?: number; // 0-1
  videoPlaybackRate?: number; // 0.5 = slow-mo, 2 = fast
  videoLoop?: boolean;
  videoMuted?: boolean;
  // Media animation (applied to media itself)
  mediaAnimation?: {
    type: 'none' | 'ken-burns' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down' | 'rotate' | 'parallax';
    intensity?: number;
  };
  // Overlay text on media
  overlayText?: string;
  overlayPosition?: 'top' | 'center' | 'bottom';
  overlayStyle?: 'minimal' | 'bold' | 'gradient-bar';
  // For chart scenes
  chartType?: 'bar' | 'progress' | 'pie' | 'line';
  chartData?: Array<{ label: string; value: number; color?: string }>;
  maxValue?: number;
  // For countdown scenes
  countFrom?: number;
  countTo?: number;
  // For comparison scenes
  beforeLabel?: string;
  afterLabel?: string;
  beforeValue?: string;
  afterValue?: string;
  beforeMedia?: string;
  afterMedia?: string;
}

// Calculate duration from scenes — enforces minimum of 1 frame
// to prevent Remotion from crashing on interpolate([0, 0], ...).
const calculateDuration = (props: DynamicAnimationProps): number => {
  // totalDuration might be 0 (falsy but a valid value), so handle explicitly.
  if (props.totalDuration !== undefined && props.totalDuration !== null) {
    return Math.max(1, props.totalDuration);
  }
  if (props.scenes && props.scenes.length > 0) {
    const sum = props.scenes.reduce((s, scene) => s + Math.max(1, scene.duration || 60), 0);
    return Math.max(1, sum);
  }
  return 300;
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="DynamicAnimation"
        component={DynamicAnimation}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          scenes: [],
          backgroundColor: '#0a0a0a',
        }}
        calculateMetadata={({ props }) => {
          return {
            durationInFrames: calculateDuration(props),
          };
        }}
      />
    </>
  );
};
