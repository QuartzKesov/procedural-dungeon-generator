// scene.ts — Three.js presentation layer. Consumes a Dungeon (pure data) and
// owns all THREE objects: InstancedMesh per kind, baked per-instance AO,
// budgeted point lights, FogExp2, debug overlays, staged build animation.
// Pure presentation: no generation logic here.

import * as THREE from 'three';
import {
  Dungeon, Room, FLOOR, WALL, VOID, Prop, RoomType,
} from './types';
import { roomFloorCells } from './generator';

export interface OverlayToggles {
  delaunay: boolean;
  mst: boolean;
  loops: boolean;
  critical: boolean;
  difficulty: boolean;
  patrols: boolean;
}

export interface BuildOptions {
  animateBuild: boolean;
  /** 0..1 build progress (only used when animateBuild true). */
  buildProgress: number;
  overlays: OverlayToggles;
}

// ---- Theme palettes for presentation -------------------------------------
const THEME_FLOOR: Record<string, [number, number, number]> = {
  crypt:    [0.62, 0.58, 0.53],
  cavern:   [0.58, 0.46, 0.36],
  catacomb: [0.72, 0.66, 0.58],
  forge:    [0.56, 0.42, 0.34],
};
const THEME_WALL: Record<string, [number, number, number]> = {
  crypt:    [0.48, 0.45, 0.50],
  cavern:   [0.42, 0.32, 0.26],
  catacomb: [0.60, 0.54, 0.48],
  forge:    [0.40, 0.30, 0.26],
};

// deterministic per-cell value noise (0..1)
function valueNoise(x: number, y: number, seed: number): number {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---- Build per-cell room ownership + corridor flag from the data contract -
function buildOwnership(d: Dungeon): { owner: Int16Array; corridor: Uint8Array } {
  const owner = new Int16Array(d.W * d.H);
  const corridor = new Uint8Array(d.W * d.H);
  for (const c of d.corridorCells) corridor[c.y * d.W + c.x] = 1;
  for (const r of d.rooms) {
    for (const c of roomFloorCells(r)) {
      if (c.x < 0 || c.y < 0 || c.x >= d.W || c.y >= d.H) continue;
      const i = c.y * d.W + c.x;
      if (d.grid[i] === FLOOR) owner[i] = r.id + 1; // room wins over corridor
    }
  }
  return { owner, corridor };
}

// ---- Geometry factories (base at y=0) ------------------------------------
function floorGeo(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}
function wallGeo(height: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, height, 1);
  g.translate(0, height / 2, 0); // base at y=0
  return g;
}
function pillarGeo(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.22, 0.28, 1.6, 8);
  g.translate(0, 0.8, 0);
  return g;
}
function debrisGeo(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.3, 0);
  g.translate(0, 0.15, 0);
  return g;
}
function chestGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.7, 0.5, 0.5);
  g.translate(0, 0.25, 0);
  return g;
}
function spawnGeo(): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(0.35, 0.05, 6, 16);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0.05, 0);
  return g;
}
function crystalGeo(): THREE.BufferGeometry {
  return new THREE.OctahedronGeometry(0.5, 0);
}
function flameGeo(): THREE.BufferGeometry {
  return new THREE.OctahedronGeometry(0.16, 0);
}
function bracketGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.12, 0.12, 0.18);
  return g;
}
function brazierGeo(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.28, 0.2, 0.5, 8);
  g.translate(0, 0.25, 0);
  return g;
}
function portalGeo(): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(0.7, 0.08, 8, 24);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0.9, 0);
  return g;
}

// ---- The scene handle ----------------------------------------------------
export interface DungeonScene {
  group: THREE.Group;
  lights: THREE.PointLight[];
  /** Per-frame update: torch/portal flicker + flame scale jitter + particles. */
  update(elapsedSec: number, deltaSec: number): void;
  /** Rebuild overlays from current toggles. */
  setOverlays(toggles: OverlayToggles): void;
  /** Drive staged build animation (0..1). */
  setBuildProgress(p: number): void;
  dispose(): void;
}

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _col = new THREE.Color();

