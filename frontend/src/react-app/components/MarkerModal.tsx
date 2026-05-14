import { useState } from 'react';
import { X, Flag } from 'lucide-react';
import type { Marker } from '@/react-app/hooks/useProject';

interface MarkerModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentTime: number;
  onAddMarker: (marker: Omit<Marker, 'id'>) => void;
}

const COLORS = [
  { id: 'red', color: '#EF4444', label: 'Red' },
  { id: 'yellow', color: '#EAB308', label: 'Yellow' },
  { id: 'green', color: '#22C55E', label: 'Green' },
  { id: 'blue', color: '#3B82F6', label: 'Blue' },
  { id: 'purple', color: '#A855F7', label: 'Purple' },
] as const;

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function MarkerModal({ isOpen, onClose, currentTime, onAddMarker }: MarkerModalProps) {
  const [label, setLabel] = useState('');
  const [color, setColor] = useState<'red' | 'yellow' | 'green' | 'blue' | 'purple'>('red');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onAddMarker({
      time: currentTime,
      label: label || `Marker at ${formatTime(currentTime)}`,
      color,
    });
    setLabel('');
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-zinc-900 rounded-xl border border-zinc-700 w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Flag className="w-5 h-5 text-zinc-400" />
            <h2 className="text-lg font-semibold text-zinc-200">Add Marker</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-zinc-800 rounded">
            <X className="w-5 h-5 text-zinc-400" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-2">Time</label>
            <div className="px-3 py-2 bg-zinc-800 rounded-lg text-zinc-200">
              {formatTime(currentTime)}
            </div>
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-2">Label</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Enter marker label..."
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
            />
          </div>

          <div>
            <label className="block text-sm text-zinc-400 mb-2">Color</label>
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setColor(c.id)}
                  className={`w-8 h-8 rounded-full transition-transform ${
                    color === c.id ? 'scale-110 ring-2 ring-white ring-offset-2 ring-offset-zinc-900' : ''
                  }`}
                  style={{ backgroundColor: c.color }}
                  title={c.label}
                />
              ))}
            </div>
          </div>

          <button
            type="submit"
            className="w-full py-2.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 font-medium rounded-lg transition-colors"
          >
            Add Marker
          </button>
        </form>
      </div>
    </div>
  );
}
