import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: '',
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || 'The editor failed to load.',
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Unhandled UI error:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="max-w-lg w-full rounded-2xl border border-red-500/30 bg-zinc-900/95 shadow-2xl p-6 space-y-4">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-red-400">Editor Error</p>
            <h1 className="text-2xl font-semibold mt-2">HyperEdit couldn&apos;t finish loading</h1>
          </div>
          <p className="text-sm text-zinc-300">
            A runtime error was caught before the app could render normally. This prevents the blank white screen and gives you a way to recover.
          </p>
          <div className="rounded-xl bg-black/30 border border-zinc-800 p-3 text-sm text-zinc-400 break-words">
            {this.state.message}
          </div>
          <div className="flex gap-3">
            <button
              onClick={this.handleReload}
              className="px-4 py-2 rounded-lg bg-zinc-100 text-zinc-950 font-medium hover:bg-white transition-colors"
            >
              Reload editor
            </button>
            <button
              onClick={() => this.setState({ hasError: false, message: '' })}
              className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
