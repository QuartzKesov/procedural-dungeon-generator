'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { generateDungeon } from '@/lib/dungeon/generator';
import { buildDungeonScene, makeIsoCamera, fogDensityFor, type DungeonScene, type OverlayToggles } from '@/lib/dungeon/scene';
import { runTestsOnDungeon, type TestResult } from '@/lib/dungeon/tests';
import { DEFAULT_PARAMS, type Dungeon, type Params, type Theme, FLOOR, WALL } from '@/lib/dungeon/types';
import { roomFloorCells } from '@/lib/dungeon/generator';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dices, Play, RefreshCw, FlaskConical, Eye, EyeOff, Map as MapIcon, Layers, Zap,
  Link2, Volume2, VolumeX, Crosshair, Skull, DoorOpen, Sparkles,
} from 'lucide-react';

interface ThreeState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  dungeonScene: DungeonScene | null;
  startTime: number;
  raf: number;
  zoom: number;
  pan: THREE.Vector2; // world-space pan offset
}

const ROOM_TYPE_COLOR: Record<string, string> = {
  entrance: '#6a8cff',
  boss: '#ff3a2a',
  treasure: '#ffd24a',
  shrine: '#40d0ff',
  elite: '#ff7a3a',
  combat: '#9a8a78',
};

export function DungeonViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const threeRef = useRef<ThreeState | null>(null);
  const buildAnimRef = useRef<{ active: boolean; progress: number }>({ active: false, progress: 1 });
  const focusOnCellRef = useRef<((gridX: number, gridY: number) => void) | null>(null);
  const audioRef = useRef<DungeonAudio | null>(null);

  const [params, setParams] = useState<Params>(() => parseHashParams());
  const [overlays, setOverlays] = useState<OverlayToggles>({
    delaunay: false, mst: false, loops: false, critical: false, difficulty: false,
  });
  const [animateBuild, setAnimateBuild] = useState(true);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [perfResult, setPerfResult] = useState<TestResult | null>(null);
  const [audioOn, setAudioOn] = useState(false);
  const [copied, setCopied] = useState(false);

  // Generate the dungeon whenever params change. Fast (~25ms) → synchronous.
  const dungeon = useMemo<Dungeon>(() => generateDungeon(params), [params]);
  const testResults = useMemo<TestResult[]>(() => runTestsOnDungeon(dungeon), [dungeon]);

  // ---- sync params → URL hash (shareable seeds) ----
  useEffect(() => {
    const hash = `#seed=${params.seed}&rooms=${params.roomCount}&loops=${params.loopChance}&decor=${params.decorDensity}&theme=${params.theme}`;
    if (hash !== window.location.hash) {
      window.history.replaceState(null, '', hash);
    }
  }, [params]);

  // ---- init Three.js once ----
  useEffect(() => {
    const container = containerRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x05040a, 1);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05040a, fogDensityFor(dungeon));

    const camera = makeIsoCamera(dungeon, container.clientWidth / container.clientHeight);

    const startTime = performance.now();
    const state: ThreeState = {
      renderer, scene, camera, dungeonScene: null, startTime,
      raf: 0, zoom: 1, pan: new THREE.Vector2(0, 0),
    };
    threeRef.current = state;

    // mutable ref to the latest dungeon (closures read this)
    let currentDungeon = dungeon;

    // half-frustum helper (scale-aware, zoom-aware)
    const halfFrustum = () => (currentDungeon.W + currentDungeon.H) * 0.42 / state.zoom;

    // resize observer
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth, h = container.clientHeight;
      renderer.setSize(w, h);
      const aspect = w / h;
      const half = halfFrustum();
      camera.left = -half * aspect; camera.right = half * aspect;
      camera.top = half; camera.bottom = -half;
      camera.updateProjectionMatrix();
    });
    ro.observe(container);

    // zoom (wheel)
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
      state.zoom = Math.max(0.4, Math.min(3.5, state.zoom * factor));
      const w = container.clientWidth, h = container.clientHeight;
      const aspect = w / h;
      const half = halfFrustum();
      camera.left = -half * aspect; camera.right = half * aspect;
      camera.top = half; camera.bottom = -half;
      camera.updateProjectionMatrix();
    };
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    // pan (drag)
    let dragging = false;
    let lastX = 0, lastY = 0;
    const onDown = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY; renderer.domElement.setPointerCapture(e.pointerId); };
    const onUp = (e: PointerEvent) => { dragging = false; };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      // pan in world units: screen delta → world delta via ortho frustum
      const worldPerPx = (camera.top - camera.bottom) / container.clientHeight;
      // isometric: screen-x moves along (cos45, sin45) world; screen-y along (-sin45, cos45) tilted
      state.pan.x -= (dx * Math.cos(Math.PI / 4) - dy * Math.cos(Math.PI / 4)) * worldPerPx;
      state.pan.y -= (dx * Math.sin(Math.PI / 4) + dy * Math.sin(Math.PI / 4)) * worldPerPx;
      applyCamera();
    };
    const applyCamera = () => {
      const dir = new THREE.Vector3(Math.cos(THREE.MathUtils.degToRad(37)) * Math.cos(THREE.MathUtils.degToRad(45)),
        Math.sin(THREE.MathUtils.degToRad(37)),
        Math.cos(THREE.MathUtils.degToRad(37)) * Math.sin(THREE.MathUtils.degToRad(45)));
      const dist = Math.max(currentDungeon.W, currentDungeon.H) * 0.9 + 30;
      const center = new THREE.Vector3(state.pan.x, 0, state.pan.y);
      camera.position.copy(center).addScaledVector(dir, dist);
      camera.lookAt(center);
    };

    // focusOnCell: pan camera so a grid coordinate is centered.
    // grid (x,y) → world (x - cx, 0, y - cz). Smoothly animate via lerp.
    let focusAnim: { from: THREE.Vector2; to: THREE.Vector2; t: number } | null = null;
    const focusOnCell = (gridX: number, gridY: number) => {
      const cxC = (currentDungeon.W - 1) / 2;
      const czC = (currentDungeon.H - 1) / 2;
      const targetX = gridX - cxC;
      const targetZ = gridY - czC;
      focusAnim = {
        from: new THREE.Vector2(state.pan.x, state.pan.y),
        to: new THREE.Vector2(targetX, targetZ),
        t: 0,
      };
    };
    focusOnCellRef.current = focusOnCell;
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointermove', onMove);

    // keep a ref to the latest dungeon for closures (currentDungeon declared above)
    (state as any).setCurrentDungeon = (d: Dungeon) => { currentDungeon = d; };

    // render loop
    let lastFrameMs = performance.now();
    const loop = () => {
      state.raf = requestAnimationFrame(loop);
      const ds = state.dungeonScene;
      if (ds) {
        const now = performance.now();
        const dt = (now - lastFrameMs) / 1000;
        lastFrameMs = now;
        // drive build animation
        if (buildAnimRef.current.active && buildAnimRef.current.progress < 1) {
          buildAnimRef.current.progress = Math.min(1, buildAnimRef.current.progress + 0.011);
          ds.setBuildProgress(buildAnimRef.current.progress);
          if (buildAnimRef.current.progress >= 1) buildAnimRef.current.active = false;
        }
        // drive focus animation (smooth pan to clicked minimap cell)
        if (focusAnim) {
          focusAnim.t = Math.min(1, focusAnim.t + dt * 2.5);
          const e = 1 - Math.pow(1 - focusAnim.t, 3); // ease-out cubic
          state.pan.x = focusAnim.from.x + (focusAnim.to.x - focusAnim.from.x) * e;
          state.pan.y = focusAnim.from.y + (focusAnim.to.y - focusAnim.from.y) * e;
          applyCamera();
          if (focusAnim.t >= 1) focusAnim = null;
        }
        ds.update((now - state.startTime) / 1000, dt);
      }
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(state.raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointermove', onMove);
      state.dungeonScene?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      threeRef.current = null;
    };
  }, []);

  // ---- rebuild scene when dungeon changes ----
  useEffect(() => {
    const state = threeRef.current;
    if (!state) return;
    // dispose old
    if (state.dungeonScene) {
      state.scene.remove(state.dungeonScene.group);
      state.dungeonScene.dispose();
    }
    const ds = buildDungeonScene(dungeon, {
      animateBuild, buildProgress: animateBuild ? 0 : 1, overlays,
    });
    state.scene.add(ds.group);
    state.dungeonScene = ds;
    // reset camera pan/zoom to fit + refresh fog density for the new scale
    state.zoom = 1; state.pan.set(0, 0);
    (state as any).setCurrentDungeon?.(dungeon);
    if (state.scene.fog instanceof THREE.FogExp2) {
      state.scene.fog.density = fogDensityFor(dungeon);
    }
    const container = containerRef.current!;
    const aspect = container.clientWidth / container.clientHeight;
    const cam = makeIsoCamera(dungeon, aspect);
    state.camera.left = cam.left; state.camera.right = cam.right;
    state.camera.top = cam.top; state.camera.bottom = cam.bottom;
    state.camera.near = cam.near; state.camera.far = cam.far;
    state.camera.position.copy(cam.position);
    state.camera.lookAt(0, 0, 0);
    state.camera.updateProjectionMatrix();
    // start build animation
    if (animateBuild) {
      buildAnimRef.current = { active: true, progress: 0 };
      ds.setBuildProgress(0);
    } else {
      buildAnimRef.current = { active: false, progress: 1 };
      ds.setBuildProgress(1);
    }
    ds.setOverlays(overlays);
  }, [dungeon]);

  // ---- overlay toggle ----
  useEffect(() => {
    threeRef.current?.dungeonScene?.setOverlays(overlays);
  }, [overlays]);

  // ---- run perf test once on mount (warmed up, shared impl) ----
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      if (cancelled) return;
      import('@/lib/dungeon/tests').then(({ perf }) => {
        if (cancelled) return;
        const r = perf();
        setPerfResult({ name: '60-room generation < 50 ms', pass: r.pass, detail: r.detail });
      });
    }, 600);
    return () => { cancelled = true; clearTimeout(id); };
  }, []);

  // ---- minimap ----
  const drawMinimap = useCallback(() => {
    const canvas = minimapRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const d = dungeon;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#05040a';
    ctx.fillRect(0, 0, W, H);
    const sx = W / d.W, sy = H / d.H;
    // build owner map
    const owner = new Int16Array(d.W * d.H);
    for (const r of d.rooms) for (const c of roomFloorCells(r)) {
      if (c.x < 0 || c.y < 0 || c.x >= d.W || c.y >= d.H) continue;
      if (d.grid[c.y * d.W + c.x] === FLOOR) owner[c.y * d.W + c.x] = r.id + 1;
    }
    for (let y = 0; y < d.H; y++) {
      for (let x = 0; x < d.W; x++) {
        const i = y * d.W + x;
        const v = d.grid[i];
        if (v === FLOOR) {
          const rid = owner[i] - 1;
          const type = rid >= 0 ? d.rooms[rid].type : 'combat';
          ctx.fillStyle = ROOM_TYPE_COLOR[type] ?? '#6a6258';
        } else if (v === WALL) {
          ctx.fillStyle = '#1c1814';
        } else continue;
        ctx.fillRect(x * sx, y * sy, Math.ceil(sx) + 1, Math.ceil(sy) + 1);
      }
    }
    // markers
    const dot = (x: number, y: number, color: string, r: number) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x * sx + sx / 2, y * sy + sy / 2, r, 0, Math.PI * 2);
      ctx.fill();
    };
    dot(d.rooms[d.entranceId].cx, d.rooms[d.entranceId].cy, '#ffffff', 3);
    dot(d.rooms[d.bossId].cx, d.rooms[d.bossId].cy, '#ff2222', 4);
    for (const r of d.rooms) if (r.type === 'treasure') dot(r.cx, r.cy, '#ffd24a', 3);
  }, [dungeon]);

  useEffect(() => { drawMinimap(); }, [drawMinimap]);

  // ---- handlers ----
  const regenerate = useCallback(() => {
    setParams((p) => ({ ...p }));
    // forcing a new object triggers useMemo; if seed unchanged we still want a rebuild:
    // bump via spread (new ref) → dungeon regenerates deterministically (same result).
  }, []);

  const rollDice = useCallback(() => {
    setParams((p) => ({ ...p, seed: Math.floor(Math.random() * 1e9) >>> 0 }));
  }, []);

  const replayBuild = useCallback(() => {
    const ds = threeRef.current?.dungeonScene;
    if (!ds) return;
    buildAnimRef.current = { active: true, progress: 0 };
    ds.setBuildProgress(0);
  }, []);

  // ---- minimap click → focus camera ----
  const onMinimapClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = minimapRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;   // 0..1
    const fy = (e.clientY - rect.top) / rect.height;   // 0..1
    const gridX = Math.round(fx * dungeon.W);
    const gridY = Math.round(fy * dungeon.H);
    focusOnCellRef.current?.(gridX, gridY);
  }, [dungeon]);

  // ---- quick-nav: focus entrance / boss ----
  const focusEntrance = useCallback(() => {
    const r = dungeon.rooms[dungeon.entranceId];
    focusOnCellRef.current?.(r.cx, r.cy);
  }, [dungeon]);
  const focusBoss = useCallback(() => {
    const r = dungeon.rooms[dungeon.bossId];
    focusOnCellRef.current?.(r.cx, r.cy);
  }, [dungeon]);

  // ---- copy shareable link ----
  const copyLink = useCallback(() => {
    const url = window.location.href;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {
      // fallback: select + execCommand
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch {}
      document.body.removeChild(ta);
    });
  }, []);

  // ---- ambient audio toggle ----
  const toggleAudio = useCallback(() => {
    if (!audioRef.current) audioRef.current = new DungeonAudio();
    const a = audioRef.current;
    if (audioOn) { a.stop(); setAudioOn(false); }
    else { a.start(); setAudioOn(true); }
  }, [audioOn]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'r' || e.key === 'R') rollDice();
      else if (e.key === 'g' || e.key === 'G') regenerate();
      else if (e.key === ' ') { e.preventDefault(); replayBuild(); }
      else if (e.key === 'e' || e.key === 'E') focusEntrance();
      else if (e.key === 'b' || e.key === 'B') focusBoss();
      else if (e.key === 'm' || e.key === 'M') toggleAudio();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rollDice, regenerate, replayBuild, focusEntrance, focusBoss, toggleAudio]);

  const stats = dungeon.stats;
  const typeCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of dungeon.rooms) m[r.type] = (m[r.type] ?? 0) + 1;
    return m;
  }, [dungeon]);

  const allTestsPass = testResults.every((t) => t.pass) && (perfResult?.pass ?? false);

  return (
    <div className="relative flex min-h-screen flex-col bg-[#05040a] text-amber-50/90">
      {/* Canvas */}
      <div ref={containerRef} className="absolute inset-0" style={{ touchAction: 'none' }} />

      {/* Top bar: dungeon name + quick actions */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-4 pt-3">
        <div className="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full border border-amber-900/40 bg-black/70 px-4 py-1.5 backdrop-blur-md sm:gap-3 sm:px-5 sm:py-2">
          <span className="animate-pulse text-base text-amber-500 sm:text-lg">⚜</span>
          <h1 className="truncate font-serif text-xs tracking-wide text-amber-100/90 sm:text-sm md:text-base">{dungeon.name}</h1>
          <Badge variant="outline" className="hidden border-amber-800/50 bg-amber-950/30 text-[10px] font-mono text-amber-300/70 sm:inline-flex">
            seed {dungeon.params.seed}
          </Badge>
          <div className="mx-1 hidden h-5 w-px bg-amber-900/40 sm:block" />
          <button
            onClick={copyLink}
            title="Copy shareable link"
            className={`pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border transition-colors ${copied ? 'border-emerald-600/50 bg-emerald-900/30 text-emerald-300' : 'border-amber-800/40 bg-amber-950/20 text-amber-300/70 hover:bg-amber-900/40 hover:text-amber-100'}`}
          >
            {copied ? <span className="text-xs">✓</span> : <Link2 className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={toggleAudio}
            title="Ambient audio (M)"
            className={`pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border transition-colors ${audioOn ? 'border-amber-500/60 bg-amber-800/40 text-amber-100' : 'border-amber-800/40 bg-amber-950/20 text-amber-300/70 hover:bg-amber-900/40 hover:text-amber-100'}`}
          >
            {audioOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={focusEntrance}
            title="Focus entrance (E)"
            className="pointer-events-auto hidden h-7 w-7 items-center justify-center rounded-full border border-amber-800/40 bg-amber-950/20 text-amber-300/70 transition-colors hover:bg-blue-900/40 hover:text-blue-200 sm:flex"
          >
            <DoorOpen className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={focusBoss}
            title="Focus boss (B)"
            className="pointer-events-auto hidden h-7 w-7 items-center justify-center rounded-full border border-amber-800/40 bg-amber-950/20 text-amber-300/70 transition-colors hover:bg-red-900/40 hover:text-red-200 sm:flex"
          >
            <Skull className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* Panel toggle buttons (mobile-friendly) */}
      <div className="absolute left-3 top-16 z-30 flex flex-col gap-2">
        <TooltipButton active={leftOpen} onClick={() => setLeftOpen((v) => !v)} icon={<Layers className="h-4 w-4" />} label="Controls" />
      </div>
      <div className="absolute right-3 top-16 z-30 flex flex-col gap-2">
        <TooltipButton active={rightOpen} onClick={() => setRightOpen((v) => !v)} icon={<MapIcon className="h-4 w-4" />} label="Stats & Map" />
      </div>

      {/* Left panel: controls */}
      {leftOpen && (
        <aside className="absolute left-3 top-28 bottom-16 z-20 w-[min(20rem,calc(100vw-1.5rem))]">
          <ScrollArea className="h-full rounded-2xl border border-amber-900/40 bg-black/70 backdrop-blur-md">
            <div className="space-y-5 p-4">
              <PanelTitle icon={<Zap className="h-4 w-4 text-amber-500" />} title="Generation" />
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-amber-200/50">Seed</Label>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    value={params.seed}
                    onChange={(e) => setParams((p) => ({ ...p, seed: Math.max(0, parseInt(e.target.value || '0', 10)) >>> 0 }))}
                    className="border-amber-900/40 bg-amber-950/20 font-mono text-sm text-amber-100"
                  />
                  <Button size="icon" variant="outline" onClick={rollDice} title="Roll dice (R)"
                    className="border-amber-800/50 bg-amber-950/30 text-amber-300 hover:bg-amber-900/40 hover:text-amber-100">
                    <Dices className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <SliderRow label="Rooms" value={params.roomCount} min={8} max={80} step={1}
                display={`${params.roomCount}`} onChange={(v) => setParams((p) => ({ ...p, roomCount: v }))} />
              <SliderRow label="Loop Chance" value={params.loopChance} min={0} max={0.5} step={0.01}
                display={params.loopChance.toFixed(2)} onChange={(v) => setParams((p) => ({ ...p, loopChance: v }))} />
              <SliderRow label="Decor Density" value={params.decorDensity} min={0} max={1} step={0.05}
                display={params.decorDensity.toFixed(2)} onChange={(v) => setParams((p) => ({ ...p, decorDensity: v }))} />

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-amber-200/50">Theme</Label>
                <Select value={params.theme} onValueChange={(v) => setParams((p) => ({ ...p, theme: v as Theme }))}>
                  <SelectTrigger className="border-amber-900/40 bg-amber-950/20 text-amber-100">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-amber-900/40 bg-black/90 text-amber-100">
                    {(['crypt', 'cavern', 'catacomb', 'forge'] as Theme[]).map((t) => (
                      <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex gap-2 pt-1">
                <Button onClick={regenerate} className="flex-1 border-amber-700/50 bg-amber-800/40 text-amber-50 hover:bg-amber-700/50">
                  <RefreshCw className="mr-2 h-4 w-4" /> Regenerate
                </Button>
              </div>

              <Separator className="bg-amber-900/30" />

              <PanelTitle icon={<Play className="h-4 w-4 text-amber-500" />} title="Animation" />
              <div className="flex items-center justify-between rounded-lg border border-amber-900/30 bg-amber-950/10 px-3 py-2">
                <Label htmlFor="anim" className="text-sm text-amber-100/80">Staged Build</Label>
                <Switch id="anim" checked={animateBuild} onCheckedChange={setAnimateBuild} />
              </div>
              <Button variant="outline" onClick={replayBuild} className="w-full border-amber-800/40 bg-amber-950/20 text-amber-200 hover:bg-amber-900/30">
                <Play className="mr-2 h-4 w-4" /> Replay Build (Space)
              </Button>

              <Separator className="bg-amber-900/30" />

              <PanelTitle icon={<Eye className="h-4 w-4 text-amber-500" />} title="Debug Overlays" />
              <div className="space-y-2">
                <ToggleRow label="Critical Path" color="#ff3030" checked={overlays.critical} onCheckedChange={(v) => setOverlays((o) => ({ ...o, critical: v }))} />
                <ToggleRow label="Loop Edges" color="#33e0ff" checked={overlays.loops} onCheckedChange={(v) => setOverlays((o) => ({ ...o, loops: v }))} />
                <ToggleRow label="MST (Skeleton)" color="#ffffff" checked={overlays.mst} onCheckedChange={(v) => setOverlays((o) => ({ ...o, mst: v }))} />
                <ToggleRow label="Delaunay (proximity)" color="#88aaff" checked={overlays.delaunay} onCheckedChange={(v) => setOverlays((o) => ({ ...o, delaunay: v }))} />
                <ToggleRow label="Difficulty Heatmap" color="#ffaa00" checked={overlays.difficulty} onCheckedChange={(v) => setOverlays((o) => ({ ...o, difficulty: v }))} />
              </div>
            </div>
          </ScrollArea>
        </aside>
      )}

      {/* Right panel: stats + minimap + tests + legend */}
      {rightOpen && (
        <aside className="absolute right-3 top-28 bottom-16 z-20 w-[min(20rem,calc(100vw-1.5rem))]">
          <ScrollArea className="h-full rounded-2xl border border-amber-900/40 bg-black/70 backdrop-blur-md">
            <div className="space-y-5 p-4">
              <PanelTitle icon={<MapIcon className="h-4 w-4 text-amber-500" />} title="Minimap" />
              <div className="group relative rounded-lg border border-amber-900/30 bg-black/60 p-2 transition-colors hover:border-amber-700/50">
                <canvas
                  ref={minimapRef}
                  width={220}
                  height={186}
                  onClick={onMinimapClick}
                  className="h-auto w-full cursor-crosshair"
                  title="Click to focus camera"
                />
                <div className="pointer-events-none absolute right-3 top-3 rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-amber-300/50 opacity-0 transition-opacity group-hover:opacity-100">
                  click to focus
                </div>
              </div>
              {/* quick-nav buttons */}
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="outline" onClick={focusEntrance}
                  className="border-blue-800/40 bg-blue-950/20 text-xs text-blue-200/80 hover:bg-blue-900/30 hover:text-blue-100">
                  <DoorOpen className="mr-1.5 h-3.5 w-3.5" /> Entrance
                </Button>
                <Button size="sm" variant="outline" onClick={focusBoss}
                  className="border-red-800/40 bg-red-950/20 text-xs text-red-200/80 hover:bg-red-900/30 hover:text-red-100">
                  <Skull className="mr-1.5 h-3.5 w-3.5" /> Boss
                </Button>
              </div>

              <Separator className="bg-amber-900/30" />

              <PanelTitle icon={<Zap className="h-4 w-4 text-amber-500" />} title="Stats" />
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-xs">
                <Stat k="Grid" v={`${dungeon.W}×${dungeon.H}`} />
                <Stat k="Rooms" v={`${stats.rooms}`} />
                <Stat k="Edges" v={`${stats.edges}`} />
                <Stat k="Loops" v={`${stats.loops}`} highlight />
                <Stat k="Critical" v={`${stats.criticalLength} hops`} />
                <Stat k="Max Depth" v={`${stats.maxDepth}`} />
                <Stat k="Floor" v={`${stats.floorTiles}`} />
                <Stat k="Wall" v={`${stats.wallTiles}`} />
                <Stat k="Props" v={`${stats.props}`} />
                <Stat k="Spawns" v={`${stats.spawns}`} />
                <Stat k="Lights" v={`${stats.lights}/12`} />
                <Stat k="Gen" v={`${stats.genMs.toFixed(1)}ms`} highlight />
              </div>
              <div className="rounded-lg border border-amber-900/20 bg-amber-950/10 p-2 font-mono text-[10px] text-amber-300/40">
                checksum: {stats.checksum.toString(16).padStart(8, '0')}
              </div>
              {/* shape distribution */}
              <div>
                <Label className="mb-1.5 block text-xs uppercase tracking-wider text-amber-200/50">Room Shapes</Label>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(dungeon.rooms.reduce((m, r) => { m[r.shape] = (m[r.shape] ?? 0) + 1; return m; }, {} as Record<string, number>)).sort().map(([s, n]) => (
                    <span key={s} className="rounded border border-amber-900/30 bg-amber-950/20 px-1.5 py-0.5 text-[9px] text-amber-200/60">
                      {s} <span className="text-amber-300/80">{n}</span>
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <Label className="mb-1.5 block text-xs uppercase tracking-wider text-amber-200/50">Rooms by Type</Label>
                <div className="space-y-1">
                  {Object.entries(typeCounts).sort().map(([t, n]) => {
                    const color = ROOM_TYPE_COLOR[t] ?? '#666';
                    const pct = (n / dungeon.rooms.length) * 100;
                    return (
                      <div key={t} className="flex items-center gap-2">
                        <span className="w-16 shrink-0 text-[10px] capitalize text-amber-100/70">{t}</span>
                        <div className="relative h-3.5 flex-1 overflow-hidden rounded bg-black/40">
                          <div className="h-full rounded transition-all duration-300" style={{ width: `${pct}%`, background: color, opacity: 0.7 }} />
                        </div>
                        <span className="w-6 shrink-0 text-right font-mono text-[10px] text-amber-200/60">{n}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <DifficultyMeter dungeon={dungeon} />

              <Separator className="bg-amber-900/30" />

              <PanelTitle icon={<FlaskConical className="h-4 w-4 text-amber-500" />} title="Acceptance Tests" />
              <div className={`mb-2 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium ${allTestsPass ? 'border-emerald-700/40 bg-emerald-950/20 text-emerald-300' : 'border-red-700/40 bg-red-950/20 text-red-300'}`}>
                {allTestsPass ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                {testResults.filter((t) => t.pass).length + (perfResult?.pass ? 1 : 0)}/{testResults.length + 1} passing
              </div>
              <div className="space-y-1.5">
                {testResults.map((t, i) => <TestRow key={i} t={t} />)}
                {perfResult && <TestRow t={perfResult} />}
              </div>

              <Separator className="bg-amber-900/30" />

              <PanelTitle icon={<Sparkles className="h-4 w-4 text-amber-500" />} title="Legend" />
              <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-[11px] text-amber-100/70">
                <LegendDot color="#6a6258" label="Floor" />
                <LegendDot color="#2a2620" label="Wall" />
                <LegendDot color="#ffb24a" label="Torch / Flame" />
                <LegendDot color="#ff9a3a" label="Brazier" />
                <LegendDot color="#8a5a2a" label="Chest" />
                <LegendDot color="#6ad0ff" label="Shrine Crystal" />
                <LegendDot color="#8aa8ff" label="Entrance Portal" />
                <LegendDot color="#88ff88" label="Spawn (trash)" />
                <LegendDot color="#ff5544" label="Spawn (elite)" />
                <LegendDot color="#ff2222" label="Spawn (boss)" />
                <LegendDot color="#4060ff" label="Entrance Glow" />
                <LegendDot color="#ff2a1a" label="Boss Glow" />
                <LegendDot color="#ff3030" label="Critical Path" />
                <LegendDot color="#33e0ff" label="Loop Edge" />
              </div>
              <p className="pt-1 text-[10px] leading-relaxed text-amber-200/40">
                Scroll to zoom · drag to pan · click minimap to focus ·
                <span className="font-mono text-amber-300/60"> R</span> dice ·
                <span className="font-mono text-amber-300/60"> E</span> entrance ·
                <span className="font-mono text-amber-300/60"> B</span> boss ·
                <span className="font-mono text-amber-300/60"> M</span> audio ·
                <span className="font-mono text-amber-300/60"> Space</span> replay
              </p>
            </div>
          </ScrollArea>
        </aside>
      )}

      {/* Sticky footer */}
      <footer className="z-10 mt-auto border-t border-amber-900/30 bg-black/80 px-4 py-2 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 text-[11px] text-amber-200/50">
          <span className="font-serif tracking-wide">Procedural Dungeon Generator · Isometric Three.js ARPG</span>
          <span className="font-mono">
            {dungeon.rooms.length} rooms · {stats.loops} loops · {stats.floorTiles} floor tiles · {stats.genMs.toFixed(1)} ms
          </span>
        </div>
      </footer>
    </div>
  );
}

// ---- small presentational helpers ----
function PanelTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <h2 className="font-serif text-sm tracking-wide text-amber-100/90">{title}</h2>
    </div>
  );
}

function SliderRow({ label, value, min, max, step, display, onChange }: {
  label: string; value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs uppercase tracking-wider text-amber-200/50">{label}</Label>
        <span className="font-mono text-xs text-amber-300/70">{display}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])}
        className="[&_[role=slider]]:border-amber-500 [&_[role=slider]]:bg-amber-400 [&_.bg-primary]:bg-amber-700/60" />
    </div>
  );
}

function ToggleRow({ label, color, checked, onCheckedChange }: {
  label: string; color: string; checked: boolean; onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-amber-900/20 bg-amber-950/10 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        <span className="text-sm text-amber-100/80">{label}</span>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function Stat({ k, v, highlight }: { k: string; v: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-amber-200/40">{k}</span>
      <span className={highlight ? 'text-amber-300' : 'text-amber-100/80'}>{v}</span>
    </div>
  );
}

function TestRow({ t }: { t: TestResult }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-900/20 bg-amber-950/10 px-2 py-1.5 text-[11px]">
      <span className={`mt-0.5 font-mono ${t.pass ? 'text-emerald-400' : 'text-red-400'}`}>{t.pass ? '✓' : '✗'}</span>
      <div className="min-w-0 flex-1">
        <div className="text-amber-100/80">{t.name}</div>
        <div className="font-mono text-[10px] text-amber-200/40">{t.detail}</div>
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function TooltipButton({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon" variant="outline" onClick={onClick}
            className={`h-9 w-9 border-amber-900/40 backdrop-blur-md ${active ? 'bg-amber-800/50 text-amber-100' : 'bg-black/60 text-amber-300/70 hover:bg-amber-950/40'}`}>
            {icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="border-amber-900/40 bg-black/90 text-amber-100">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---- Difficulty meter (visual ramp from entrance→boss) ----
function DifficultyMeter({ dungeon }: { dungeon: Dungeon }) {
  const rooms = [...dungeon.rooms].sort((a, b) => a.depth - b.depth);
  const maxDepth = dungeon.stats.maxDepth || 1;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs uppercase tracking-wider text-amber-200/50">Difficulty Ramp</Label>
        <span className="font-mono text-[10px] text-amber-300/50">{dungeon.stats.criticalLength} hops → boss</span>
      </div>
      <div className="flex h-5 overflow-hidden rounded-md border border-amber-900/30 bg-black/40">
        {rooms.map((r) => {
          const d = r.difficulty;
          // green→yellow→red
          const red = d < 0.5 ? Math.round(d * 2 * 255) : 255;
          const grn = d < 0.5 ? 255 : Math.round((1 - (d - 0.5) * 2) * 255);
          const title = `${r.type} · depth ${r.depth} · ${(d * 100).toFixed(0)}%`;
          const isKey = r.type === 'entrance' || r.type === 'boss' || r.type === 'treasure' || r.type === 'shrine' || r.type === 'elite';
          return (
            <div
              key={r.id}
              title={title}
              className={isKey ? 'ring-1 ring-white/30' : ''}
              style={{ flex: 1, background: `rgb(${red},${grn},40)`, minWidth: 2 }}
            />
          );
        })}
      </div>
      <div className="flex justify-between font-mono text-[9px] text-amber-300/40">
        <span>entrance {(dungeon.rooms[dungeon.entranceId].difficulty * 100).toFixed(0)}%</span>
        <span>boss {(dungeon.rooms[dungeon.bossId].difficulty * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}

// ---- URL hash params parsing (shareable seeds) ----
function parseHashParams(): Params {
  const p: Params = { ...DEFAULT_PARAMS };
  try {
    const h = window.location.hash.replace(/^#/, '');
    if (!h) return p;
    for (const pair of h.split('&')) {
      const [k, v] = pair.split('=');
      if (k === 'seed') p.seed = Math.max(0, parseInt(v, 10) || DEFAULT_PARAMS.seed) >>> 0;
      else if (k === 'rooms') p.roomCount = Math.max(8, Math.min(80, parseInt(v, 10) || DEFAULT_PARAMS.roomCount));
      else if (k === 'loops') p.loopChance = Math.max(0, Math.min(0.5, parseFloat(v) || DEFAULT_PARAMS.loopChance));
      else if (k === 'decor') p.decorDensity = Math.max(0, Math.min(1, parseFloat(v) || DEFAULT_PARAMS.decorDensity));
      else if (k === 'theme' && ['crypt', 'cavern', 'catacomb', 'forge'].includes(v)) p.theme = v as Theme;
    }
  } catch { /* ignore */ }
  return p;
}

// ---- Ambient atmospheric audio (Web Audio API synth, no asset files) ----
// A low drone + slow LFO + occasional drips. Fully synthesized so there are no
// binary assets to ship. Created on first user toggle (browsers block autoplay).
class DungeonAudio {
  private ctx: AudioContext | null = null;
  private nodes: AudioNode[] = [];
  private dripInterval: ReturnType<typeof setInterval> | null = null;

  start() {
    if (this.ctx) return;
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext);
    if (!Ctx) return;
    this.ctx = new Ctx();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // master gain (quiet)
    const master = ctx.createGain();
    master.gain.value = 0.12;
    master.connect(ctx.destination);
    this.nodes.push(master);

    // low drone: two detuned oscillators through a lowpass
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 2;
    lp.connect(master);
    this.nodes.push(lp);

    const drone1 = ctx.createOscillator();
    drone1.type = 'sawtooth'; drone1.frequency.value = 55;
    const drone2 = ctx.createOscillator();
    drone2.type = 'sawtooth'; drone2.frequency.value = 55.4; // slight detune
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.35;
    drone1.connect(droneGain); drone2.connect(droneGain);
    droneGain.connect(lp);
    drone1.start(now); drone2.start(now);
    this.nodes.push(drone1, drone2, droneGain);

    // slow LFO on the lowpass cutoff (breathing wind effect)
    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.08;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain); lfoGain.connect(lp.frequency);
    lfo.start(now);
    this.nodes.push(lfo, lfoGain);

    // occasional drips (filtered noise burst)
    this.dripInterval = setInterval(() => {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800 + Math.random() * 400, t);
      osc.frequency.exponentialRampToValueAtTime(200, t + 0.15);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.08, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.connect(g); g.connect(master);
      osc.start(t); osc.stop(t + 0.35);
    }, 2500 + Math.random() * 3000);
  }

  stop() {
    if (this.dripInterval) { clearInterval(this.dripInterval); this.dripInterval = null; }
    if (this.ctx) {
      for (const n of this.nodes) {
        try { (n as any).stop?.(); } catch {}
        try { n.disconnect(); } catch {}
      }
      this.nodes = [];
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
