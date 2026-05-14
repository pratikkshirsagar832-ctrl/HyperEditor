import { useState, useEffect } from 'react';
import { useJobProgress } from '../hooks/useJobProgress';

interface Asset {
  id: string;
  type: 'video' | 'image' | 'audio';
  url: string;
  thumbnailUrl?: string;
  name?: string;
}

interface AutoEditPanelProps {
  sessionId: string;
  onRefreshAssets: () => void;
}

export function AutoEditPanel({ sessionId, onRefreshAssets }: AutoEditPanelProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentStep, setCurrentStep] = useState('');
  const [generatedVideo, setGeneratedVideo] = useState<Asset | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { activeJob } = useJobProgress(sessionId);
  const currentJob = activeJob;

  const handleAutoEdit = async () => {
    try {
      setIsProcessing(true);
      setError(null);

      const response = await fetch(`/session/${sessionId}/auto-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'Failed to start auto edit');
      }

      // Job started, progress will come via SSE
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start auto edit');
      setIsProcessing(false);
    }
  };

  const handleCancel = async () => {
    try {
      if (currentJob?.jobId) {
        await fetch(`/session/${sessionId}/jobs/${currentJob.jobId}`, {
          method: 'DELETE'
        });
      }
    } catch (err) {
      console.error('Cancel failed:', err);
    }
    setIsProcessing(false);
    setProgress(0);
    setCurrentStep('');
  };

  const handleAddToTimeline = () => {
    // We would need to add this to the timeline somehow via props or context
    alert('Feature coming soon: Auto-add to timeline!');
  };

  // Watch job progress via SSE
  useEffect(() => {
    if (currentJob) {
      setProgress(currentJob.percent || 0);
      setCurrentStep(currentJob.step || '');

      if (currentJob.status === 'completed') {
        onRefreshAssets();
        setIsProcessing(false);
        setGeneratedVideo({
          id: 'auto-edit-result',
          type: 'video',
          url: `/session/${sessionId}/current.mp4`,
          name: 'Auto Edited Video'
        });
      }

      if (currentJob.status === 'failed') {
        setError(currentJob.error || 'Unknown error');
        setIsProcessing(false);
      }
    }
  }, [currentJob, onRefreshAssets, sessionId]);

  return (
    <div className="p-4 bg-gray-900 text-white rounded-lg h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <span className="px-2 py-1 bg-purple-600 text-white text-xs rounded font-bold">
          ✨ AI
        </span>
        <h2 className="text-lg font-semibold">Magic Auto Edit</h2>
      </div>

      {/* Description */}
      <div className="mb-6">
        <p className="text-gray-300 mb-3 text-sm leading-relaxed">
          One click to a perfect video! No prompts needed.
        </p>
        <ul className="text-sm text-gray-400 space-y-2">
          <li className="flex items-center gap-2"><span className="text-green-400">✓</span> Smart cuts at perfect moments</li>
          <li className="flex items-center gap-2"><span className="text-green-400">✓</span> Professional transitions</li>
          <li className="flex items-center gap-2"><span className="text-green-400">✓</span> Auto captions with perfect timing</li>
          <li className="flex items-center gap-2"><span className="text-green-400">✓</span> Motion graphics intro/outro</li>
          <li className="flex items-center gap-2"><span className="text-green-400">✓</span> All edits done automatically</li>
        </ul>
      </div>

      {/* Main Button */}
      {!isProcessing && !generatedVideo && (
        <button
          onClick={handleAutoEdit}
          className="w-full py-4 bg-gradient-to-r from-purple-600 to-pink-600 
                     hover:from-purple-500 hover:to-pink-500 
                     text-white font-bold rounded-lg shadow-lg
                     transition-all transform hover:scale-[1.02]
                     flex items-center justify-center gap-3 text-lg"
        >
          <span className="text-xl">🚀</span>
          Auto Edit My Video
        </button>
      )}

      {/* Progress Section */}
      {isProcessing && (
        <div className="mt-4 bg-gray-800 p-4 rounded-lg shadow-inner">
          <div className="flex justify-between items-center mb-3">
            <span className="text-sm text-gray-300 font-medium">{currentStep || 'Initializing...'}</span>
            <span className="text-sm text-purple-400 font-bold">{progress}%</span>
          </div>
          <div className="h-3 bg-gray-700 rounded-full overflow-hidden shadow-inner">
            <div 
              className="h-full bg-gradient-to-r from-purple-500 to-pink-500 
                          transition-all duration-300 relative"
              style={{ width: `${progress}%` }}
            >
              <div className="absolute inset-0 bg-white/20 animate-pulse"></div>
            </div>
          </div>
          <button
            onClick={handleCancel}
            className="mt-6 w-full py-2.5 bg-red-500/10 text-red-400 
                       hover:bg-red-500/20 hover:text-red-300 border border-red-500/20 
                       rounded-lg text-sm font-medium transition-colors"
          >
            Cancel Processing
          </button>
        </div>
      )}

      {/* Error Section */}
      {error && (
        <div className="mt-4 p-4 bg-red-900/30 border border-red-500/50 rounded-lg">
          <div className="flex items-center gap-2 text-red-400 mb-2 font-semibold">
            <span>⚠️</span> Error
          </div>
          <p className="text-red-300/80 text-sm">{error}</p>
          <button
            onClick={() => setError(null)}
            className="mt-3 text-xs font-medium text-gray-400 hover:text-white transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Success Section */}
      {generatedVideo && (
        <div className="mt-4 p-5 bg-purple-900/20 border border-purple-500/30 rounded-lg shadow-lg">
          <div className="flex items-center gap-2 text-purple-400 mb-3 text-lg">
            <span>🎉</span>
            <span className="font-bold">Perfect edit complete!</span>
          </div>
          <p className="text-sm text-gray-400 mb-5 leading-relaxed">
            Your video has been auto-edited with perfect cuts, captions, and graphics. It is now available in your Assets library.
          </p>
          <div className="flex flex-col gap-3">
            <button
              onClick={handleAddToTimeline}
              className="w-full py-3 bg-purple-600 hover:bg-purple-500 
                         text-white font-semibold rounded-lg shadow text-sm transition-colors"
            >
              Add to Timeline
            </button>
            <button
              onClick={() => setGeneratedVideo(null)}
              className="w-full py-3 bg-gray-700 hover:bg-gray-600 
                         text-white font-medium rounded-lg text-sm transition-colors"
            >
              Create Another Edit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
