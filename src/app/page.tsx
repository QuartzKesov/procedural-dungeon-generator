'use client';

import dynamic from 'next/dynamic';

// Three.js must only run in the browser — disable SSR for the viewer.
const DungeonViewer = dynamic(
  () => import('@/components/dungeon/dungeon-viewer').then((m) => m.DungeonViewer),
  { ssr: false, loading: () => <LoadingScreen /> },
);

export default function Home() {
  return <DungeonViewer />;
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
        KINDLING THE TORCHES…
      </p>
    </div>
  );
}
