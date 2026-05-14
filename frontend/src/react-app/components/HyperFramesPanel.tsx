import { useState, useCallback } from 'react';
import { Sparkles, ChevronDown, ChevronRight, X, AlertCircle } from 'lucide-react';

type AspectRatio = '16:9' | '9:16' | '1:1';

interface GeneratedAsset {
  id: string;
  filename: string;
  type: 'video' | 'image' | 'audio';
  thumbnailUrl?: string | null;
}

interface HyperFramesPanelProps {
  sessionId: string;
  onAssetGenerated: (asset: GeneratedAsset) => void;
}

export function HyperFramesPanel({ sessionId, onAssetGenerated }: HyperFramesPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(10);
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [style, setStyle] = useState('modern');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [htmlContent, setHtmlContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generatedAsset, setGeneratedAsset] = useState<GeneratedAsset | null>(null);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressStep, setProgressStep] = useState('');

  // Poll for job completion
  const pollJob = useCallback(async (jobId: string) => {
    const maxAttempts = 300; // 5 min timeout at 1s intervals
    let attempts = 0;

    const poll = async () => {
      if (attempts >= maxAttempts) {
        setIsLoading(false);
        setError('Job timed out');
        return;
      }
      attempts++;

      try {
        const res = await fetch(`/api/v1/session/${sessionId}/jobs/${jobId}`);
        const data = await res.json();

        if (data.status === 'completed') {
          setIsLoading(false);
          setCurrentJobId(null);
          setProgressPercent(100);
          setProgressStep('Complete!');
          const asset = data.result?.asset;
          if (asset) {
            setGeneratedAsset(asset);
            onAssetGenerated(asset);
          }
          return;
        }

        if (data.status === 'failed') {
          setIsLoading(false);
          setCurrentJobId(null);
          setError(data.error || 'Generation failed');
          return;
        }

        if (data.status === 'cancelled') {
          setIsLoading(false);
          setCurrentJobId(null);
          setError('Job was cancelled');
          return;
        }

        // Still running — update progress
        if (data.percent !== undefined) {
          setProgressPercent(data.percent);
          setProgressStep(data.step || 'Processing...');
        }

        setTimeout(poll, 1000);
      } catch {
        setTimeout(poll, 1000);
      }
    };

    setTimeout(poll, 1000);
  }, [sessionId, onAssetGenerated]);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() || !sessionId) return;

    setIsLoading(true);
    setError(null);
    setGeneratedAsset(null);
    setProgressPercent(0);
    setProgressStep('Starting...');

    try {
      const res = await fetch(`/session/${sessionId}/hyperframes/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          duration,
          aspectRatio,
          style,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const jobId = data.data?.jobId || data.jobId;
      setCurrentJobId(jobId);
      pollJob(jobId);
    } catch (err) {
      setIsLoading(false);
      setError(err instanceof Error ? err.message : 'Failed to start generation');
    }
  }, [prompt, duration, aspectRatio, style, sessionId, pollJob]);

  const handleRenderHtml = useCallback(async () => {
    if (!htmlContent.trim() || !sessionId) return;

    setIsLoading(true);
    setError(null);
    setGeneratedAsset(null);
    setProgressPercent(0);
    setProgressStep('Starting...');

    try {
      const res = await fetch(`/session/${sessionId}/hyperframes/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          htmlContent: htmlContent.trim(),
          duration,
          width: aspectRatio === '9:16' ? 1080 : aspectRatio === '1:1' ? 1080 : 1920,
          height: aspectRatio === '9:16' ? 1920 : aspectRatio === '1:1' ? 1080 : 1080,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const jobId = data.data?.jobId || data.jobId;
      setCurrentJobId(jobId);
      pollJob(jobId);
    } catch (err) {
      setIsLoading(false);
      setError(err instanceof Error ? err.message : 'Failed to start render');
    }
  }, [htmlContent, duration, aspectRatio, sessionId, pollJob]);

  const handleCancel = useCallback(async () => {
    if (!currentJobId || !sessionId) return;
    try {
      await fetch(`/api/v1/session/${sessionId}/jobs/${currentJobId}`, { method: 'DELETE' });
    } catch { /* job may already be gone */ }
    setIsLoading(false);
    setCurrentJobId(null);
    setError('Cancelled');
  }, [currentJobId, sessionId]);

  return (
    <div className="p-4 space-y-4 h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 text-xs font-bold bg-purple-500/20 text-purple-400 rounded">HF</span>
        <h2 className="text-sm font-semibold text-zinc-200">HyperFrames</h2>
        <span className="px-1.5 py-0.5 text-[10px] bg-zinc-800 text-zinc-400 rounded">HTML → Video</span>
      </div>

      {/* Prompt textarea */}
      <div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={isLoading}
          rows={24}
          className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg p-3 text-sm text-zinc-200 placeholder-zinc-500 resize-none focus:outline-none focus:ring-1 focus:ring-purple-500/50 disabled:opacity-50"
          placeholder="Describe the video you want to create...&#10;&#10;Example:&#10;Create a dynamic intro with bold text 'Welcome to HyperEdit' that fades in with a particle background. The text should slide up from the bottom, glow with a purple shadow, then settle in the center. Add subtle geometric shapes floating in the background."
        />
      </div>

      {/* Controls */}
      <div className="grid grid-cols-3 gap-3">
        {/* Duration */}
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Duration</label>
          <input
            type="range"
            min={3}
            max={60}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            disabled={isLoading}
            className="w-full accent-purple-500"
          />
          <span className="text-xs text-zinc-400">{duration}s</span>
        </div>

        {/* Aspect Ratio */}
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Aspect Ratio</label>
          <select
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
            disabled={isLoading}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
          >
            <option value="16:9">16:9 YouTube</option>
            <option value="9:16">9:16 TikTok</option>
            <option value="1:1">1:1 Instagram</option>
          </select>
        </div>

        {/* Style */}
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Style</label>
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            disabled={isLoading}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-purple-500/50"
          >
            <option value="modern">Modern</option>
            <option value="minimal">Minimal</option>
            <option value="bold">Bold</option>
            <option value="corporate">Corporate</option>
            <option value="playful">Playful</option>
            <option value="cinematic">Cinematic</option>
          </select>
        </div>
      </div>

      {/* Advanced: Write HTML directly */}
      <div>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          Advanced: Write HTML directly
        </button>
        {showAdvanced && (
          <div className="mt-2 space-y-2">
            <textarea
              value={htmlContent}
              onChange={(e) => setHtmlContent(e.target.value)}
              disabled={isLoading}
              rows={12}
              className="w-full bg-black border border-zinc-800 rounded-lg p-3 text-sm text-green-400 font-mono resize-none focus:outline-none focus:ring-1 focus:ring-purple-500/50 disabled:opacity-50"
              placeholder="<div id=&quot;stage&quot; data-composition-id=&quot;comp1&quot; data-width=&quot;1920&quot; data-height=&quot;1080&quot;>&#10;  <!-- Your HTML composition here -->&#10;</div>"
            />
            <button
              onClick={handleRenderHtml}
              disabled={isLoading || !htmlContent.trim()}
              className="w-full px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-xs text-white rounded-lg transition-colors"
            >
              {isLoading ? 'Rendering...' : 'Render HTML'}
            </button>
          </div>
        )}
      </div>

      {/* Progress section */}
      {isLoading && (
        <div className="space-y-2 p-3 bg-zinc-800/50 border border-zinc-700 rounded-lg">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-300">{progressStep}</span>
            <span className="text-xs text-zinc-400">{progressPercent}%</span>
          </div>
          <div className="w-full h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-500 rounded-full transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <button
            onClick={handleCancel}
            className="text-xs px-2 py-1 bg-red-500/20 hover:bg-red-500/40 text-red-400 rounded transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Error section */}
      {error && !isLoading && (
        <div className="p-3 border border-red-500/30 bg-red-500/10 rounded-lg">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
            <p className="text-xs text-red-300 flex-1">{error}</p>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300">
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {/* Success section */}
      {generatedAsset && !isLoading && (
        <div className="p-3 border border-purple-500/30 bg-purple-500/10 rounded-lg">
          <p className="text-xs text-purple-300 font-medium">✓ Video generated!</p>
          <p className="text-[10px] text-zinc-400 mt-1">Added to asset library. Drag to timeline.</p>
        </div>
      )}

      {/* Generate button */}
      {!isLoading && !generatedAsset && (
        <button
          onClick={handleGenerate}
          disabled={!prompt.trim()}
          className="w-full px-4 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-sm font-medium text-white rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          <Sparkles className="w-4 h-4" />
          Generate with HyperFrames
        </button>
      )}
    </div>
  );
}

export default HyperFramesPanel;