export function buildDungeonScene(d: Dungeon, opts: BuildOptions): DungeonScene {
  const group = new THREE.Group();
  group.name = 'DungeonScene';
  const { W, H, grid } = d;
  const theme = d.params.theme;
  const floorBase = THEME_FLOOR[theme] ?? THEME_FLOOR.crypt;
  const wallBase = THEME_WALL[theme] ?? THEME_WALL.crypt;

  // center the dungeon around origin in world space: grid (x,y) → world (x, 0, y)
  const cx = (W - 1) / 2;
  const cz = (H - 1) / 2;
  const worldX = (x: number) => x - cx;
  const worldZ = (y: number) => y - cz;

  const { owner, corridor } = buildOwnership(d);

  // ---- count instances per kind ----
  let floorCount = 0, wallCount = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === FLOOR) floorCount++;
    else if (grid[i] === WALL) wallCount++;
  }
  const pillars = d.props.filter((p) => p.kind === 'pillar');
  const torches = d.props.filter((p) => p.kind === 'torch');
  const braziers = d.props.filter((p) => p.kind === 'brazier');
  const debris = d.props.filter((p) => p.kind === 'debris');
  const chests = d.props.filter((p) => p.kind === 'chest');
  const crystals = d.props.filter((p) => p.kind === 'crystal');
  const portals = d.props.filter((p) => p.kind === 'portal');
  const litTorchPropIds: number[] = (d as any).litTorchPropIds ?? [];
  const litTorchSet = new Set(litTorchPropIds);
  const litTorchPropObjects = litTorchPropIds.map((pi) => d.props[pi]).filter(Boolean);

  // ---- materials ----
  const floorMat = new THREE.MeshLambertMaterial({ vertexColors: false });
  const wallMat = new THREE.MeshLambertMaterial({ vertexColors: false });
  const pillarMat = new THREE.MeshLambertMaterial({ color: 0x6b6258 });
  const debrisMat = new THREE.MeshLambertMaterial({ color: 0x4a4339 });
  const chestMat = new THREE.MeshLambertMaterial({ color: 0x8a5a2a, emissive: 0x1a0e02 });
  const brazierMat = new THREE.MeshLambertMaterial({ color: 0x3a2a22 });
  const bracketMat = new THREE.MeshLambertMaterial({ color: 0x2a2620 });
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb24a, transparent: true, opacity: 0.95 });
  const crystalMat = new THREE.MeshBasicMaterial({ color: 0x6ad0ff, transparent: true, opacity: 0.9 });
  const portalMat = new THREE.MeshBasicMaterial({ color: 0x8aa8ff, transparent: true, opacity: 0.85 });
  const spawnMats = [
    new THREE.MeshBasicMaterial({ color: 0x88ff88, transparent: true, opacity: 0.7 }), // tier 0
    new THREE.MeshBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.75 }), // tier 1
    new THREE.MeshBasicMaterial({ color: 0xff5544, transparent: true, opacity: 0.8 }),  // tier 2 elite
    new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.85 }), // tier 3 boss
  ];

  // ---- FLOOR instanced mesh (baked AO + tint) ----
  const floorMesh = new THREE.InstancedMesh(floorGeo(), floorMat, Math.max(1, floorCount));
  floorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // per-instance color
  const tmpFloorColor = new Float32Array(Math.max(1, floorCount) * 3);
  let fi = 0;
  const maxGridDepth = (d as any).maxGridDepth ?? 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (grid[i] !== FLOOR) continue;
      // 8-neighbor walls
      let adjWalls = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (grid[ny * W + nx] === WALL) adjWalls++;
        }
      const ao = 1 - 0.09 * Math.min(adjWalls, 4);
      const n = valueNoise(x, y, d.params.seed); // 0..1
      const valueJitter = 0.95 + n * 0.1; // ±5%
      let r = floorBase[0], g = floorBase[1], b = floorBase[2];
      const isCorr = corridor[i] === 1 && owner[i] === 0;
      if (!isCorr) {
        const rid = owner[i] - 1;
        if (rid >= 0) {
          // blend 18% toward room tint
          const t = d.rooms[rid].tint;
          r = r * 0.82 + t[0] * 0.18;
          g = g * 0.82 + t[1] * 0.18;
          b = b * 0.82 + t[2] * 0.18;
        }
      } else {
        // corridors darker and untinted
        r *= 0.7; g *= 0.7; b *= 0.7;
      }
      r = Math.max(0, Math.min(1, r * ao * valueJitter));
      g = Math.max(0, Math.min(1, g * ao * valueJitter));
      b = Math.max(0, Math.min(1, b * ao * valueJitter));
      tmpFloorColor[fi * 3] = r;
      tmpFloorColor[fi * 3 + 1] = g;
      tmpFloorColor[fi * 3 + 2] = b;
      _v.set(worldX(x), 0, worldZ(y));
      _q.identity();
      _s.set(1, 1, 1);
      _m.compose(_v, _q, _s);
      floorMesh.setMatrixAt(fi, _m);
      _col.setRGB(r, g, b);
      floorMesh.setColorAt(fi, _col);
      fi++;
    }
  }
  floorMesh.count = fi;
  floorMesh.instanceMatrix.needsUpdate = true;
  if (floorMesh.instanceColor) floorMesh.instanceColor.needsUpdate = true;
  floorMesh.frustumCulled = false;
  group.add(floorMesh);

  // ---- WALL instanced mesh (height jitter) ----
  const wallMesh = new THREE.InstancedMesh(wallGeo(2.2), wallMat, Math.max(1, wallCount));
  wallMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  let wi = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (grid[i] !== WALL) continue;
      // seeded height jitter 2.2 ± 0.3
      const n = valueNoise(x, y, d.params.seed ^ 0xa5a5);
      const h = 2.2 + (n - 0.5) * 0.6;
      _v.set(worldX(x), 0, worldZ(y));
      _q.identity();
      _s.set(1, h, 1);
      _m.compose(_v, _q, _s);
      wallMesh.setMatrixAt(wi, _m);
      // brighter wall color with variation
      const vj = 0.85 + n * 0.3;
      _col.setRGB(Math.min(1, wallBase[0] * vj), Math.min(1, wallBase[1] * vj), Math.min(1, wallBase[2] * vj));
      wallMesh.setColorAt(wi, _col);
      wi++;
    }
  }
  wallMesh.count = wi;
  wallMesh.instanceMatrix.needsUpdate = true;
  if (wallMesh.instanceColor) wallMesh.instanceColor.needsUpdate = true;
  wallMesh.frustumCulled = false;
  group.add(wallMesh);

  // ---- generic instanced-mesh builder for props ----
  function buildPropInstanced(
    list: Prop[], geo: THREE.BufferGeometry, mat: THREE.Material,
    perInstance: (p: Prop, idx: number) => { pos: THREE.Vector3; scale: THREE.Vector3; rotY: number; color?: THREE.Color },
  ): THREE.InstancedMesh | null {
    if (list.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      const info = perInstance(p, k);
      _v.copy(info.pos);
      _q.setFromAxisAngle(UP, info.rotY);
      _s.copy(info.scale);
      _m.compose(_v, _q, _s);
      mesh.setMatrixAt(k, _m);
      if (info.color) mesh.setColorAt(k, info.color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  // pillars
  const pillarMesh = buildPropInstanced(pillars, pillarGeo(), pillarMat, (p) => ({
    pos: new THREE.Vector3(worldX(p.x), 0, worldZ(p.y)),
    scale: new THREE.Vector3(1, 1, 1),
    rotY: 0,
  }));
  if (pillarMesh) group.add(pillarMesh);

  // debris
  const debrisMesh = buildPropInstanced(debris, debrisGeo(), debrisMat, (p) => ({
    pos: new THREE.Vector3(worldX(p.x), 0, worldZ(p.y)),
    scale: new THREE.Vector3(p.scale, p.scale * 0.6, p.scale),
    rotY: p.rot,
  }));
  if (debrisMesh) group.add(debrisMesh);

  // chests
  const chestMesh = buildPropInstanced(chests, chestGeo(), chestMat, (p) => ({
    pos: new THREE.Vector3(worldX(p.x), 0, worldZ(p.y)),
    scale: new THREE.Vector3(1, 1, 1),
    rotY: p.rot,
  }));
  if (chestMesh) group.add(chestMesh);

  // braziers
  const brazierMesh = buildPropInstanced(braziers, brazierGeo(), brazierMat, (p) => ({
    pos: new THREE.Vector3(worldX(p.x), 0, worldZ(p.y)),
    scale: new THREE.Vector3(1, 1, 1),
    rotY: 0,
    color: new THREE.Color(0x3a2a22),
  }));
  if (brazierMesh) group.add(brazierMesh);

  // torch brackets + flames
  const bracketMesh = buildPropInstanced(torches, bracketGeo(), bracketMat, (p) => {
    // bracket sits on the wall cell, offset toward the floor it faces
    const ox = Math.sin(p.rot), oz = -Math.cos(p.rot);
    return {
      pos: new THREE.Vector3(worldX(p.x) + ox * 0.45, 1.2, worldZ(p.y) + oz * 0.45),
      scale: new THREE.Vector3(1, 1, 1),
      rotY: p.rot,
    };
  });
  if (bracketMesh) group.add(bracketMesh);

  const flameMesh = buildPropInstanced(torches.concat(braziers), flameGeo(), flameMat, (p) => {
    const ox = p.kind === 'torch' ? Math.sin(p.rot) : 0;
    const oz = p.kind === 'torch' ? -Math.cos(p.rot) : 0;
    const yy = p.kind === 'torch' ? 1.35 : 0.6;
    return {
      pos: new THREE.Vector3(worldX(p.x) + ox * 0.45, yy, worldZ(p.y) + oz * 0.45),
      scale: new THREE.Vector3(p.kind === 'brazier' ? 1.8 : 1, p.kind === 'brazier' ? 2.2 : 1, p.kind === 'brazier' ? 1.8 : 1),
      rotY: 0,
      color: new THREE.Color(p.kind === 'brazier' ? 0xff9a3a : 0xffb24a),
    };
  });
  if (flameMesh) group.add(flameMesh);

  // crystals (shrine)
  const crystalMesh = buildPropInstanced(crystals, crystalGeo(), crystalMat, (p) => ({
    pos: new THREE.Vector3(worldX(p.x), 1.0, worldZ(p.y)),
    scale: new THREE.Vector3(1, 1.4, 1),
    rotY: p.rot,
  }));
  if (crystalMesh) group.add(crystalMesh);

  // portal (entrance)
  const portalMesh = buildPropInstanced(portals, portalGeo(), portalMat, (p) => ({
    pos: new THREE.Vector3(worldX(p.x), 0, worldZ(p.y)),
    scale: new THREE.Vector3(1, 1, 1),
    rotY: 0,
  }));
  if (portalMesh) group.add(portalMesh);

  // spawn markers (grouped by tier)
  const spawnGroups: THREE.InstancedMesh[] = [];
  for (let tier = 0; tier < 4; tier++) {
    const tierSpawns = d.spawns.filter((s) => s.tier === tier);
    if (tierSpawns.length === 0) continue;
    const mesh = buildPropInstanced(
      tierSpawns.map((s, i) => ({ ...s, kind: 'portal' as const, rot: 0, scale: 1, roomId: s.roomId, flickerPhase: i } as unknown as Prop)),
      spawnGeo(), spawnMats[tier],
      (p) => ({
        pos: new THREE.Vector3(worldX((p as any).x), 0, worldZ((p as any).y)),
        scale: new THREE.Vector3(tier === 3 ? 2.2 : tier === 2 ? 1.5 : 1, 1, tier === 3 ? 2.2 : tier === 2 ? 1.5 : 1),
        rotY: 0,
      }),
    );
    if (mesh) { spawnGroups.push(mesh); group.add(mesh); }
  }

  // ---- LIGHTING ----
  const lights: THREE.PointLight[] = [];
  const flickerLights: { light: THREE.PointLight; base: number; phase: number; kind: 'torch' | 'brazier' | 'portal' | 'boss' | 'shrine' }[] = [];

  // hemisphere (cool sky, warm ground bounce) + directional for form
  const hemi = new THREE.HemisphereLight(0x7080a0, 0x4a3624, 1.3);
  group.add(hemi);
  const dir = new THREE.DirectionalLight(0xc4cce0, 0.75);
  dir.position.set(0.5, 1, 0.3);
  group.add(dir);

  // lit torches (warm point lights, distance ~12, decay 2)
  for (const t of litTorchPropObjects) {
    const ox = Math.sin(t.rot), oz = -Math.cos(t.rot);
    const light = new THREE.PointLight(0xff8c3a, 5.0, 13, 2.0);
    light.position.set(worldX(t.x) + ox * 0.45, 1.35, worldZ(t.y) + oz * 0.45);
    group.add(light);
    lights.push(light);
    flickerLights.push({ light, base: 5.0, phase: t.flickerPhase, kind: 'torch' });
  }

  // key lights: entrance portal (cool blue), shrine crystal (cyan), boss (red ember)
  const ent = d.rooms[d.entranceId];
  const portalLight = new THREE.PointLight(0x6a8cff, 3.2, 10, 2.0);
  portalLight.position.set(worldX(ent.cx), 1.2, worldZ(ent.cy));
  group.add(portalLight); lights.push(portalLight);
  flickerLights.push({ light: portalLight, base: 3.2, phase: 0, kind: 'portal' });

  const shrineRooms = d.rooms.filter((r) => r.type === 'shrine');
  for (const sr of shrineRooms) {
    const sl = new THREE.PointLight(0x40d0ff, 2.8, 9, 2.0);
    sl.position.set(worldX(sr.cx), 1.2, worldZ(sr.cy));
    group.add(sl); lights.push(sl);
    flickerLights.push({ light: sl, base: 2.8, phase: 1.7, kind: 'shrine' });
  }

  const boss = d.rooms[d.bossId];
  const bossLight = new THREE.PointLight(0xff3a2a, 6.0, 16, 2.0);
  bossLight.position.set(worldX(boss.cx), 1.8, worldZ(boss.cy));
  group.add(bossLight); lights.push(bossLight);
  flickerLights.push({ light: bossLight, base: 6.0, phase: 0.6, kind: 'boss' });

  // ---- ROOM GLOW PLANES (key rooms get a soft ground glow) ----
  // A flat, additive, unlit disc just above the floor that tints the area
  // around entrance/boss/shrine/treasure rooms. Cheap (1 quad each) and
  // reads as "this room matters" even when torches are off.
  const glowGeo = new THREE.CircleGeometry(1, 24);
  glowGeo.rotateX(-Math.PI / 2);
  const makeGlow = (room: Room, color: number, radius: number) => {
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.28,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(glowGeo, mat);
    mesh.position.set(worldX(room.cx), 0.04, worldZ(room.cy));
    mesh.scale.setScalar(radius);
    group.add(mesh);
    return mesh;
  };
  const glowMeshes: THREE.Mesh[] = [];
  glowMeshes.push(makeGlow(d.rooms[d.entranceId], 0x4060ff, Math.max(d.rooms[d.entranceId].w, d.rooms[d.entranceId].h) * 1.6));
  glowMeshes.push(makeGlow(boss, 0xff2a1a, Math.max(boss.w, boss.h) * 1.8));
  for (const r of d.rooms) {
    if (r.type === 'shrine') glowMeshes.push(makeGlow(r, 0x30c8ff, Math.max(r.w, r.h) * 1.4));
    else if (r.type === 'treasure') glowMeshes.push(makeGlow(r, 0xffc830, Math.max(r.w, r.h) * 1.3));
    else if (r.type === 'elite') glowMeshes.push(makeGlow(r, 0xff6020, Math.max(r.w, r.h) * 1.3));
  }

  // ---- PARTICLE EMBERS (rising sparks from lit torches + braziers) ----
  // One THREE.Points cloud shared across all emitters. Each particle has a
  // source position, upward velocity, lifetime, and fade. CPU-driven but
  // bounded (≤ 8 particles per emitter × #emitters).
  const emberSources: Array<{ x: number; y: number; z: number; rate: number; color: THREE.Color }> = [];
  for (const t of litTorchPropObjects) {
    const ox = Math.sin(t.rot), oz = -Math.cos(t.rot);
    emberSources.push({
      x: worldX(t.x) + ox * 0.45, y: 1.35, z: worldZ(t.y) + oz * 0.45,
      rate: 5, color: new THREE.Color(0xff9a3a),
    });
  }
  for (const b of braziers) {
    emberSources.push({
      x: worldX(b.x), y: 0.7, z: worldZ(b.y),
      rate: 8, color: new THREE.Color(0xff7a2a),
    });
  }
  // boss arena gets ambient embers too (smoldering atmosphere)
  emberSources.push({
    x: worldX(boss.cx), y: 0.5, z: worldZ(boss.cy),
    rate: 6, color: new THREE.Color(0xff4a2a),
  });
  const MAX_EMBERS = Math.min(600, emberSources.reduce((n, s) => n + s.rate * 10, 0));
  const emberPositions = new Float32Array(MAX_EMBERS * 3);
  const emberColors = new Float32Array(MAX_EMBERS * 3);
  const emberState: Array<{ life: number; maxLife: number; vx: number; vy: number; vz: number; src: number }> = [];
  for (let i = 0; i < MAX_EMBERS; i++) {
    emberPositions[i * 3] = 9999; // off-screen until spawned
    emberState.push({ life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0, src: 0 });
  }
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(emberPositions, 3));
  emberGeo.setAttribute('color', new THREE.BufferAttribute(emberColors, 3));
  // Soft round ember sprite via a canvas texture (radial gradient).
  const emberCanvas = document.createElement('canvas');
  emberCanvas.width = 32; emberCanvas.height = 32;
  const ectx = emberCanvas.getContext('2d')!;
  const grad = ectx.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,200,120,0.8)');
  grad.addColorStop(1, 'rgba(255,120,40,0)');
  ectx.fillStyle = grad;
  ectx.fillRect(0, 0, 32, 32);
  const emberTex = new THREE.CanvasTexture(emberCanvas);
  const emberMat = new THREE.PointsMaterial({
    size: 0.7, map: emberTex, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 1.0,
    sizeAttenuation: true,
  });
  const emberPoints = new THREE.Points(emberGeo, emberMat);
  emberPoints.frustumCulled = false;
  group.add(emberPoints);
  let emberWriteIdx = 0;
  const spawnEmber = (srcIdx: number) => {
    const s = emberSources[srcIdx];
    const st = emberState[emberWriteIdx];
    st.life = 0;
    st.maxLife = 1.2 + Math.random() * 1.8;
    st.vx = (Math.random() - 0.5) * 0.5;
    st.vy = 0.7 + Math.random() * 0.9;
    st.vz = (Math.random() - 0.5) * 0.5;
    st.src = srcIdx;
    emberPositions[emberWriteIdx * 3] = s.x + (Math.random() - 0.5) * 0.25;
    emberPositions[emberWriteIdx * 3 + 1] = s.y;
    emberPositions[emberWriteIdx * 3 + 2] = s.z + (Math.random() - 0.5) * 0.25;
    // bright at birth, fades via life in update()
    emberColors[emberWriteIdx * 3] = s.color.r;
    emberColors[emberWriteIdx * 3 + 1] = s.color.g;
    emberColors[emberWriteIdx * 3 + 2] = s.color.b;
    emberWriteIdx = (emberWriteIdx + 1) % MAX_EMBERS;
  };
  let emberAccum = 0;

  // ---- DEBUG OVERLAYS ----
  const overlayGroup = new THREE.Group();
  overlayGroup.name = 'Overlays';
  group.add(overlayGroup);
  let currentOverlays: OverlayToggles = { ...opts.overlays };

  function buildOverlays(toggles: OverlayToggles) {
    // dispose existing
    while (overlayGroup.children.length) {
      const c = overlayGroup.children.pop()!;
      (c as THREE.LineSegments).geometry?.dispose?.();
      const m = (c as THREE.LineSegments).material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose()); else (m as THREE.Material)?.dispose?.();
    }
    // Graph edges live in grid space; convert to world line segments slightly above floor.
    const centers = d.rooms.map((r) => new THREE.Vector3(worldX(r.cx), 0.06, worldZ(r.cy)));
    const makeLine = (pts: number[], color: number, opacity: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
      const ls = new THREE.LineSegments(g, m);
      overlayGroup.add(ls);
    };
    if (toggles.critical) {
      const pts: number[] = [];
      for (const e of d.edges) if (e.isCritical) { pts.push(...centers[e.a].toArray(), ...centers[e.b].toArray()); }
      makeLine(pts, 0xff3030, 0.95);
    }
    if (toggles.loops) {
      const pts: number[] = [];
      for (const e of d.edges) if (e.isLoop) { pts.push(...centers[e.a].toArray(), ...centers[e.b].toArray()); }
      makeLine(pts, 0x33e0ff, 0.85);
    }
    if (toggles.mst) {
      const pts: number[] = [];
      for (const e of d.edges) if (!e.isLoop) { pts.push(...centers[e.a].toArray(), ...centers[e.b].toArray()); }
      makeLine(pts, 0xffffff, 0.55);
    }
    if (toggles.delaunay) {
      // Rebuild Delaunay would require the geometry import; instead show all
      // edges faintly as a proxy by drawing room-center proximity graph.
      const pts: number[] = [];
      for (let a = 0; a < d.rooms.length; a++)
        for (let b = a + 1; b < d.rooms.length; b++) {
          const dx = d.rooms[a].cx - d.rooms[b].cx, dy = d.rooms[a].cy - d.rooms[b].cy;
          if (Math.sqrt(dx * dx + dy * dy) < 22) pts.push(...centers[a].toArray(), ...centers[b].toArray());
        }
      makeLine(pts, 0x88aaff, 0.18);
    }
    if (toggles.difficulty) {
      // recolor floor by difficulty: tint each floor instance toward red by difficulty.
      let k = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (grid[i] !== FLOOR) continue;
          const rid = owner[i] - 1;
          const diff = rid >= 0 ? d.rooms[rid].difficulty : 0.3;
          // heatmap: low=green, mid=yellow, high=red
          const r = diff < 0.5 ? diff * 2 : 1;
          const g = diff < 0.5 ? 1 : 1 - (diff - 0.5) * 2;
          _col.setRGB(r, g, 0.15);
          floorMesh.setColorAt(k, _col);
          k++;
        }
      }
      if (floorMesh.instanceColor) floorMesh.instanceColor.needsUpdate = true;
    } else {
      // restore baked floor colors
      let k = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (grid[y * W + x] !== FLOOR) continue;
          _col.setRGB(tmpFloorColor[k * 3], tmpFloorColor[k * 3 + 1], tmpFloorColor[k * 3 + 2]);
          floorMesh.setColorAt(k, _col);
          k++;
        }
      }
      if (floorMesh.instanceColor) floorMesh.instanceColor.needsUpdate = true;
    }
    if (toggles.patrols) {
      // Enemy patrol preview: for each spawn, draw a small loop route visiting
      // 2-3 nearby floor cells in the same room. Reads as "where enemies roam".
      // Uses a deterministic per-spawn RNG so routes are stable across toggles.
      const pts: number[] = [];
      for (let si = 0; si < d.spawns.length; si++) {
        const sp = d.spawns[si];
        const room = d.rooms[sp.roomId];
        if (!room) continue;
        // gather room floor cells (precomputed owner grid)
        const cells: Array<{ x: number; y: number }> = [];
        for (let y = Math.max(0, room.cy - room.h); y <= Math.min(H - 1, room.cy + room.h); y++) {
          for (let x = Math.max(0, room.cx - room.w); x <= Math.min(W - 1, room.cx + room.w); x++) {
            if (grid[y * W + x] === FLOOR && owner[y * W + x] - 1 === room.id) cells.push({ x, y });
          }
        }
        if (cells.length < 3) continue;
        // deterministic pick of 3 waypoints (spawn cell + 2 others)
        const h = (sp.x * 73856093) ^ (sp.y * 19349663) ^ (sp.tier * 83492791);
        const wp1 = cells[(h >>> 0) % cells.length];
        const wp2 = cells[((h >>> 8) ^ 0x55) % cells.length];
        // draw triangle: spawn → wp1 → wp2 → spawn
        const a = new THREE.Vector3(worldX(sp.x), 0.08, worldZ(sp.y));
        const b = new THREE.Vector3(worldX(wp1.x), 0.08, worldZ(wp1.y));
        const c = new THREE.Vector3(worldX(wp2.x), 0.08, worldZ(wp2.y));
        pts.push(...a.toArray(), ...b.toArray());
        pts.push(...b.toArray(), ...c.toArray());
        pts.push(...c.toArray(), ...a.toArray());
      }
      // bright yellow patrol routes, fully opaque for visibility
      makeLine(pts, 0xffdd33, 0.85);
      // also place small glowing waypoint markers (spheres) at each spawn
      const markerPts: number[] = [];
      for (let si = 0; si < d.spawns.length; si++) {
        const sp = d.spawns[si];
        markerPts.push(worldX(sp.x), 0.1, worldZ(sp.y));
      }
      if (markerPts.length > 0) {
        const mg = new THREE.BufferGeometry();
        mg.setAttribute('position', new THREE.Float32BufferAttribute(markerPts, 3));
        const mm = new THREE.PointsMaterial({
          color: 0xffdd33, size: 0.5, transparent: true, opacity: 0.9,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        overlayGroup.add(new THREE.Points(mg, mm));
      }
    }
  }
  buildOverlays(currentOverlays);

  // ---- STAGED BUILD ANIMATION ----
  // progress 0..1 maps to phases:
  //   0.00-0.18  scatter/separate (room markers only) 
  //   0.18-0.32  graph (overlays only) 
  //   0.32-0.62  floors flood by BFS distance 
  //   0.62-0.82  walls rise 
  //   0.82-1.00  props pop + lights ramp 
  let buildProgress = opts.animateBuild ? opts.buildProgress : 1;

  // store per-instance base data for animation
  // floor: base Y=0, we animate visibility by scaling Y to 0 when unrevealed.
  // We precompute the BFS distance per floor instance index.
  const floorBfs: Float32Array = new Float32Array(floorCount);
  {
    let k = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (grid[y * W + x] !== FLOOR) continue;
        floorBfs[k] = d.bfs[y * W + x];
        k++;
      }
  }
  const wallBaseHeight: Float32Array = new Float32Array(wallCount);
  {
    let k = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (grid[y * W + x] !== WALL) continue;
        const n = valueNoise(x, y, d.params.seed ^ 0xa5a5);
        wallBaseHeight[k] = 2.2 + (n - 0.5) * 0.6;
        k++;
      }
  }
  // store prop base scales for pop animation
  const propMeshes: THREE.InstancedMesh[] = [pillarMesh, debrisMesh, chestMesh, brazierMesh, bracketMesh, flameMesh, crystalMesh, portalMesh, ...spawnGroups].filter(Boolean) as THREE.InstancedMesh[];

  // store glow base opacity for build-animation ramp
  const glowBaseOpacity = glowMeshes.map((m) => (m.material as THREE.MeshBasicMaterial).opacity);

  function applyBuildProgress(p: number) {
    buildProgress = p;
    // floors flood: reveal cells with bfs <= floodThreshold
    const floodT = p < 0.32 ? 0 : p < 0.62 ? ((p - 0.32) / 0.30) : 1;
    const floodMax = floodT * maxGridDepth;
    let k = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (grid[y * W + x] !== FLOOR) continue;
        const revealed = floodT <= 0 ? false : floorBfs[k] >= 0 && floorBfs[k] <= floodMax;
        _v.set(worldX(x), 0, worldZ(y));
        _q.identity();
        _s.set(1, revealed ? 1 : 0.001, 1);
        _m.compose(_v, _q, _s);
        floorMesh.setMatrixAt(k, _m);
        k++;
      }
    }
    floorMesh.instanceMatrix.needsUpdate = true;

    // walls rise: scale.y from 0 to base height
    const wallT = p < 0.62 ? 0 : p < 0.82 ? ((p - 0.62) / 0.20) : 1;
    let j = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (grid[y * W + x] !== WALL) continue;
        const h = wallBaseHeight[j] * wallT;
        _v.set(worldX(x), 0, worldZ(y));
        _q.identity();
        _s.set(1, Math.max(0.001, h), 1);
        _m.compose(_v, _q, _s);
        wallMesh.setMatrixAt(j, _m);
        j++;
      }
    }
    wallMesh.instanceMatrix.needsUpdate = true;

    // props pop
    const propT = p < 0.82 ? 0 : p < 1.0 ? ((p - 0.82) / 0.18) : 1;
    for (const mesh of propMeshes) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, _m);
        _m.decompose(_v, _q, _s);
        const sc = Math.max(0.001, propT);
        // keep relative scale ratios: scale all axes by propT
        _s.multiplyScalar(propT === 0 ? 0 : (sc / Math.max(_s.x, 0.001)));
        _s.set(Math.max(0.001, _s.x * propT), Math.max(0.001, _s.y * propT), Math.max(0.001, _s.z * propT));
        _m.compose(_v, _q, _s);
        mesh.setMatrixAt(i, _m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    // lights ramp
    const lightT = p < 0.82 ? 0.15 : p < 1.0 ? 0.15 + 0.85 * ((p - 0.82) / 0.18) : 1;
    for (const fl of flickerLights) fl.light.intensity = fl.base * lightT;
    // glow ramp (follows lights)
    for (let gi = 0; gi < glowMeshes.length; gi++) {
      (glowMeshes[gi].material as THREE.MeshBasicMaterial).opacity = glowBaseOpacity[gi] * lightT;
    }
  }
  applyBuildProgress(buildProgress);

  // ---- update (flicker + particles + glow pulse) ----
  function update(elapsedSec: number, deltaSec: number) {
    const dt = Math.min(deltaSec, 0.05); // clamp to avoid spikes after tab switch
    const ramp = buildProgress < 0.82 ? 0.15 : buildProgress >= 1 ? 1 : 0.15 + 0.85 * ((buildProgress - 0.82) / 0.18);
    for (const fl of flickerLights) {
      const t = elapsedSec * 12 + fl.phase;
      const flicker =
        0.78 +
        0.14 * Math.sin(t) +
        0.08 * Math.sin(t * 2.7 + 1.3) +
        0.05 * Math.sin(t * 5.1 + 0.6);
      fl.light.intensity = fl.base * flicker * ramp;
    }
    // flame scale jitter
    if (flameMesh) {
      const list = torches.concat(braziers);
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        flameMesh.getMatrixAt(i, _m);
        _m.decompose(_v, _q, _s);
        const t = elapsedSec * 10 + p.flickerPhase;
        const jx = 1 + 0.18 * Math.sin(t);
        const jy = 1 + 0.25 * Math.sin(t * 1.3 + 0.7);
        const baseSx = p.kind === 'brazier' ? 1.8 : 1;
        const baseSy = p.kind === 'brazier' ? 2.2 : 1;
        const baseSz = p.kind === 'brazier' ? 1.8 : 1;
        _s.set(baseSx * jx, baseSy * jy, baseSz * jx);
        _m.compose(_v, _q, _s);
        flameMesh.setMatrixAt(i, _m);
      }
      flameMesh.instanceMatrix.needsUpdate = true;
    }
    // crystal + portal gentle pulse
    if (crystalMesh) {
      crystalMesh.rotation.y = elapsedSec * 0.6;
      crystalMesh.position.y = 1.0 + Math.sin(elapsedSec * 1.8) * 0.08;
    }
    if (portalMesh) {
      portalMesh.rotation.z = elapsedSec * 0.4;
      portalMesh.scale.y = 1 + 0.06 * Math.sin(elapsedSec * 2.2);
    }
    // glow pulse (slow breath on key-room glows)
    for (let gi = 0; gi < glowMeshes.length; gi++) {
      const base = glowBaseOpacity[gi];
      const pulse = 1 + 0.18 * Math.sin(elapsedSec * 1.5 + gi * 0.7);
      (glowMeshes[gi].material as THREE.MeshBasicMaterial).opacity = base * pulse * ramp;
    }
    // ---- ember particle simulation ----
    if (emberSources.length > 0 && ramp > 0.2) {
      // spawn
      emberAccum += dt;
      const spawnInterval = 1 / 45; // ~45 spawns/sec distributed across sources
      while (emberAccum > spawnInterval) {
        emberAccum -= spawnInterval;
        // weighted pick of source by rate
        let total = 0;
        for (const s of emberSources) total += s.rate;
        let r = Math.random() * total;
        let si = 0;
        for (let k = 0; k < emberSources.length; k++) { r -= emberSources[k].rate; if (r <= 0) { si = k; break; } }
        spawnEmber(si);
      }
      // update existing
      for (let i = 0; i < MAX_EMBERS; i++) {
        const st = emberState[i];
        if (st.maxLife <= 0) continue;
        st.life += dt;
        if (st.life >= st.maxLife) {
          // retire
          emberPositions[i * 3] = 9999;
          st.maxLife = 0;
          continue;
        }
        // drift up + slight horizontal sway + decelerate
        const sway = Math.sin(elapsedSec * 3 + i) * 0.15 * dt;
        emberPositions[i * 3] += (st.vx + sway) * dt;
        emberPositions[i * 3 + 1] += st.vy * dt;
        emberPositions[i * 3 + 2] += st.vz * dt;
        st.vy *= (1 - 0.4 * dt); // slow down
        // fade color toward dark as it dies
        const f = 1 - st.life / st.maxLife;
        const s = emberSources[st.src];
        emberColors[i * 3] = s.color.r * f;
        emberColors[i * 3 + 1] = s.color.g * f * 0.8;
        emberColors[i * 3 + 2] = s.color.b * f * 0.5;
      }
      emberGeo.attributes.position.needsUpdate = true;
      emberGeo.attributes.color.needsUpdate = true;
    }
  }

  function setOverlays(toggles: OverlayToggles) {
    currentOverlays = { ...toggles };
    buildOverlays(currentOverlays);
  }
  function setBuildProgress(p: number) { applyBuildProgress(Math.max(0, Math.min(1, p))); }

  function dispose() {
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else if (m) m.dispose();
    });
  }

  return {
    group,
    lights,
    update,
    setOverlays,
    setBuildProgress,
    dispose,
  };
}

