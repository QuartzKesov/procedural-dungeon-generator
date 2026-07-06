'use client';

import dynamic from 'next/dynamic';
import { Component, type ReactNode } from 'react';

// Three.js must only run in the browser — disable SSR for the viewer.
const DungeonViewer = dynamic(
  () => import('@/components/dungeon/dungeon-viewer').then((m) => m.DungeonViewer),
  { ssr: false, loading: () => <LoadingScreen /> },
);

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#0a0908] p-8 text-amber-200/80">
          <h1 className="text-xl font-bold text-red-400">Ошибка рендеринга</h1>
          <pre className="max-w-2xl overflow-auto rounded-lg border border-red-800/40 bg-black/60 p-4 text-xs text-red-300">
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded-lg border border-amber-800/40 bg-amber-950/20 px-4 py-2 text-sm text-amber-300 hover:bg-amber-900/30"
          >
            Повторить
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function Home() {
  return (
    <ErrorBoundary>
      <DungeonViewer />
    </ErrorBoundary>
  );
}

function LoadingScreen() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#0a0908] text-amber-200/80">
      <div className="relative h-16 w-16">
        <div className="absolute inset-0 animate-ping rounded-full bg-amber-500/20" />
        <div className="absolute inset-2 animate-pulse rounded-full bg-amber-600/30" />
        <div className="absolute inset-0 flex items-center justify-center text-2xl">⚜</div>
      </div>
      <p className="font-mono text-sm tracking-widest text-amber-200/60">
        ЗАЖИГАЕМ ФАКЕЛЫ…
      </p>
    </div>
  );
}
