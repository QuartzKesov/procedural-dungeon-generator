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
  Save, Bookmark, Trash2, Download, RotateCw, Route,
  Sun, Moon, History, X, Info, List, Keyboard,
  ArrowDown, ArrowUp, CloudRain, Snowflake, Flame, FileJson, Columns2, Images,
} from 'lucide-react';
import { downloadExport } from '@/lib/dungeon/export';
import type { WeatherType } from '@/lib/dungeon/types';

interface ThreeState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  dungeonScene: DungeonScene | null;
  startTime: number;
  raf: number;
  zoom: number;
  pan: THREE.Vector2; // world-space pan offset
  cameraYaw: number;
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
  const minimapViewportRef = useRef<(() => void) | null>(null);

  const [params, setParams] = useState<Params>(() => parseHashParams());
  const [overlays, setOverlays] = useState<OverlayToggles>({
    delaunay: false, mst: false, loops: false, critical: false, difficulty: false, patrols: false,
  });
  const [animateBuild, setAnimateBuild] = useState(true);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [perfResult, setPerfResult] = useState<TestResult | null>(null);
  const [audioOn, setAudioOn] = useState(false);
  const [copied, setCopied] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [showPresets, setShowPresets] = useState(false);
  const [selectedRoom, setSelectedRoom] = useState<number>(-1);
  const [hoveredRoom, setHoveredRoom] = useState<number>(-1);
  const [hoveredScreen, setHoveredScreen] = useState<{ x: number; y: number } | null>(null);
  const [dayMode, setDayMode] = useState(false);
  const [seedHistory, setSeedHistory] = useState<number[]>([]);
  const [showRoomList, setShowRoomList] = useState(false);
  const [roomListFilter, setRoomListFilter] = useState<string>('all');
  const [showHelp, setShowHelp] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [compareSeed, setCompareSeed] = useState<number>(0);
  const [showGallery, setShowGallery] = useState(false);

  // Generate the dungeon whenever params change. Fast (~25ms) → synchronous.
  const dungeon = useMemo<Dungeon>(() => generateDungeon(params), [params]);
  const testResults = useMemo<TestResult[]>(() => runTestsOnDungeon(dungeon), [dungeon]);

  // ---- sync params → URL hash (shareable seeds) ----
  useEffect(() => {
    const hash = `#seed=${params.seed}&rooms=${params.roomCount}&loops=${params.loopChance}&decor=${params.decorDensity}&theme=${params.theme}&events=${params.eventDensity}&weather=${params.weather}&ml=${params.multiLevel?1:0}&lv=${params.levelCount}`;
    if (hash !== window.location.hash) {
      window.history.replaceState(null, '', hash);
    }
  }, [params]);

  // ---- track seed history (recent 10 unique seeds) ----
  useEffect(() => {
    setSeedHistory((prev) => {
      const next = [params.seed, ...prev.filter((s) => s !== params.seed)].slice(0, 10);
      try { localStorage.setItem('dungeon-seed-history', JSON.stringify(next)); } catch {}
      return next;
    });
  }, [params.seed]);
  // load seed history on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem('dungeon-seed-history');
      if (raw) setSeedHistory(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  // ---- day/night mode: smooth transition (animated) ----
  // Instead of instantly switching, interpolate fog density + light intensity
  // over ~800ms using requestAnimationFrame.
  useEffect(() => {
    const state = threeRef.current;
    if (!state) return;
    const targetFog = dayMode
      ? Math.max(0.0005, fogDensityFor(dungeon) * 0.3)
      : fogDensityFor(dungeon);
    const targetHemi = dayMode ? 1.8 : 1.3;
    const targetDir = dayMode ? 1.2 : 0.75;
    // capture current values as the "from"
    const fromFog = (state.scene.fog instanceof THREE.FogExp2) ? state.scene.fog.density : targetFog;
    let fromHemi = targetHemi, fromDir = targetDir;
    state.scene.traverse((o) => {
      const light = o as THREE.Light;
      if (light.isHemisphereLight) fromHemi = (light as THREE.HemisphereLight).intensity;
      else if (light.isDirectionalLight) fromDir = (light as THREE.DirectionalLight).intensity;
    });
    const start = performance.now();
    const dur = 800;
    let raf = 0;
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / dur);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      if (state.scene.fog instanceof THREE.FogExp2) {
        state.scene.fog.density = fromFog + (targetFog - fromFog) * e;
      }
      state.scene.traverse((o) => {
        const light = o as THREE.Light;
        if (light.isHemisphereLight) {
          (light as THREE.HemisphereLight).intensity = fromHemi + (targetHemi - fromHemi) * e;
        } else if (light.isDirectionalLight) {
          (light as THREE.DirectionalLight).intensity = fromDir + (targetDir - fromDir) * e;
        }
      });
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dayMode, dungeon]);

  // ---- highlight selected room in scene ----
  useEffect(() => {
    threeRef.current?.dungeonScene?.setHighlightedRoom(selectedRoom);
  }, [selectedRoom, dungeon]);

  // ---- highlight hovered room in scene (subtler ring) ----
  useEffect(() => {
    threeRef.current?.dungeonScene?.setHoveredRoom(hoveredRoom);
  }, [hoveredRoom, dungeon]);

  // ---- listen for room pick events from the canvas ----
  useEffect(() => {
    const onPick = (e: Event) => {
      const roomId = (e as CustomEvent<number>).detail;
      setSelectedRoom(roomId);
    };
    window.addEventListener('dungeon-room-pick', onPick);
    return () => window.removeEventListener('dungeon-room-pick', onPick);
  }, []);

  // ---- listen for room hover events (for tooltip) ----
  useEffect(() => {
    const onHover = (e: Event) => {
      const { roomId, sx, sy } = (e as CustomEvent<{ roomId: number; sx: number; sy: number }>).detail;
      setHoveredRoom(roomId);
      setHoveredScreen(roomId >= 0 ? { x: sx, y: sy } : null);
    };
    window.addEventListener('dungeon-room-hover', onHover);
    return () => window.removeEventListener('dungeon-room-hover', onHover);
  }, []);

  // ---- init Three.js once ----
  useEffect(() => {
    const container = containerRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
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
      raf: 0, zoom: 1, pan: new THREE.Vector2(0, 0), cameraYaw: 45,
    };
    threeRef.current = state;
    // room pick callback (set by React state setter below)
    (state as any).onRoomPicked = (roomId: number) => {
      window.dispatchEvent(new CustomEvent('dungeon-room-pick', { detail: roomId }));
    };
    // room hover callback (for tooltip)
    (state as any).onRoomHovered = (roomId: number, sx: number, sy: number) => {
      window.dispatchEvent(new CustomEvent('dungeon-room-hover', { detail: { roomId, sx, sy } }));
    };

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

    // pinch-zoom (touch): track 2-finger distance, zoom proportionally
    let pinchDist = 0;
    const applyZoom = () => {
      const w = container.clientWidth, h = container.clientHeight;
      const aspect = w / h;
      const half = halfFrustum();
      camera.left = -half * aspect; camera.right = half * aspect;
      camera.top = half; camera.bottom = -half;
      camera.updateProjectionMatrix();
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchDist = Math.sqrt(dx * dx + dy * dy);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (pinchDist > 0) {
          const factor = pinchDist / d; // pinch in (d smaller) → factor > 1 → zoom in
          state.zoom = Math.max(0.4, Math.min(3.5, state.zoom * factor));
          applyZoom();
        }
        pinchDist = d;
      }
    };
    renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: false });
    renderer.domElement.addEventListener('touchmove', onTouchMove, { passive: false });

    // pan (drag) — also track click-vs-drag for room selection
    let dragging = false;
    let downX = 0, downY = 0;
    let lastX = 0, lastY = 0;
    let moved = false;
    const onDown = (e: PointerEvent) => {
      dragging = true; moved = false;
      downX = lastX = e.clientX; downY = lastY = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      // if pointer barely moved, treat as click → pick room
      if (!moved && Math.abs(e.clientX - downX) < 5 && Math.abs(e.clientY - downY) < 5) {
        const ds = threeRef.current?.dungeonScene;
        if (!ds) return;
        const rect = renderer.domElement.getBoundingClientRect();
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        const hit = ds.pickRoom(ndcX, ndcY, camera);
        if (hit && hit.roomId >= 0) {
          (threeRef.current as any)?.onRoomPicked?.(hit.roomId);
        } else {
          (threeRef.current as any)?.onRoomPicked?.(-1);
        }
      }
    };
    const onMove = (e: PointerEvent) => {
      if (dragging) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5) moved = true;
        lastX = e.clientX; lastY = e.clientY;
        // pan in world units: screen delta → world delta via ortho frustum.
        // Direction follows the camera yaw so panning feels natural after rotation.
        const worldPerPx = (camera.top - camera.bottom) / container.clientHeight;
        const yaw = THREE.MathUtils.degToRad((state as any).cameraYaw ?? 45);
        const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
        // screen-x → world (cos, sin); screen-y → (-sin, cos) (perpendicular, tilted by iso)
        state.pan.x -= (dx * cosY - dy * cosY) * worldPerPx;
        state.pan.y -= (dx * sinY + dy * sinY) * worldPerPx;
        applyCamera();
      } else {
        // hover detection — raycast to find which room is under the cursor
        const ds = threeRef.current?.dungeonScene;
        if (!ds) return;
        const rect = renderer.domElement.getBoundingClientRect();
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        const hit = ds.pickRoom(ndcX, ndcY, camera);
        const roomId = (hit && hit.roomId >= 0) ? hit.roomId : -1;
        (threeRef.current as any)?.onRoomHovered?.(roomId, e.clientX, e.clientY);
      }
    };
    const applyCamera = () => {
      const yaw = THREE.MathUtils.degToRad((state as any).cameraYaw ?? 45);
      const pitch = THREE.MathUtils.degToRad(37);
      const dir = new THREE.Vector3(
        Math.cos(pitch) * Math.cos(yaw),
        Math.sin(pitch),
        Math.cos(pitch) * Math.sin(yaw),
      );
      const dist = Math.max(currentDungeon.W, currentDungeon.H) * 0.9 + 30;
      const center = new THREE.Vector3(state.pan.x, 0, state.pan.y);
      camera.position.copy(center).addScaledVector(dir, dist);
      camera.lookAt(center);
      camera.up.set(0, 1, 0);
    };
    // expose rotation for the rotateCamera handler
    (state as any).applyCameraRot = applyCamera;

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
      // redraw minimap viewport indicator (tracks camera pan/zoom)
      const vpFn = minimapViewportRef.current;
      if (vpFn) vpFn();
    };
    loop();

    return () => {
      cancelAnimationFrame(state.raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.domElement.removeEventListener('touchstart', onTouchStart);
      renderer.domElement.removeEventListener('touchmove', onTouchMove);
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

  // ---- minimap base (static, redrawn on dungeon change) ----
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
    // markers — draw distinctive icons for key room types
    const dot = (x: number, y: number, color: string, r: number) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x * sx + sx / 2, y * sy + sy / 2, r, 0, Math.PI * 2);
      ctx.fill();
    };
    // entrance: white diamond
    const ent = d.rooms[d.entranceId];
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(ent.cx * sx + sx / 2, ent.cy * sy + sy / 2 - 4);
    ctx.lineTo(ent.cx * sx + sx / 2 + 4, ent.cy * sy + sy / 2);
    ctx.lineTo(ent.cx * sx + sx / 2, ent.cy * sy + sy / 2 + 4);
    ctx.lineTo(ent.cx * sx + sx / 2 - 4, ent.cy * sy + sy / 2);
    ctx.closePath();
    ctx.fill();
    // boss: red skull-like cross
    const boss = d.rooms[d.bossId];
    ctx.strokeStyle = '#ff2222';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(boss.cx * sx + sx / 2 - 4, boss.cy * sy + sy / 2 - 4);
    ctx.lineTo(boss.cx * sx + sx / 2 + 4, boss.cy * sy + sy / 2 + 4);
    ctx.moveTo(boss.cx * sx + sx / 2 + 4, boss.cy * sy + sy / 2 - 4);
    ctx.lineTo(boss.cx * sx + sx / 2 - 4, boss.cy * sy + sy / 2 + 4);
    ctx.stroke();
    // treasure: gold star (dot with ring)
    for (const r of d.rooms) if (r.type === 'treasure') {
      dot(r.cx, r.cy, '#ffd24a', 3);
      ctx.strokeStyle = '#ffd24a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(r.cx * sx + sx / 2, r.cy * sy + sy / 2, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    // shrine: cyan plus
    for (const r of d.rooms) if (r.type === 'shrine') {
      ctx.strokeStyle = '#40d0ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(r.cx * sx + sx / 2, r.cy * sy + sy / 2 - 4);
      ctx.lineTo(r.cx * sx + sx / 2, r.cy * sy + sy / 2 + 4);
      ctx.moveTo(r.cx * sx + sx / 2 - 4, r.cy * sy + sy / 2);
      ctx.lineTo(r.cx * sx + sx / 2 + 4, r.cy * sy + sy / 2);
      ctx.stroke();
    }
    // elite: orange triangle
    for (const r of d.rooms) if (r.type === 'elite') {
      ctx.fillStyle = '#ff7a3a';
      ctx.beginPath();
      ctx.moveTo(r.cx * sx + sx / 2, r.cy * sy + sy / 2 - 4);
      ctx.lineTo(r.cx * sx + sx / 2 + 3.5, r.cy * sy + sy / 2 + 3);
      ctx.lineTo(r.cx * sx + sx / 2 - 3.5, r.cy * sy + sy / 2 + 3);
      ctx.closePath();
      ctx.fill();
    }
    // store the base image for the viewport overlay to redraw on top of
    (canvas as any)._baseImage = ctx.getImageData(0, 0, W, H);
  }, [dungeon]);

  useEffect(() => { drawMinimap(); }, [drawMinimap]);

  // ---- minimap viewport indicator (drawn every frame on top of base) ----
  const drawMinimapViewport = useCallback(() => {
    const canvas = minimapRef.current;
    const state = threeRef.current;
    if (!canvas || !state) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const d = dungeon;
    const W = canvas.width, H = canvas.height;
    const sx = W / d.W, sy = H / d.H;
    // restore base image
    const base = (canvas as any)._baseImage;
    if (base) ctx.putImageData(base, 0, 0);
    else return;
    // The ortho camera looks at (pan.x, 0, pan.y) in world space.
    // Grid space = world + center, so viewport center in grid = pan + center.
    const cx = (d.W - 1) / 2, cz = (d.H - 1) / 2;
    const vcx = state.pan.x + cx;
    const vcy = state.pan.y + cz;
    // viewport center in minimap pixels (y is flipped)
    const px = vcx * sx;
    const py = (d.H - vcy) * sy;
    // draw a crosshair marker at the viewport center
    ctx.strokeStyle = 'rgba(255, 200, 100, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px - 6, py); ctx.lineTo(px + 6, py);
    ctx.moveTo(px, py - 6); ctx.lineTo(px, py + 6);
    ctx.stroke();
    // small circle around the crosshair
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.stroke();
    // also draw a clamped viewport rectangle (clipped to minimap bounds)
    const halfW = (state.camera.right - state.camera.left) / 2;
    const halfH = (state.camera.top - state.camera.bottom) / 2;
    const ext = (halfW + halfH) / Math.SQRT2;
    const gx0 = vcx - ext, gx1 = vcx + ext;
    const gy0 = vcy - ext, gy1 = vcy + ext;
    const rx0 = gx0 * sx, rx1 = gx1 * sx;
    const ry0 = (d.H - gy1) * sy, ry1 = (d.H - gy0) * sy;
    const rx = Math.max(0, Math.min(rx0, rx1));
    const ry = Math.max(0, Math.min(ry0, ry1));
    const rw = Math.min(W, Math.max(rx0, rx1)) - rx;
    const rh = Math.min(H, Math.max(ry0, ry1)) - ry;
    if (rw > 2 && rh > 2 && rw < W && rh < H) {
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = 'rgba(255, 200, 100, 0.5)';
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
    }
  }, [dungeon]);
  // keep the ref updated so the render loop can call it
  minimapViewportRef.current = drawMinimapViewport;

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

  // ---- camera rotation (yaw in 45° increments) ----
  const rotateCamera = useCallback((dir: 1 | -1) => {
    const state = threeRef.current;
    if (!state) return;
    (state as any).cameraYaw = (((state as any).cameraYaw ?? 45) + dir * 45) % 360;
    (state as any).applyCameraRot?.();
  }, []);

  // ---- export dungeon as PNG ----
  const exportPng = useCallback(() => {
    const state = threeRef.current;
    if (!state) return;
    // render once to ensure latest frame, then grab canvas
    state.renderer.render(state.scene, state.camera);
    const dataUrl = state.renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `dungeon-${dungeon.params.seed}-${dungeon.params.theme}.png`;
    a.click();
  }, [dungeon]);

  // ---- presets (localStorage) ----
  useEffect(() => {
    try {
      const raw = localStorage.getItem('dungeon-presets');
      if (raw) setPresets(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);
  const savePreset = useCallback(() => {
    const name = presetName.trim() || `Seed ${params.seed}`;
    const preset: Preset = { name, params: { ...params }, at: Date.now() };
    const next = [preset, ...presets.filter((p) => p.name !== name)].slice(0, 20);
    setPresets(next);
    try { localStorage.setItem('dungeon-presets', JSON.stringify(next)); } catch {}
    setPresetName('');
  }, [presetName, params, presets]);
  const loadPreset = useCallback((p: Preset) => {
    setParams({ ...p.params });
    setShowPresets(false);
  }, []);
  const deletePreset = useCallback((name: string) => {
    const next = presets.filter((p) => p.name !== name);
    setPresets(next);
    try { localStorage.setItem('dungeon-presets', JSON.stringify(next)); } catch {}
  }, [presets]);

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
      else if (e.key === 'q' || e.key === 'Q') rotateCamera(-1);
      else if (e.key === 't' || e.key === 'T') rotateCamera(1);
      else if (e.key === '?' || e.key === 'h' || e.key === 'H') { e.preventDefault(); setShowHelp((v) => !v); }
      else if (e.key === 'Escape') { setShowHelp(false); setSelectedRoom(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rollDice, regenerate, replayBuild, focusEntrance, focusBoss, toggleAudio, rotateCamera]);

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
          <div className="mx-1 hidden h-5 w-px bg-amber-900/40 md:block" />
          <button
            onClick={() => rotateCamera(-1)}
            title="Rotate camera left (Q)"
            className="pointer-events-auto hidden h-7 w-7 items-center justify-center rounded-full border border-amber-800/40 bg-amber-950/20 text-amber-300/70 transition-colors hover:bg-amber-900/40 hover:text-amber-100 md:flex"
          >
            <RotateCw className="h-3.5 w-3.5 -scale-x-100" />
          </button>
          <button
            onClick={() => rotateCamera(1)}
            title="Rotate camera right (T)"
            className="pointer-events-auto hidden h-7 w-7 items-center justify-center rounded-full border border-amber-800/40 bg-amber-950/20 text-amber-300/70 transition-colors hover:bg-amber-900/40 hover:text-amber-100 md:flex"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={exportPng}
            title="Export as PNG"
            className="pointer-events-auto hidden h-7 w-7 items-center justify-center rounded-full border border-amber-800/40 bg-amber-950/20 text-amber-300/70 transition-colors hover:bg-emerald-900/40 hover:text-emerald-200 md:flex"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setDayMode((v) => !v)}
            title="Day/night mode"
            className={`pointer-events-auto hidden h-7 w-7 items-center justify-center rounded-full border transition-colors md:flex ${dayMode ? 'border-amber-400/60 bg-amber-500/30 text-amber-100' : 'border-amber-800/40 bg-amber-950/20 text-amber-300/70 hover:bg-amber-900/40 hover:text-amber-100'}`}
          >
            {dayMode ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => setShowHelp(true)}
            title="Keyboard shortcuts (?)"
            className="pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full border border-amber-800/40 bg-amber-950/20 text-amber-300/70 transition-colors hover:bg-amber-900/40 hover:text-amber-100"
          >
            <Keyboard className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* Keyboard help overlay */}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}

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
                    {(['crypt', 'cavern', 'catacomb', 'forge', 'ice', 'jungle'] as Theme[]).map((t) => (
                      <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* ---- Event density slider ---- */}
              <SliderRow label="Events" value={params.eventDensity} min={0} max={1} step={0.05}
                display={params.eventDensity.toFixed(2)} onChange={(v) => setParams((p) => ({ ...p, eventDensity: v }))} />

              {/* ---- Weather select ---- */}
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-amber-200/50">Weather</Label>
                <Select value={params.weather} onValueChange={(v) => setParams((p) => ({ ...p, weather: v as WeatherType }))}>
                  <SelectTrigger className="border-amber-900/40 bg-amber-950/20 text-amber-100">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-amber-900/40 bg-black/90 text-amber-100">
                    {(['none', 'rain', 'snow', 'ash'] as WeatherType[]).map((w) => (
                      <SelectItem key={w} value={w} className="capitalize">{w}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* ---- Multi-level toggle + level controls ---- */}
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-amber-900/30 bg-amber-950/10 px-3 py-1.5">
                  <Label className="text-xs text-amber-100/80">Multi-Level</Label>
                  <Switch checked={params.multiLevel} onCheckedChange={(v) => setParams((p) => ({ ...p, multiLevel: v, currentLevel: 0 }))} />
                </div>
                {params.multiLevel && (
                  <div className="space-y-2">
                    <SliderRow label="Floors" value={params.levelCount} min={1} max={5} step={1}
                      display={`${params.levelCount}`} onChange={(v) => setParams((p) => ({ ...p, levelCount: v, currentLevel: 0 }))} />
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-amber-300/50">Floor {params.currentLevel + 1}/{params.levelCount}</span>
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" disabled={params.currentLevel === 0}
                          onClick={() => setParams((p) => ({ ...p, currentLevel: Math.max(0, p.currentLevel - 1), seed: p.seed }))}
                          className="h-6 w-6 border-amber-800/40 bg-amber-950/20 p-0 text-amber-300 hover:bg-amber-900/40">
                          <ArrowUp className="h-3 w-3" />
                        </Button>
                        <Button size="sm" variant="outline" disabled={params.currentLevel >= params.levelCount - 1}
                          onClick={() => setParams((p) => ({ ...p, currentLevel: Math.min(p.levelCount - 1, p.currentLevel + 1) }))}
                          className="h-6 w-6 border-amber-800/40 bg-amber-950/20 p-0 text-amber-300 hover:bg-amber-900/40">
                          <ArrowDown className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* seed history */}
              {seedHistory.length > 1 && (
                <div className="space-y-1.5">
                  <Label className="text-xs uppercase tracking-wider text-amber-200/50">Recent Seeds</Label>
                  <div className="flex flex-wrap gap-1">
                    {seedHistory.map((s, i) => (
                      <button
                        key={s + '-' + i}
                        onClick={() => setParams((p) => ({ ...p, seed: s }))}
                        title={`Load seed ${s}`}
                        className={`rounded border px-1.5 py-0.5 font-mono text-[9px] transition-colors ${s === params.seed ? 'border-amber-500/60 bg-amber-800/40 text-amber-100' : 'border-amber-900/30 bg-amber-950/20 text-amber-300/60 hover:bg-amber-900/30 hover:text-amber-100'}`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <Button onClick={regenerate} className="flex-1 border-amber-700/50 bg-amber-800/40 text-amber-50 hover:bg-amber-700/50">
                  <RefreshCw className="mr-2 h-4 w-4" /> Regenerate
                </Button>
              </div>

              {/* ---- Export / Gallery / Compare buttons ---- */}
              <div className="grid grid-cols-3 gap-2">
                <Button size="sm" variant="outline" onClick={() => downloadExport(dungeon, 'dungeon-json')}
                  className="border-amber-800/40 bg-amber-950/20 text-xs text-amber-300 hover:bg-amber-900/30" title="Export as JSON">
                  <FileJson className="mr-1 h-3.5 w-3.5" /> JSON
                </Button>
                <Button size="sm" variant="outline" onClick={() => downloadExport(dungeon, 'tiled')}
                  className="border-amber-800/40 bg-amber-950/20 text-xs text-amber-300 hover:bg-amber-900/30" title="Export as Tiled">
                  <Layers className="mr-1 h-3.5 w-3.5" /> Tiled
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setCompareSeed(params.seed); setShowCompare(true); }}
                  className="border-amber-800/40 bg-amber-950/20 text-xs text-amber-300 hover:bg-amber-900/30" title="Compare two seeds">
                  <Columns2 className="mr-1 h-3.5 w-3.5" /> Compare
                </Button>
              </div>
              <Button size="sm" variant="outline" onClick={() => setShowGallery(true)}
                className="w-full border-amber-800/40 bg-amber-950/20 text-xs text-amber-300 hover:bg-amber-900/30">
                <Images className="mr-1.5 h-3.5 w-3.5" /> Gallery
              </Button>

              {/* Presets: save / load / delete */}
              <div className="space-y-2">
                <button
                  onClick={() => setShowPresets((v) => !v)}
                  className="flex w-full items-center justify-between rounded-lg border border-amber-900/30 bg-amber-950/10 px-3 py-1.5 text-xs text-amber-200/70 transition-colors hover:bg-amber-900/20"
                >
                  <span className="flex items-center gap-1.5"><Bookmark className="h-3.5 w-3.5" /> Presets</span>
                  <span className="font-mono text-[10px] text-amber-300/50">{presets.length} saved</span>
                </button>
                {showPresets && (
                  <div className="space-y-2 rounded-lg border border-amber-900/30 bg-black/40 p-2">
                    <div className="flex gap-1.5">
                      <Input
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                        placeholder="Preset name…"
                        className="h-8 border-amber-900/40 bg-amber-950/20 text-xs text-amber-100"
                        onKeyDown={(e) => { if (e.key === 'Enter') savePreset(); }}
                      />
                      <Button size="sm" onClick={savePreset} title="Save current params as preset"
                        className="h-8 shrink-0 border-amber-700/50 bg-amber-800/40 px-2 text-amber-50 hover:bg-amber-700/50">
                        <Save className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="max-h-40 space-y-1 overflow-y-auto">
                      {presets.length === 0 && (
                        <p className="py-2 text-center text-[10px] text-amber-300/40">No presets saved yet</p>
                      )}
                      {presets.map((p) => (
                        <div key={p.name} className="group flex items-center gap-1 rounded border border-amber-900/20 bg-amber-950/20 px-2 py-1">
                          <button onClick={() => loadPreset(p)} className="min-w-0 flex-1 text-left">
                            <div className="truncate text-[11px] text-amber-100/80">{p.name}</div>
                            <div className="font-mono text-[9px] text-amber-300/40">seed {p.params.seed} · {p.params.roomCount}r · {p.params.theme}</div>
                          </button>
                          <button onClick={() => deletePreset(p.name)} title="Delete preset"
                            className="shrink-0 text-amber-300/30 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100">
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
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
                <ToggleRow label="Enemy Patrols" color="#ffcc44" checked={overlays.patrols} onCheckedChange={(v) => setOverlays((o) => ({ ...o, patrols: v }))} />
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
                  onWheel={(e) => {
                    e.preventDefault();
                    const state = threeRef.current;
                    if (!state) return;
                    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
                    state.zoom = Math.max(0.4, Math.min(3.5, state.zoom * factor));
                    const container = containerRef.current!;
                    const aspect = container.clientWidth / container.clientHeight;
                    const half = (dungeon.W + dungeon.H) * 0.42 / state.zoom;
                    state.camera.left = -half * aspect; state.camera.right = half * aspect;
                    state.camera.top = half; state.camera.bottom = -half;
                    state.camera.updateProjectionMatrix();
                  }}
                  className="h-auto w-full cursor-crosshair"
                  title="Click to focus · scroll to zoom"
                />
                <div className="pointer-events-none absolute right-3 top-3 rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-amber-300/50 opacity-0 transition-opacity group-hover:opacity-100">
                  click to focus · scroll to zoom
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
                <AnimatedStat k="Rooms" v={stats.rooms} />
                <AnimatedStat k="Edges" v={stats.edges} />
                <AnimatedStat k="Loops" v={stats.loops} highlight />
                <AnimatedStat k="Critical" v={stats.criticalLength} suffix=" hops" />
                <AnimatedStat k="Max Depth" v={stats.maxDepth} />
                <AnimatedStat k="Floor" v={stats.floorTiles} />
                <AnimatedStat k="Wall" v={stats.wallTiles} />
                <AnimatedStat k="Props" v={stats.props} />
                <AnimatedStat k="Spawns" v={stats.spawns} />
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

              {/* Room list — filterable, click to focus */}
              <div className="space-y-2">
                <button
                  onClick={() => setShowRoomList((v) => !v)}
                  className="flex w-full items-center justify-between rounded-lg border border-amber-900/30 bg-amber-950/10 px-3 py-1.5 text-xs text-amber-200/70 transition-colors hover:bg-amber-900/20"
                >
                  <span className="flex items-center gap-1.5"><List className="h-3.5 w-3.5" /> Room List</span>
                  <span className="font-mono text-[10px] text-amber-300/50">{dungeon.rooms.length} rooms</span>
                </button>
                {showRoomList && (
                  <div className="space-y-2 rounded-lg border border-amber-900/30 bg-black/40 p-2">
                    {/* filter buttons */}
                    <div className="flex flex-wrap gap-1">
                      {['all', 'entrance', 'boss', 'treasure', 'shrine', 'elite', 'combat'].map((t) => (
                        <button
                          key={t}
                          onClick={() => setRoomListFilter(t)}
                          className={`rounded px-1.5 py-0.5 text-[9px] capitalize transition-colors ${roomListFilter === t ? 'bg-amber-800/50 text-amber-100' : 'bg-amber-950/30 text-amber-300/50 hover:bg-amber-900/30'}`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    {/* room list — scrollable */}
                    <div className="max-h-48 space-y-0.5 overflow-y-auto">
                      {dungeon.rooms
                        .filter((r) => roomListFilter === 'all' || r.type === roomListFilter)
                        .sort((a, b) => a.depth - b.depth)
                        .map((r) => {
                          const color = ROOM_TYPE_COLOR[r.type] ?? '#9a8a78';
                          return (
                            <button
                              key={r.id}
                              onClick={() => {
                                setSelectedRoom(r.id);
                                focusOnCellRef.current?.(r.cx, r.cy);
                              }}
                              onMouseEnter={() => setHoveredRoom(r.id)}
                              onMouseLeave={() => setHoveredRoom(-1)}
                              className={`flex w-full items-center gap-2 rounded border px-2 py-1 text-left transition-colors ${selectedRoom === r.id ? 'border-amber-500/50 bg-amber-900/30' : 'border-amber-900/20 bg-amber-950/10 hover:bg-amber-900/20'}`}
                            >
                              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                              <span className="w-14 shrink-0 text-[10px] capitalize text-amber-100/70">{r.type}</span>
                              <span className="shrink-0 font-mono text-[9px] text-amber-300/40">#{r.id}</span>
                              <span className="ml-auto flex items-center gap-1.5">
                                <span className="font-mono text-[9px] text-amber-200/40">d{r.depth}</span>
                                <span className="font-mono text-[9px]" style={{ color }}>{(r.difficulty * 100).toFixed(0)}%</span>
                              </span>
                            </button>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>

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
              <div className="space-y-2">
                <div className="rounded-lg border border-amber-900/20 bg-amber-950/10 p-2">
                  <div className="mb-1 text-[9px] uppercase tracking-wider text-amber-300/40">Geometry</div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-amber-100/70">
                    <LegendDot color="#6a6258" label="Floor" />
                    <LegendDot color="#2a2620" label="Wall" />
                  </div>
                </div>
                <div className="rounded-lg border border-amber-900/20 bg-amber-950/10 p-2">
                  <div className="mb-1 text-[9px] uppercase tracking-wider text-amber-300/40">Props</div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-amber-100/70">
                    <LegendDot color="#ffb24a" label="Torch / Flame" />
                    <LegendDot color="#ff9a3a" label="Brazier" />
                    <LegendDot color="#8a5a2a" label="Chest" />
                    <LegendDot color="#6ad0ff" label="Crystal" />
                    <LegendDot color="#8aa8ff" label="Portal" />
                  </div>
                </div>
                <div className="rounded-lg border border-amber-900/20 bg-amber-950/10 p-2">
                  <div className="mb-1 text-[9px] uppercase tracking-wider text-amber-300/40">Spawns & Glows</div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-amber-100/70">
                    <LegendDot color="#88ff88" label="Trash" />
                    <LegendDot color="#ff5544" label="Elite" />
                    <LegendDot color="#ff2222" label="Boss" />
                    <LegendDot color="#4060ff" label="Entrance Glow" />
                    <LegendDot color="#ff2a1a" label="Boss Glow" />
                  </div>
                </div>
                <div className="rounded-lg border border-amber-900/20 bg-amber-950/10 p-2">
                  <div className="mb-1 text-[9px] uppercase tracking-wider text-amber-300/40">Overlays</div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-amber-100/70">
                    <LegendDot color="#ff3030" label="Critical Path" />
                    <LegendDot color="#33e0ff" label="Loop Edge" />
                    <LegendDot color="#ffdd33" label="Patrol Route" />
                  </div>
                </div>
              </div>
              <p className="pt-1 text-[10px] leading-relaxed text-amber-200/40">
                Scroll/pinch to zoom · drag to pan · click minimap to focus ·
                <span className="font-mono text-amber-300/60"> R</span> dice ·
                <span className="font-mono text-amber-300/60"> E</span> entrance ·
                <span className="font-mono text-amber-300/60"> B</span> boss ·
                <span className="font-mono text-amber-300/60"> Q</span>/<span className="font-mono text-amber-300/60">T</span> rotate ·
                <span className="font-mono text-amber-300/60"> M</span> audio ·
                <span className="font-mono text-amber-300/60"> Space</span> replay
              </p>
            </div>
          </ScrollArea>
        </aside>
      )}

      {/* Room inspector — floating card when a room is selected */}
      {selectedRoom >= 0 && selectedRoom < dungeon.rooms.length && (
        <RoomInspector
          room={dungeon.rooms[selectedRoom]}
          dungeon={dungeon}
          onClose={() => setSelectedRoom(-1)}
          onFocus={() => {
            const r = dungeon.rooms[selectedRoom];
            focusOnCellRef.current?.(r.cx, r.cy);
          }}
        />
      )}

      {/* Room hover tooltip — lightweight preview following the cursor */}
      {hoveredRoom >= 0 && hoveredRoom !== selectedRoom && hoveredRoom < dungeon.rooms.length && hoveredScreen && (
        <RoomHoverTooltip
          room={dungeon.rooms[hoveredRoom]}
          x={hoveredScreen.x}
          y={hoveredScreen.y}
        />
      )}

      {/* ---- Compare overlay ---- */}
      {showCompare && (
        <CompareOverlay
          dungeonA={dungeon}
          seedB={compareSeed}
          params={params}
          onClose={() => setShowCompare(false)}
          onSeedBChange={setCompareSeed}
        />
      )}

      {/* ---- Gallery overlay ---- */}
      {showGallery && (
        <GalleryOverlay
          presets={presets}
          onClose={() => setShowGallery(false)}
          onLoad={(p) => { setParams({ ...p }); setShowGallery(false); }}
        />
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

// ---- Keyboard Help Overlay (modal showing all shortcuts) ----
function HelpOverlay({ onClose }: { onClose: () => void }) {
  const shortcuts: Array<{ key: string; desc: string }> = [
    { key: 'R', desc: 'Roll random seed (dice)' },
    { key: 'G', desc: 'Regenerate dungeon' },
    { key: 'E', desc: 'Focus camera on entrance' },
    { key: 'B', desc: 'Focus camera on boss' },
    { key: 'Q', desc: 'Rotate camera left (45°)' },
    { key: 'T', desc: 'Rotate camera right (45°)' },
    { key: 'Space', desc: 'Replay staged build animation' },
    { key: 'M', desc: 'Toggle ambient audio' },
    { key: '?', desc: 'Toggle this help overlay' },
    { key: 'Esc', desc: 'Close help / deselect room' },
  ];
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="pointer-events-auto w-[min(28rem,calc(100vw-2rem))] animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rounded-2xl border border-amber-800/50 bg-black/90 p-6 shadow-2xl backdrop-blur-md">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Keyboard className="h-5 w-5 text-amber-500" />
              <h2 className="font-serif text-base text-amber-100">Keyboard Shortcuts</h2>
            </div>
            <button onClick={onClose} className="text-amber-300/50 hover:text-amber-100">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="space-y-1.5">
            {shortcuts.map((s) => (
              <div key={s.key} className="flex items-center gap-3 rounded-lg border border-amber-900/20 bg-amber-950/10 px-3 py-2">
                <kbd className="inline-flex h-7 min-w-7 items-center justify-center rounded border border-amber-700/50 bg-amber-900/30 px-1.5 font-mono text-xs text-amber-200">
                  {s.key}
                </kbd>
                <span className="text-sm text-amber-100/70">{s.desc}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-lg border border-amber-900/20 bg-amber-950/10 p-3 text-[11px] text-amber-200/40">
            <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-amber-300/40">Mouse / Touch</div>
            <div>Scroll / pinch — zoom · Drag — pan · Click room — inspect · Click minimap — focus camera</div>
          </div>
          <p className="mt-3 text-center text-[10px] text-amber-300/30">Press <kbd className="font-mono">?</kbd> or <kbd className="font-mono">Esc</kbd> to close</p>
        </div>
      </div>
    </div>
  );
}

// ---- Compare stat row helper ----
function CompareStat({ k, a, b }: { k: string; a: string | number; b: string | number }) {
  return (
    <div className="flex items-center justify-between border-b border-amber-900/20 py-0.5 text-[11px] font-mono">
      <span className="text-amber-200/40">{k}</span>
      <span className="text-amber-100/80">{a}</span>
      <span className="text-amber-300/40">vs</span>
      <span className="text-amber-100/80">{b}</span>
    </div>
  );
}

// ---- Compare Overlay (two dungeons side by side) ----
function CompareOverlay({ dungeonA, seedB, params, onClose, onSeedBChange }: {
  dungeonA: Dungeon; seedB: number; params: Params; onClose: () => void; onSeedBChange: (s: number) => void;
}) {
  const dungeonB = useMemo(() => generateDungeon({ ...params, seed: seedB, currentLevel: 0 }), [params, seedB]);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="pointer-events-auto w-[min(40rem,calc(100vw-2rem))] animate-in fade-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="rounded-2xl border border-amber-800/50 bg-black/90 p-6 shadow-2xl backdrop-blur-md">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-serif text-base text-amber-100">Seed Comparison</h2>
            <button onClick={onClose} className="text-amber-300/50 hover:text-amber-100"><X className="h-5 w-5" /></button>
          </div>
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs text-amber-200/50">Seed A:</span>
            <span className="font-mono text-xs text-amber-100">{dungeonA.params.seed}</span>
            <span className="mx-2 text-amber-300/30">|</span>
            <span className="text-xs text-amber-200/50">Seed B:</span>
            <Input type="number" value={seedB} onChange={(e) => onSeedBChange(Math.max(0, parseInt(e.target.value || '0', 10)) >>> 0)}
              className="h-7 w-24 border-amber-900/40 bg-amber-950/20 font-mono text-xs text-amber-100" />
            <Button size="sm" variant="outline" onClick={() => onSeedBChange(Math.floor(Math.random() * 1e9) >>> 0)}
              className="h-7 border-amber-800/40 bg-amber-950/20 px-2 text-xs text-amber-300 hover:bg-amber-900/30">
              <Dices className="h-3 w-3" />
            </Button>
          </div>
          <div className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3">
            <CompareStat k="Rooms" a={dungeonA.stats.rooms} b={dungeonB.stats.rooms} />
            <CompareStat k="Loops" a={dungeonA.stats.loops} b={dungeonB.stats.loops} />
            <CompareStat k="Floor" a={dungeonA.stats.floorTiles} b={dungeonB.stats.floorTiles} />
            <CompareStat k="Wall" a={dungeonA.stats.wallTiles} b={dungeonB.stats.wallTiles} />
            <CompareStat k="Props" a={dungeonA.stats.props} b={dungeonB.stats.props} />
            <CompareStat k="Spawns" a={dungeonA.stats.spawns} b={dungeonB.stats.spawns} />
            <CompareStat k="Events" a={dungeonA.stats.events} b={dungeonB.stats.events} />
            <CompareStat k="Max Depth" a={dungeonA.stats.maxDepth} b={dungeonB.stats.maxDepth} />
            <CompareStat k="Critical" a={`${dungeonA.stats.criticalLength}h`} b={`${dungeonB.stats.criticalLength}h`} />
            <CompareStat k="Gen" a={`${dungeonA.stats.genMs.toFixed(1)}ms`} b={`${dungeonB.stats.genMs.toFixed(1)}ms`} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <div className="mb-1 text-center text-[10px] text-amber-200/50">A: {dungeonA.name.slice(0, 30)}</div>
              <MinimapThumb dungeon={dungeonA} />
            </div>
            <div>
              <div className="mb-1 text-center text-[10px] text-amber-200/50">B: {dungeonB.name.slice(0, 30)}</div>
              <MinimapThumb dungeon={dungeonB} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Gallery Overlay (saved presets as thumbnails) ----
function GalleryOverlay({ presets, onClose, onLoad }: {
  presets: Preset[]; onClose: () => void; onLoad: (p: Params) => void;
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="pointer-events-auto w-[min(44rem,calc(100vw-2rem))] max-h-[80vh] animate-in fade-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="rounded-2xl border border-amber-800/50 bg-black/90 p-6 shadow-2xl backdrop-blur-md">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-serif text-base text-amber-100">Gallery</h2>
            <button onClick={onClose} className="text-amber-300/50 hover:text-amber-100"><X className="h-5 w-5" /></button>
          </div>
          {presets.length === 0 ? (
            <p className="py-8 text-center text-sm text-amber-300/40">No saved presets yet. Save some from the left panel!</p>
          ) : (
            <div className="grid max-h-96 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
              {presets.map((p) => {
                const d = generateDungeon(p.params);
                return (
                  <button key={p.name} onClick={() => onLoad(p.params)}
                    className="group rounded-lg border border-amber-900/30 bg-amber-950/10 p-2 transition-colors hover:border-amber-700/50 hover:bg-amber-900/20">
                    <MinimapThumb dungeon={d} />
                    <div className="mt-1.5 truncate text-[10px] font-serif text-amber-100/80">{p.name}</div>
                    <div className="font-mono text-[8px] text-amber-300/40">seed {p.params.seed} · {p.params.theme}</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Minimap thumbnail (canvas rendering for compare/gallery) ----
function MinimapThumb({ dungeon }: { dungeon: Dungeon }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const d = dungeon;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#05040a';
    ctx.fillRect(0, 0, W, H);
    const sx = W / d.W, sy = H / d.H;
    const owner = new Int16Array(d.W * d.H);
    for (const r of d.rooms) for (const c of roomFloorCells(r)) {
      if (c.x < 0 || c.y < 0 || c.x >= d.W || c.y >= d.H) continue;
      if (d.grid[c.y * d.W + c.x] === FLOOR) owner[c.y * d.W + c.x] = r.id + 1;
    }
    const colors: Record<string, string> = {
      entrance: '#6a8cff', boss: '#ff3a2a', treasure: '#ffd24a',
      shrine: '#40d0ff', elite: '#ff7a3a', combat: '#9a8a78',
    };
    for (let y = 0; y < d.H; y++) {
      for (let x = 0; x < d.W; x++) {
        const i = y * d.W + x;
        const v = d.grid[i];
        if (v === FLOOR) {
          const rid = owner[i] - 1;
          const type = rid >= 0 ? d.rooms[rid].type : 'combat';
          ctx.fillStyle = colors[type] ?? '#6a6258';
        } else if (v === WALL) { ctx.fillStyle = '#1c1814'; }
        else continue;
        ctx.fillRect(x * sx, y * sy, Math.ceil(sx) + 1, Math.ceil(sy) + 1);
      }
    }
  }, [dungeon]);
  return <canvas ref={canvasRef} width={140} height={120} className="h-auto w-full rounded border border-amber-900/30" />;
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

// ---- Animated stat counter (count-up on change) ----
function useCountUp(target: number, duration = 600): number {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  const startRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    startRef.current = performance.now();
    let raf = 0;
    const tick = () => {
      const t = Math.min(1, (performance.now() - startRef.current) / duration);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setVal(Math.round(from + (target - from) * e));
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

function AnimatedStat({ k, v, suffix = '', highlight }: { k: string; v: number; suffix?: string; highlight?: boolean }) {
  const display = useCountUp(v);
  return (
    <div className="flex items-center justify-between">
      <span className="text-amber-200/40">{k}</span>
      <span className={`tabular-nums transition-colors ${highlight ? 'text-amber-300' : 'text-amber-100/80'}`}>{display}{suffix}</span>
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

// ---- Room Hover Tooltip (lightweight preview following the cursor) ----
function RoomHoverTooltip({ room, x, y }: { room: Dungeon['rooms'][number]; x: number; y: number }) {
  const typeColor = ROOM_TYPE_COLOR[room.type] ?? '#9a8a78';
  // clamp position so tooltip stays on screen
  const tx = Math.min(x + 14, window.innerWidth - 180);
  const ty = Math.min(y + 14, window.innerHeight - 90);
  return (
    <div
      className="pointer-events-none fixed z-50 w-44 animate-in fade-in duration-150"
      style={{ left: tx, top: ty }}
    >
      <div className="rounded-lg border border-amber-800/50 bg-black/90 p-2.5 shadow-xl backdrop-blur-md">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: typeColor }} />
          <span className="text-[11px] font-serif capitalize text-amber-100">{room.type}</span>
          <span className="ml-auto font-mono text-[9px] text-amber-300/40">#{room.id}</span>
        </div>
        <div className="mt-1.5 space-y-0.5 font-mono text-[9px] text-amber-200/60">
          <div className="flex justify-between"><span>shape</span><span className="text-amber-100/70">{room.shape}</span></div>
          <div className="flex justify-between"><span>depth</span><span className="text-amber-100/70">{room.depth}</span></div>
          <div className="flex justify-between"><span>diff</span><span style={{ color: typeColor }}>{(room.difficulty * 100).toFixed(0)}%</span></div>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/50">
          <div className="h-full rounded-full" style={{
            width: `${room.difficulty * 100}%`,
            background: `linear-gradient(90deg, #22c55e, #eab308, #ef4444)`,
          }} />
        </div>
        <div className="mt-1.5 text-center text-[8px] text-amber-300/30">click to inspect</div>
      </div>
    </div>
  );
}

// ---- Room Inspector (floating card showing selected room details) ----
function RoomInspector({ room, dungeon, onClose, onFocus }: {
  room: Dungeon['rooms'][number];
  dungeon: Dungeon;
  onClose: () => void;
  onFocus: () => void;
}) {
  const typeColor = ROOM_TYPE_COLOR[room.type] ?? '#9a8a78';
  const spawnsInRoom = dungeon.spawns.filter((s) => s.roomId === room.id);
  const propsInRoom = dungeon.props.filter((p) => p.roomId === room.id);
  const isBoss = room.type === 'boss';
  const isEntrance = room.type === 'entrance';
  return (
    <div className="pointer-events-auto absolute bottom-20 left-1/2 z-40 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="rounded-xl border border-amber-900/50 bg-black/85 p-4 shadow-2xl backdrop-blur-md">
        <div className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-full ring-2 ring-white/20" style={{ background: typeColor }} />
            <div>
              <div className="font-serif text-sm capitalize text-amber-100">{room.type} Room #{room.id}</div>
              <div className="font-mono text-[10px] text-amber-300/50">{room.shape} · {room.cells} cells · deg {room.degree}</div>
            </div>
          </div>
          <button onClick={onClose} className="text-amber-300/50 hover:text-amber-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px]">
          <div className="flex justify-between"><span className="text-amber-200/40">Center</span><span className="text-amber-100/80">{room.cx}, {room.cy}</span></div>
          <div className="flex justify-between"><span className="text-amber-200/40">Size</span><span className="text-amber-100/80">{room.w}×{room.h}</span></div>
          <div className="flex justify-between"><span className="text-amber-200/40">Depth</span><span className="text-amber-100/80">{room.depth}</span></div>
          <div className="flex justify-between"><span className="text-amber-200/40">Difficulty</span><span className={isBoss ? 'text-red-400' : 'text-amber-100/80'}>{(room.difficulty * 100).toFixed(0)}%</span></div>
          <div className="flex justify-between"><span className="text-amber-200/40">Spawns</span><span className="text-amber-100/80">{spawnsInRoom.length}</span></div>
          <div className="flex justify-between"><span className="text-amber-200/40">Props</span><span className="text-amber-100/80">{propsInRoom.length}</span></div>
        </div>
        {/* difficulty bar */}
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/50">
          <div className="h-full rounded-full transition-all" style={{
            width: `${room.difficulty * 100}%`,
            background: `linear-gradient(90deg, #22c55e, #eab308, #ef4444)`,
          }} />
        </div>
        {/* spawn tier breakdown */}
        {spawnsInRoom.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {spawnsInRoom.reduce((m, s) => { m[s.tier] = (m[s.tier] ?? 0) + 1; return m; }, {} as Record<number, number>) &&
              Object.entries(spawnsInRoom.reduce((m, s) => { m[s.tier] = (m[s.tier] ?? 0) + 1; return m; }, {} as Record<number, number>)).map(([tier, n]) => (
                <span key={tier} className="rounded border px-1.5 py-0.5 text-[9px]" style={{
                  borderColor: (['#88ff88', '#ffcc44', '#ff5544', '#ff2222'][Number(tier)] ?? '#888') + '66',
                  color: ['#88ff88', '#ffcc44', '#ff5544', '#ff2222'][Number(tier)] ?? '#888',
                  background: (['#88ff88', '#ffcc44', '#ff5544', '#ff2222'][Number(tier)] ?? '#888') + '11',
                }}>
                  {['trash', 'normal', 'elite', 'boss'][Number(tier)]} ×{n}
                </span>
              ))}
          </div>
        )}
        {isEntrance && <p className="mt-2 text-[10px] text-blue-300/60">✦ Starting point — the adventurer's portal home.</p>}
        {isBoss && <p className="mt-2 text-[10px] text-red-300/60">☠ Final encounter — the dungeon's darkest heart.</p>}
        {room.type === 'treasure' && <p className="mt-2 text-[10px] text-amber-300/60">✧ Dead-end reward — a chest awaits.</p>}
        {room.type === 'shrine' && <p className="mt-2 text-[10px] text-cyan-300/60">◈ Restorative shrine — crystal hums with power.</p>}
        <button
          onClick={onFocus}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-amber-800/40 bg-amber-950/30 py-1.5 text-xs text-amber-200 transition-colors hover:bg-amber-900/40 hover:text-amber-100"
        >
          <Crosshair className="h-3.5 w-3.5" /> Focus Camera
        </button>
      </div>
    </div>
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
      else if (k === 'theme' && ['crypt', 'cavern', 'catacomb', 'forge', 'ice', 'jungle'].includes(v)) p.theme = v as Theme;
      else if (k === 'events') p.eventDensity = Math.max(0, Math.min(1, parseFloat(v) || DEFAULT_PARAMS.eventDensity));
      else if (k === 'weather' && ['none', 'rain', 'snow', 'ash'].includes(v)) p.weather = v as WeatherType;
      else if (k === 'ml') p.multiLevel = v === '1';
      else if (k === 'lv') p.levelCount = Math.max(1, Math.min(5, parseInt(v, 10) || 1));
    }
  } catch { /* ignore */ }
  return p;
}

// ---- Preset type (saved seed configurations) ----
interface Preset {
  name: string;
  params: Params;
  at: number;
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