// ---- Camera helper: isometric orthographic -------------------------------
export function makeIsoCamera(d: Dungeon, aspect: number): THREE.OrthographicCamera {
  // yaw 45°, pitch ~37°
  const pitch = THREE.MathUtils.degToRad(37);
  const yaw = THREE.MathUtils.degToRad(45);
  const dir = new THREE.Vector3(
    Math.cos(pitch) * Math.cos(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.sin(yaw),
  );
  // fit the dungeon: the isometric projection of a W×H grid spans roughly
  // (W+H)/√2 horizontally and (W+H)/√2·sin(pitch) vertically. Use a half-
  // frustum that comfortably contains the diagonal.
  const W = d.W, H = d.H;
  const half = (W + H) * 0.42;
  const cam = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.1, 4000);
  const center = new THREE.Vector3(0, 0, 0);
  // For ortho the distance only affects fog + clipping; keep it modest so fog
  // isn't overly aggressive.
  const dist = Math.max(W, H) * 0.9 + 30;
  cam.position.copy(center).addScaledVector(dir, dist);
  cam.lookAt(center);
  cam.up.set(0, 1, 0);
  return cam;
}

/** Fog density tuned to dungeon scale: far edge ~32% fogged. */
export function fogDensityFor(d: Dungeon): number {
  return Math.max(0.0010, Math.min(0.014, 0.40 / Math.max(d.W, d.H)));
}
