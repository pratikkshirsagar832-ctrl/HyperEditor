import { useState, useEffect, useRef, useCallback } from 'react';
import { Scissors, Youtube, Film, Settings, Loader2, CheckCircle, XCircle, Plus, Image as ImageIcon } from 'lucide-react';
import { LOCAL_FFMPEG_URL } from '@/react-app/hooks/useProject';

interface Asset {
  id: string;
  filename: string;
  type: 'video' | 'image' | 'audio';
  thumbnailUrl?: string | null;
  duration?: number;
}

interface GeneratedShort {
  assetId: string;
  start: number;
  end: number;
  duration: number;
  reason: string;
  path?: string;
  filename?: string;
}

interface ClipifyPanelProps {
  sessionId: string | null;
  assets: Asset[];
  onShortsGenerated?: (assetIds: string[]) => void;
  onRefreshAssets?: () => void;
}

export default function ClipifyPanel({ sessionId, assets, onShortsGenerated, onRefreshAssets }: ClipifyPanelProps) {
  const [sourceMode, setSourceMode] = useState<'library' | 'youtube'>('library');
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [maxShorts, setMaxShorts] = useState(5);
  const [minDuration, setMinDuration] = useState(30);
  const [aspectRatio, setAspectRatio] = useState<'9:16' | '16:9' | '1:1' | 'none'>('9:16');
  const [withCaptions, setWithCaptions] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ percent: number; step: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<GeneratedShort[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const progressRef = useRef<EventSource | null>(null);

  const videoAssets = assets.filter(a => a.type === 'video');

  // Auto-select first video
  useEffect(() => {
    if (sourceMode === 'library' && !selectedAssetId && videoAssets.length > 0) {
      setSelectedAssetId(videoAssets[0].id);
    }
  }, [sourceMode, videoAssets, selectedAssetId]);

  // SSE progress listener
  useEffect(() => {
    if (!jobId || !sessionId) return;

    const es = new EventSource(`${LOCAL_FFMPEG_URL}/api/v1/session/${sessionId}/progress`);
    progressRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.jobId === jobId && data.type === 'progress') {
          setProgress({ percent: data.percent || 0, step: data.step || '' });
          if (data.percent >= 100) {
            es.close();
          }
        }
      } catch {
        // Ignore SSE errors during normal operation
      }
    };

    es.onerror = () => {
      // SSE connection closed normally
    };

    return () => { es.close(); };
  }, [jobId, sessionId]);

  const handleGenerate = useCallback(async () => {
    if (!sessionId) return;
    if (sourceMode === 'youtube' && !youtubeUrl.trim()) return;
    if (sourceMode === 'library' && !selectedAssetId && videoAssets.length === 0) return;

    setGenerating(true);
    setError(null);
    setResults([]);
    setProgress({ percent: 0, step: 'Starting...' });

    try {
      const body: Record<string, unknown> = {
        maxShorts,
        minSegmentDuration: minDuration,
        aspectRatio,
        withCaptions,
      };

      if (sourceMode === 'youtube') {
        body.youtubeUrl = youtubeUrl.trim();
      } else if (selectedAssetId) {
        body.assetId = selectedAssetId;
      }

      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${sessionId}/generate-shorts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Generation failed');
      }

      setJobId(data.jobId || null);

      // Poll for results
      const pollForResults = async () => {
        const jobResult = await fetch(`${LOCAL_FFMPEG_URL}/api/v1/session/${sessionId}/jobs/${data.jobId}`);
        const jobData = await jobResult.json();
        if (jobData.status === 'completed') {
          setProgress({ percent: 100, step: 'Complete!' });
          const shorts = jobData.result?.shorts || [];
          setResults(shorts);
          if (onShortsGenerated) {
            onShortsGenerated(shorts.map((s: GeneratedShort) => s.assetId));
          }
          if (onRefreshAssets) onRefreshAssets();
          setGenerating(false);
        } else if (jobData.status === 'failed') {
          throw new Error(jobData.error || 'Generation failed');
        } else {
          setTimeout(pollForResults, 1000);
        }
      };

      setTimeout(pollForResults, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setGenerating(false);
      setProgress(null);
    }
  }, [sessionId, sourceMode, youtubeUrl, selectedAssetId, maxShorts, minDuration, aspectRatio, withCaptions, videoAssets.length, onShortsGenerated, onRefreshAssets]);

  const handleAddToTimeline = useCallback((short: GeneratedShort) => {
    console.log('Add to timeline:', short.assetId);
    // This would call addClip — the parent listens for refresh
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-3 py-3 border-b border-zinc-800/50">
        <h2 className="text-base font-semibold text-zinc-200 flex items-center gap-2">
          <Scissors className="w-4 h-4" />
          Clipify
        </h2>
        <p className="text-xs text-zinc-500 mt-1">
          Turn long videos into short clips
        </p>
      </div>

      {/* Source Mode Toggle */}
      <div className="px-3 py-2 border-b border-zinc-800/30">
        <div className="flex items-center gap-1 bg-zinc-800/50 rounded-lg p-0.5">
          <button
            onClick={() => setSourceMode('library')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${
              sourceMode === 'library'
                ? 'bg-zinc-700 text-zinc-200 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-300'
            }`}
          >
            <Film className="w-3 h-3" />
            Library
          </button>
          <button
            onClick={() => setSourceMode('youtube')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${
              sourceMode === 'youtube'
                ? 'bg-zinc-700 text-zinc-200 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-300'
            }`}
          >
            <Youtube className="w-3 h-3" />
            YouTube
          </button>
        </div>
      </div>

      {/* Options */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {sourceMode === 'library' && (
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Video Source</label>
            {videoAssets.length === 0 ? (
              <p className="text-xs text-zinc-500 italic">No video assets. Upload a video first.</p>
            ) : (
              <select
                value={selectedAssetId || ''}
                onChange={(e) => setSelectedAssetId(e.target.value || null)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-2.5 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500"
              >
                {videoAssets.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.filename} {a.duration ? `(${Math.round(a.duration)}s)` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {sourceMode === 'youtube' && (
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">YouTube URL</label>
            <input
              type="url"
              value={youtubeUrl}
              onChange={(e) => setYoutubeUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-2.5 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
            />
            <p className="text-[10px] text-zinc-600 mt-1">Requires yt-dlp installed on the server</p>
          </div>
        )}

        {/* Options */}
        <div>
          <label className="block text-xs text-zinc-400 mb-1.5 flex items-center gap-1">
            <Settings className="w-3 h-3" />
            Settings
          </label>
          <div className="space-y-3 bg-zinc-800/30 rounded-lg p-3">
            {/* Max Shorts */}
            <div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-300">Max Shorts</span>
                <span className="text-zinc-400">{maxShorts}</span>
              </div>
              <input
                type="range"
                min={1}
                max={20}
                value={maxShorts}
                onChange={(e) => setMaxShorts(Number(e.target.value))}
                className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer mt-1"
              />
            </div>

            {/* Min Duration */}
            <div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-300">Min Segment Duration</span>
                <span className="text-zinc-400">{minDuration}s</span>
              </div>
              <input
                type="range"
                min={5}
                max={120}
                step={5}
                value={minDuration}
                onChange={(e) => setMinDuration(Number(e.target.value))}
                className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer mt-1"
              />
            </div>

            {/* Aspect Ratio */}
            <div>
              <label className="block text-xs text-zinc-300 mb-1">Aspect Ratio</label>
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value as typeof aspectRatio)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500"
              >
                <option value="9:16">9:16 (Vertical/TikTok)</option>
                <option value="16:9">16:9 (Horizontal)</option>
                <option value="1:1">1:1 (Square)</option>
                <option value="none">Original</option>
              </select>
            </div>

            {/* Captions Toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={withCaptions}
                onChange={(e) => setWithCaptions(e.target.checked)}
                className="rounded border-zinc-600 bg-zinc-700 text-zinc-300 focus:ring-0"
              />
              <span className="text-xs text-zinc-300">Generate captions</span>
            </label>
          </div>
        </div>

        {/* Generate Button */}
        <button
          onClick={handleGenerate}
          disabled={generating || !sessionId || (sourceMode === 'library' && videoAssets.length === 0) || (sourceMode === 'youtube' && !youtubeUrl.trim())}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-200 rounded-lg text-sm font-medium transition-colors"
        >
          {generating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Scissors className="w-4 h-4" />
          )}
          {generating ? 'Generating Shorts...' : 'Generate Shorts'}
        </button>

        {/* Progress */}
        {progress && (
          <div className="bg-zinc-800/50 rounded-lg p-3">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-zinc-300">{progress.step}</span>
              <span className="text-zinc-400">{progress.percent}%</span>
            </div>
            <div className="w-full h-1.5 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-zinc-400 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(progress.percent, 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 bg-red-900/20 border border-red-800/30 rounded-lg p-3">
            <XCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
            <p className="text-xs text-red-300">{error}</p>
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-zinc-300 mb-2 flex items-center gap-1.5">
              <CheckCircle className="w-3.5 h-3.5 text-green-400" />
              Generated Shorts ({results.length})
            </h3>
            <div className="space-y-2">
              {results.map((short, i) => (
                <div
                  key={short.assetId || i}
                  className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-2.5 flex items-start gap-2.5"
                >
                  <div className="w-10 h-10 bg-zinc-700 rounded flex items-center justify-center shrink-0">
                    <ImageIcon className="w-4 h-4 text-zinc-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-zinc-200 truncate">{short.reason}</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">
                      {short.start}s - {short.end}s ({Math.round(short.duration)}s)
                    </p>
                  </div>
                  <button
                    onClick={() => handleAddToTimeline(short)}
                    className="flex items-center gap-1 px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px] text-zinc-300 transition-colors shrink-0"
                  >
                    <Plus className="w-3 h-3" />
                    Add
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
