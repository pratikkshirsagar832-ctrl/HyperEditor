import {
  Scissors,
  Copy,
  Trash2,
  RotateCcw,
  RotateCw,
  Volume2,
  Settings,
  Palette,
  Wand2,
} from 'lucide-react';

export default function Toolbar() {
  const tools = [
    { icon: Scissors, label: 'Split', shortcut: 'S' },
    { icon: Copy, label: 'Duplicate', shortcut: 'D' },
    { icon: Trash2, label: 'Delete', shortcut: 'Del' },
    { icon: RotateCcw, label: 'Undo', shortcut: '⌘Z' },
    { icon: RotateCw, label: 'Redo', shortcut: '⌘⇧Z' },
    { icon: Volume2, label: 'Audio', shortcut: 'A' },
    { icon: Palette, label: 'Color', shortcut: 'C' },
    { icon: Wand2, label: 'Effects', shortcut: 'E' },
    { icon: Settings, label: 'Settings', shortcut: ',' },
  ];

  return (
    <div className="flex items-center gap-1 px-4 py-3 bg-zinc-900/30 border-b border-zinc-800/50">
      {tools.map((tool, idx) => (
        <ToolButton key={idx} {...tool} />
      ))}
    </div>
  );
}

interface ToolButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  shortcut: string;
}

function ToolButton({ icon: Icon, label, shortcut }: ToolButtonProps) {
  return (
    <button
      className="group relative flex flex-col items-center gap-1 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition-colors"
      title={`${label} (${shortcut})`}
    >
      <Icon className="w-5 h-5 text-zinc-400 group-hover:text-white transition-colors" />
      <span className="text-[10px] text-zinc-500 group-hover:text-zinc-300 transition-colors">
        {label}
      </span>
    </button>
  );
}