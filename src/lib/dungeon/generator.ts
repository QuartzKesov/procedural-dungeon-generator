// generator.ts — Procedural dungeon generator. Pure data: NO THREE imports.
// Pipeline: RNG → scatter → separate → graph → semantics → carve → rasterize
//           → decorate → metadata. Deterministic for a given integer seed.

import { makeRng, hashString, type RNG } from './rng';
import {
  DEFAULT_PARAMS, Params, Dungeon, Room, Edge, Cell, Prop, Spawn, Stats,
  RoomShape, RoomType, PropKind, Theme,
  VOID, FLOOR, WALL, idx, inBounds,
} from './types';
import {
  delaunayEdges, primMstWeighted, bfs as graphBfs, gridFloodCount, Pt,
} from './geometry';
import { generateDungeonName } from './names';

// ---- Tunables derived from params ----------------------------------------
const PADDING = 2;            // separation cell padding
const MAX_SEP_ITERS = 120;    // separation iteration cap (rooms may slightly overlap — carving handles it)
const MAX_REROLL = 5;
const LIGHT_BUDGET = 12;

// ---- Archetype + shape tables --------------------------------------------
interface Archetype { rx: number; ry: number; large: boolean; }
function pickArchetype(rng: RNG): Archetype {
  // small 5–7 (45%), medium 8–12 (40%), large 13–18 (15%) — values = diameter.
  const roll = rng.float();
  let diam: number;
  let large = false;
  if (roll < 0.45) diam = rng.int(5, 7);
  else if (roll < 0.85) diam = rng.int(8, 12);
  else { diam = rng.int(13, 18); large = true; }
  // jitter the two axes independently for irregular silhouettes
  const rx = Math.max(2, Math.round(diam / 2 + rng.range(-0.6, 0.6)));
  const ry = Math.max(2, Math.round(diam / 2 + rng.range(-0.6, 0.6)));
  return { rx, ry, large };
}
function pickShape(rng: RNG): RoomShape {
  // rectangle 48%, ellipse 18%, octagon 14%, lshape 12%, cross 8%
  const r = rng.float();
  if (r < 0.48) return 'rectangle';
  if (r < 0.66) return 'ellipse';
  if (r < 0.80) return 'octagon';
  if (r < 0.92) return 'lshape';
  return 'cross';
}

// ---- Theme palettes (linear RGB 0..1) ------------------------------------
const THEME_TINT: Record<Theme, [number, number, number]> = {
  crypt:    [0.46, 0.50, 0.58],
  cavern:   [0.52, 0.40, 0.30],
  catacomb: [0.62, 0.57, 0.50],
  forge:    [0.58, 0.34, 0.24],
};

// ---- Stage: room scatter -------------------------------------------------
interface RawRoom { cx: number; cy: number; rx: number; ry: number; shape: RoomShape; large: boolean; }
function scatterRooms(rng: RNG, roomCount: number): RawRoom[] {
  const candidates = Math.max(roomCount, Math.round(roomCount * 1.4));
  // radius ∝ √roomCount keeps density constant; the constant is tuned so the
  // average room has room to breathe — this lets separation converge quickly
  // and keeps the final grid compact (biggest perf lever for 60-room budgets).
  const radius = 5.6 * Math.sqrt(Math.max(roomCount, 1));
  const out: RawRoom[] = [];
  for (let i = 0; i < candidates; i++) {
    // uniform point in a disk
    const u = Math.max(rng.float(), 1e-4);
    const r = radius * Math.sqrt(u);
    const theta = rng.range(0, Math.PI * 2);
    const cx = r * Math.cos(theta);
    const cy = r * Math.sin(theta);
    const arch = pickArchetype(rng);
    const shape = pickShape(rng);
    out.push({ cx, cy, rx: arch.rx, ry: arch.ry, shape, large: arch.large });
  }
  // Force ≥ 2 large rooms.
  let largeCount = out.reduce((n, rm) => n + (rm.large ? 1 : 0), 0);
  for (let i = 0; i < out.length && largeCount < 2; i++) {
    if (!out[i].large) {
      out[i].large = true;
      out[i].rx = Math.max(out[i].rx, 7);
      out[i].ry = Math.max(out[i].ry, 7);
      largeCount++;
    }
  }
  return out;
}

// ---- Stage: separation (AABB push-apart) ---------------------------------
// Pushes overlapping pairs apart along their center-to-center vector by half
// the minimum penetration. This is convergent (never pushes a pair back
// together) unlike axis-of-min-penetration which oscillates when px≈py.
function separateRooms(rng: RNG, rooms: RawRoom[]): RawRoom[] {
  for (let iter = 0; iter < MAX_SEP_ITERS; iter++) {
    let totalMove = 0;
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i], b = rooms[j];
        const dx = a.cx - b.cx;
        const dy = a.cy - b.cy;
        const adx = Math.abs(dx);
        const ady = Math.abs(dy);
        // inflated half-extents
        const ox = a.rx + b.rx + PADDING;
        const oy = a.ry + b.ry + PADDING;
        const px = ox - adx; // penetration on x
        const py = oy - ady;
        if (px > 0 && py > 0) {
          // overlap = min penetration; push along center vector (stable)
          const overlap = px < py ? px : py;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;
          const push = overlap * 0.5;
          const nx = dx / dist, ny = dy / dist;
          a.cx += nx * push; a.cy += ny * push;
          b.cx -= nx * push; b.cy -= ny * push;
          totalMove += overlap;
        }
      }
    }
    if (totalMove < 0.01) break; // converged
  }
  // Snap centers to the integer grid.
  for (const rm of rooms) {
    rm.cx = Math.round(rm.cx);
    rm.cy = Math.round(rm.cy);
  }
  return rooms;
}

// ---- Stage: cull overflow down to roomCount (keep largest, keep ≥2 large) -
function cullRooms(rooms: RawRoom[], roomCount: number): RawRoom[] {
  if (rooms.length <= roomCount) return rooms;
  // sort by area desc, stable on index for determinism
  const indexed = rooms.map((rm, i) => ({ rm, i, area: rm.rx * rm.ry }));
  indexed.sort((x, y) => (y.area - x.area) || (x.i - y.i));
  let kept = indexed.slice(0, roomCount);
  // Ensure ≥ 2 large remain.
  const largeKept = kept.filter((k) => k.rm.large).length;
  if (largeKept < 2) {
    // Promote the largest non-large among the dropped, swap with smallest kept non-large.
    const droppedLarge = indexed.slice(roomCount).filter((k) => k.rm.large);
    for (let p = 0; p < droppedLarge.length && kept.filter((k) => k.rm.large).length < 2; p++) {
      const swapIdx = kept.findIndex((k) => !k.rm.large);
      if (swapIdx === -1) break;
      kept[swapIdx] = droppedLarge[p];
    }
  }
  // restore original index order for deterministic downstream iteration
  kept.sort((a, b) => a.i - b.i);
  return kept.map((k) => k.rm);
}

// ---- Stage: connectivity graph (Delaunay → MST → loops) -------------------
function buildGraph(rng: RNG, centers: Pt[], loopChance: number): {
  edges: Edge[]; mstEdges: Array<[number, number]>; loopEdges: Array<[number, number]>;
  allEdges: Array<[number, number]>;
} {
  const n = centers.length;
  const del = delaunayEdges(centers);
  // weights = euclidean distance
  const weights = del.map(([u, v]) => {
    const dx = centers[u].x - centers[v].x;
    const dy = centers[u].y - centers[v].y;
    return Math.sqrt(dx * dx + dy * dy);
  });
  const mst = primMstWeighted(n, del, weights);
  const mstSet = new Set(mst.map(([u, v]) => u < v ? `${u}_${v}` : `${v}_${u}`));
  // mean MST edge length
  const mstWeights = mst.map(([u, v]) => {
    const dx = centers[u].x - centers[v].x;
    const dy = centers[u].y - centers[v].y;
    return Math.sqrt(dx * dx + dy * dy);
  });
  const meanMst = mstWeights.length
    ? mstWeights.reduce((a, b) => a + b, 0) / mstWeights.length
    : 1;
  const maxLoop = 2.2 * meanMst;
  // candidate non-MST Delaunay edges, sorted by length asc for deterministic loop pick
  const candidates: Array<[number, number, number]> = [];
  for (let i = 0; i < del.length; i++) {
    const [u, v] = del[i];
    const key = u < v ? `${u}_${v}` : `${v}_${u}`;
    if (mstSet.has(key)) continue;
    if (weights[i] > maxLoop) continue;
    candidates.push([u, v, weights[i]]);
  }
  candidates.sort((a, b) => (a[2] - b[2]) || (a[0] - b[0]) || (a[1] - b[1]));
  const loopEdges: Array<[number, number]> = [];
  for (const [u, v] of candidates) {
    if (rng.chance(loopChance)) loopEdges.push([u, v]);
  }
  // Loops mandatory: if none added, force the single shortest eligible candidate.
  if (loopEdges.length === 0 && candidates.length > 0) {
    loopEdges.push([candidates[0][0], candidates[0][1]]);
  }
  // Build the Edge[] list (MST first, then loops), deterministic order.
  const edges: Edge[] = [];
  for (const [u, v] of mst) {
    const dx = centers[u].x - centers[v].x;
    const dy = centers[u].y - centers[v].y;
    edges.push({ a: u, b: v, isLoop: false, isCritical: false, len: Math.sqrt(dx * dx + dy * dy) });
  }
  for (const [u, v] of loopEdges) {
    const dx = centers[u].x - centers[v].x;
    const dy = centers[u].y - centers[v].y;
    edges.push({ a: u, b: v, isLoop: true, isCritical: false, len: Math.sqrt(dx * dx + dy * dy) });
  }
  return { edges, mstEdges: mst, loopEdges, allEdges: del };
}

// ---- Stage: semantics ----------------------------------------------------
function assignSemantics(rng: RNG, rooms: Room[], edges: Edge[]): {
  entranceId: number; bossId: number; criticalPath: Set<number>;
} {
  const n = rooms.length;
  // adjacency + degree
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  for (let i = 0; i < n; i++) rooms[i].degree = adj[i].length;

  // Boss = largest-area room. Tie → lowest id.
  let bossId = 0;
  for (let i = 1; i < n; i++) {
    if (rooms[i].w * rooms[i].h > rooms[bossId].w * rooms[bossId].h) bossId = i;
  }
  // graph distances from boss
  const { dist: distFromBoss } = graphBfs(n, adj, bossId);

  // Entrance = degree-1 room maximizing graph distance from boss, excluding
  // rooms adjacent to the boss (entrance ≠ boss-adjacent). If no degree-1
  // candidate qualifies, fall back to min-degree room maximizing distance.
  const bossAdj = new Set(adj[bossId]);
  let entranceId = -1;
  let bestDist = -1;
  for (let i = 0; i < n; i++) {
    if (i === bossId || bossAdj.has(i)) continue;
    if (rooms[i].degree === 1 && distFromBoss[i] > bestDist) {
      bestDist = distFromBoss[i];
      entranceId = i;
    }
  }
  if (entranceId === -1) {
    // fallback: any non-boss-adjacent room minimizing degree, maximizing dist
    let minDeg = Infinity;
    for (let i = 0; i < n; i++) {
      if (i === bossId || bossAdj.has(i)) continue;
      if (rooms[i].degree < minDeg) minDeg = rooms[i].degree;
    }
    for (let i = 0; i < n; i++) {
      if (i === bossId || bossAdj.has(i)) continue;
      if (rooms[i].degree === minDeg && distFromBoss[i] > bestDist) {
        bestDist = distFromBoss[i];
        entranceId = i;
      }
    }
  }
  if (entranceId === -1) entranceId = (bossId + 1) % n; // last resort

  // BFS entrance→boss for critical path
  const { dist: distFromEntrance, prev } = graphBfs(n, adj, entranceId);
  const criticalPath = new Set<number>();
  let cur = bossId;
  while (cur !== -1) {
    criticalPath.add(cur);
    if (cur === entranceId) break;
    cur = prev[cur];
  }
  // tag critical edges
  for (const e of edges) {
    if (criticalPath.has(e.a) && criticalPath.has(e.b)) e.isCritical = true;
  }
  // depth + difficulty per room (graph distance from entrance)
  let maxDepth = 0;
  for (let i = 0; i < n; i++) {
    rooms[i].depth = distFromEntrance[i];
    if (distFromEntrance[i] > maxDepth) maxDepth = distFromEntrance[i];
  }
  for (let i = 0; i < n; i++) {
    if (i === bossId) { rooms[i].difficulty = 1.0; rooms[i].type = 'boss'; continue; }
    if (i === entranceId) { rooms[i].difficulty = 0.15; rooms[i].type = 'entrance'; continue; }
    const d = maxDepth > 0 ? rooms[i].depth / maxDepth : 0;
    rooms[i].difficulty = 0.15 + 0.85 * d;
  }

  // Leaves (degree 1) that aren't entrance → treasure (cap 4). Sort by dist desc
  // so the farthest leaves become treasure (dead-end rewards).
  const leaves: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === entranceId || i === bossId) continue;
    if (rooms[i].degree === 1) leaves.push(i);
  }
  leaves.sort((a, b) => distFromEntrance[b] - distFromEntrance[a]);
  const treasureIds = new Set(leaves.slice(0, 4));
  for (const id of treasureIds) rooms[id].type = 'treasure';

  // 1–2 shrines mid-depth off-path. Off-path = not on critical path, not treasure.
  const shrineCount = rng.int(1, 2);
  const offPathMid: number[] = [];
  for (let i = 0; i < n; i++) {
    if (criticalPath.has(i) || treasureIds.has(i) || i === entranceId || i === bossId) continue;
    const d = maxDepth > 0 ? rooms[i].depth / maxDepth : 0;
    if (d > 0.3 && d < 0.75) offPathMid.push(i);
  }
  // shuffle deterministically
  for (let i = offPathMid.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [offPathMid[i], offPathMid[j]] = [offPathMid[j], offPathMid[i]];
  }
  const shrineIds = new Set(offPathMid.slice(0, shrineCount));
  for (const id of shrineIds) rooms[id].type = 'shrine';

  // 1–2 elite arenas on the critical path at 55–85% depth (exclude entrance & boss).
  const eliteCount = rng.int(1, 2);
  const eliteCandidates: Array<{ id: number; d: number }> = [];
  for (const id of criticalPath) {
    if (id === entranceId || id === bossId) continue;
    const d = maxDepth > 0 ? rooms[id].depth / maxDepth : 0;
    if (d >= 0.55 && d <= 0.85) eliteCandidates.push({ id, d });
  }
  eliteCandidates.sort((a, b) => Math.abs(a.d - 0.7) - Math.abs(b.d - 0.7));
  const eliteIds = new Set(eliteCandidates.slice(0, eliteCount).map((e) => e.id));
  for (const id of eliteIds) rooms[id].type = 'elite';

  // everything else → combat
  for (let i = 0; i < n; i++) {
    if (rooms[i].type === 'entrance') continue; // already set
    if (rooms[i].type === ('boss' as RoomType)) continue;
    if (!treasureIds.has(i) && !shrineIds.has(i) && !eliteIds.has(i)) {
      rooms[i].type = 'combat';
    }
  }
  return { entranceId, bossId, criticalPath };
}

// ---- Stage: rasterize rooms → grid --------------------------------------
/** Public: enumerate the floor cells a room occupies (used by renderer to
 *  rebuild per-room ownership from the data contract). */
export function roomFloorCells(rm: { cx: number; cy: number; w: number; h: number; shape: RoomShape }): Cell[] {
  const cells: Cell[] = [];
  const rx = rm.w, ry = rm.h;
  if (rm.shape === 'rectangle') {
    for (let dy = -ry; dy <= ry; dy++)
      for (let dx = -rx; dx <= rx; dx++)
        cells.push({ x: rm.cx + dx, y: rm.cy + dy });
  } else if (rm.shape === 'ellipse') {
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const nx = dx / (rx + 0.5);
        const ny = dy / (ry + 0.5);
        if (nx * nx + ny * ny <= 1) cells.push({ x: rm.cx + dx, y: rm.cy + dy });
      }
    }
  } else if (rm.shape === 'octagon') {
    // chamfered octagon: rectangle minus 4 corner triangles
    const cut = Math.max(1, Math.floor(Math.min(rx, ry) / 2));
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const ax = Math.abs(dx), ay = Math.abs(dy);
        if (ax > rx - cut && ay > ry - cut) continue; // corner cut
        cells.push({ x: rm.cx + dx, y: rm.cy + dy });
      }
    }
  } else if (rm.shape === 'lshape') {
    // L-shape: full rectangle, then remove one quadrant (deterministic via
    // center-symmetric cut). Keeps an L footprint = 3/4 of the bounding box.
    const cutX = Math.max(1, Math.floor(rx / 2));
    const cutY = Math.max(1, Math.floor(ry / 2));
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        // remove the top-right quadrant beyond the cut
        if (dx > rx - cutX && dy < -ry + cutY) continue;
        cells.push({ x: rm.cx + dx, y: rm.cy + dy });
      }
    }
  } else {
    // cross: central bar (full width, half height) + vertical bar (half width, full height)
    const bx = Math.max(1, Math.floor(rx / 2));
    const by = Math.max(1, Math.floor(ry / 2));
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const inH = Math.abs(dy) <= by;  // within horizontal bar
        const inV = Math.abs(dx) <= bx;  // within vertical bar
        if (inH || inV) cells.push({ x: rm.cx + dx, y: rm.cy + dy });
      }
    }
  }
  return cells;
}

// ---- Stage: corridor carve -----------------------------------------------
function carveCorridors(rng: RNG, dungeon: {
  W: number; H: number; grid: Uint8Array;
  roomOwner: Int16Array; isCorridor: Uint8Array; corridorCells: Cell[];
}, rooms: Room[], edges: Edge[], criticalPath: Set<number>, treasureRoomIds: Set<number>) {
  const { W, H, grid, roomOwner, isCorridor } = dungeon;

  const widthOffsets = (w: number, r: RNG): number[] => {
    if (w <= 1) return [0];
    if (w === 2) return r.chance(0.5) ? [0, 1] : [-1, 0];
    // odd width ≥ 3: centered
    const half = (w - 1) >> 1;
    const out: number[] = [];
    for (let i = -half; i <= half; i++) out.push(i);
    return out;
  };

  const stampH = (x1: number, x2: number, y: number, w: number, r: RNG) => {
    const offs = widthOffsets(w, r);
    const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
    for (let x = lo; x <= hi; x++) {
      for (const off of offs) {
        const yy = y + off;
        if (x < 0 || yy < 0 || x >= W || yy >= H) continue;
        const id = yy * W + x;
        grid[id] = FLOOR;
        isCorridor[id] = 1;
        if (roomOwner[id] === 0) roomOwner[id] = -1; // corridor-marked (no room)
      }
    }
  };
  const stampV = (y1: number, y2: number, x: number, w: number, r: RNG) => {
    const offs = widthOffsets(w, r);
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    for (let y = lo; y <= hi; y++) {
      for (const off of offs) {
        const xx = x + off;
        if (xx < 0 || y < 0 || xx >= W || y >= H) continue;
        const id = y * W + xx;
        grid[id] = FLOOR;
        isCorridor[id] = 1;
        if (roomOwner[id] === 0) roomOwner[id] = -1;
      }
    }
  };

  // process edges in deterministic order (array order). Fork an rng per edge
  // so width/offset decisions are stable & independent of neighbour order.
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    const r = rng.fork(`edge:${Math.min(e.a, e.b)}:${Math.max(e.a, e.b)}`);
    const A = rooms[e.a], B = rooms[e.b];
    // width
    let w = 2;
    if (e.isCritical) w = 3;
    if (treasureRoomIds.has(e.a) || treasureRoomIds.has(e.b)) w = 1;

    const ax = A.cx, ay = A.cy, bx = B.cx, by = B.cy;
    // spans overlap? → straight run, skip elbow
    const xOverlap = Math.min(A.cx + A.w, B.cx + B.w) - Math.max(A.cx - A.w, B.cx - B.w);
    const yOverlap = Math.min(A.cy + A.h, B.cy + B.h) - Math.max(A.cy - A.h, B.cy - B.h);
    if (yOverlap >= 1) {
      // rooms share a y-band → straight horizontal corridor at the shared y
      const y = Math.round((Math.max(A.cy - A.h, B.cy - B.h) + Math.min(A.cy + A.h, B.cy + A.h)) / 2);
      stampH(ax, bx, y, w, r);
    } else if (xOverlap >= 1) {
      const x = Math.round((Math.max(A.cx - A.w, B.cx - B.w) + Math.min(A.cx + A.w, B.cx + B.w)) / 2);
      stampV(ay, by, x, w, r);
    } else {
      // L-corridor, seeded elbow direction
      const hFirst = r.chance(0.5);
      if (hFirst) {
        stampH(ax, bx, ay, w, r);
        stampV(ay, by, bx, w, r);
      } else {
        stampV(ay, by, ax, w, r);
        stampH(ax, bx, by, w, r);
      }
    }
  }
}

// ---- Stage: compute walls + doorways + BFS distance field ----------------
function computeWalls(W: number, H: number, grid: Uint8Array) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (grid[i] !== VOID) continue;
      // 8-neighbor FLOOR?
      let isWall = false;
      for (let dy = -1; dy <= 1 && !isWall; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (grid[ny * W + nx] === FLOOR) { isWall = true; break; }
        }
      }
      if (isWall) grid[i] = WALL;
    }
  }
}

function computeDoorways(W: number, H: number, grid: Uint8Array, roomOwner: Int16Array, isCorridor: Uint8Array): Cell[] {
  const out: Cell[] = [];
  const seen = new Set<number>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!isCorridor[i]) continue;
      if (roomOwner[i] > 0) continue; // inside a room already
      // 4-neighbor room floor?
      const ns = [
        x > 0 ? i - 1 : -1,
        x < W - 1 ? i + 1 : -1,
        y > 0 ? i - W : -1,
        y < H - 1 ? i + W : -1,
      ];
      let isDoor = false;
      for (const ni of ns) {
        if (ni >= 0 && roomOwner[ni] > 0 && grid[ni] === FLOOR) { isDoor = true; break; }
      }
      if (isDoor && !seen.has(i)) {
        seen.add(i);
        out.push({ x, y });
      }
    }
  }
  return out;
}

function computeBfsField(W: number, H: number, grid: Uint8Array, sx: number, sy: number): Int16Array {
  const bfs = new Int16Array(W * H).fill(-1);
  if (grid[sy * W + sx] !== FLOOR) return bfs;
  bfs[sy * W + sx] = 0;
  const queue = [sy * W + sx];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cx = cur % W, cy = (cur / W) | 0;
    const d = bfs[cur];
    const ns = [
      cx > 0 ? cur - 1 : -1,
      cx < W - 1 ? cur + 1 : -1,
      cy > 0 ? cur - W : -1,
      cy < H - 1 ? cur + W : -1,
    ];
    for (const ni of ns) {
      if (ni >= 0 && bfs[ni] === -1 && grid[ni] === FLOOR) {
        bfs[ni] = d + 1;
        queue.push(ni);
      }
    }
  }
  return bfs;
}

// ---- Stage: decoration (data only) ---------------------------------------
function chebyshev(a: Cell, b: Cell): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function decorate(rng: RNG, dungeon: Dungeon & {
  roomOwner: Int16Array; isCorridor: Uint8Array;
}, rooms: Room[], entranceId: number, bossId: number, treasureRoomIds: Set<number>, shrineIds: Set<number>, doorwaySet: Set<number>): { props: Prop[]; spawns: Spawn[]; litTorchPropIds: number[] } {
  const { W, H, grid, bfs, roomOwner, isCorridor } = dungeon;
  const props: Prop[] = [];
  const spawns: Spawn[] = [];
  const blocked = new Uint8Array(W * H); // doorways + placed props
  for (const d of dungeon.doorways) blocked[d.y * W + d.x] = 1;

  // Helper to place a prop on a floor cell.
  const placeProp = (kind: PropKind, x: number, y: number, rot: number, scale: number, roomId: number, phase: number) => {
    const i = y * W + x;
    if (grid[i] === FLOOR && !blocked[i]) {
      props.push({ kind, x, y, rot, scale, roomId, flickerPhase: phase });
      blocked[i] = 1;
      return true;
    }
    return false;
  };

  // Per-room cell lists (floor cells belonging to that room).
  const roomCells: Cell[][] = rooms.map(() => []);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const owner = roomOwner[y * W + x];
      if (owner > 0 && grid[y * W + x] === FLOOR) roomCells[owner - 1].push({ x, y });
    }
  }
  for (let i = 0; i < rooms.length; i++) rooms[i].cells = roomCells[i].length;

  // ---- Pillars in large rooms ----
  for (const rm of rooms) {
    if (rm.w * rm.h < 49) continue; // large = area ≥ 49 (rx,ry ~7)
    // grid every 3 cells, only cells whose 8 neighbors are all floor, ≥2 from any doorway
    for (let dy = -rm.h + 1; dy <= rm.h - 1; dy += 3) {
      for (let dx = -rm.w + 1; dx <= rm.w - 1; dx += 3) {
        const x = rm.cx + dx, y = rm.cy + dy;
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        if (grid[y * W + x] !== FLOOR) continue;
        if (roomOwner[y * W + x] - 1 !== rm.id) continue;
        // 8 neighbors all floor?
        let ok = true;
        for (let ny = -1; ny <= 1 && ok; ny++)
          for (let nx = -1; nx <= 1; nx++) {
            if (nx === 0 && ny === 0) continue;
            if (grid[(y + ny) * W + (x + nx)] !== FLOOR) { ok = false; break; }
          }
        if (!ok) continue;
        // ≥2 Chebyshev from any doorway
        let near = false;
        for (const d of dungeon.doorways) if (chebyshev({ x, y }, d) < 2) { near = true; break; }
        if (near) continue;
        placeProp('pillar', x, y, 0, 1, rm.id, 0);
      }
    }
  }

  // ---- Torches on floor-facing walls ----
  const torchCandidates: Array<{ x: number; y: number; rot: number }> = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (grid[y * W + x] !== WALL) continue;
      // find floor neighbor → bracket faces that way
      let rot = 0, hasFloor = false;
      if (y < H - 1 && grid[(y + 1) * W + x] === FLOOR) { rot = Math.PI; hasFloor = true; }      // wall below floor? wall above floor → faces down
      else if (y > 0 && grid[(y - 1) * W + x] === FLOOR) { rot = 0; hasFloor = true; }            // wall under floor → faces up
      else if (x < W - 1 && grid[y * W + x + 1] === FLOOR) { rot = -Math.PI / 2; hasFloor = true; }
      else if (x > 0 && grid[y * W + x - 1] === FLOOR) { rot = Math.PI / 2; hasFloor = true; }
      if (hasFloor) torchCandidates.push({ x, y, rot });
    }
  }
  // greedy placement with Chebyshev spacing ≥4, seeded shuffle order.
  // Uses an O(1) occupancy grid instead of O(placed) linear scan — the linear
  // scan was the dominant cost at 60 rooms (O(candidates × placed)).
  for (let i = torchCandidates.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [torchCandidates[i], torchCandidates[j]] = [torchCandidates[j], torchCandidates[i]];
  }
  const torchBlocked = new Uint8Array(W * H); // 1 = within spacing of a placed torch
  const SP = 3; // Chebyshev spacing radius (spacing ≥4 ⟺ no other torch within radius 3)
  const markTorch = (cx: number, cy: number) => {
    for (let dy = -SP; dy <= SP; dy++)
      for (let dx = -SP; dx <= SP; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        torchBlocked[ny * W + nx] = 1;
      }
  };
  for (const c of torchCandidates) {
    if (torchBlocked[c.y * W + c.x]) continue;
    // find owning room (nearest room center via roomOwner on adjacent floor)
    let roomId = -1;
    const ns = [c.x > 0 ? c.y * W + c.x - 1 : -1, c.x < W - 1 ? c.y * W + c.x + 1 : -1,
                c.y > 0 ? (c.y - 1) * W + c.x : -1, c.y < H - 1 ? (c.y + 1) * W + c.x : -1];
    for (const ni of ns) if (ni >= 0 && roomOwner[ni] > 0) { roomId = roomOwner[ni] - 1; break; }
    const phase = rng.range(0, Math.PI * 2);
    props.push({ kind: 'torch', x: c.x, y: c.y, rot: c.rot, scale: 1, roomId, flickerPhase: phase });
    markTorch(c.x, c.y);
  }

  // ---- Debris: density ∝ decorDensity, higher in low-difficulty rooms ----
  for (const rm of rooms) {
    if (rm.type === 'entrance' || rm.type === 'boss') continue;
    const density = dungeon.params.decorDensity * (0.4 + 0.6 * (1 - rm.difficulty));
    for (const cell of roomCells[rm.id]) {
      if (blocked[cell.y * W + cell.x]) continue;
      if (rng.float() < density * 0.06) {
        props.push({ kind: 'debris', x: cell.x, y: cell.y, rot: rng.range(0, Math.PI * 2), scale: rng.range(0.5, 1.2), roomId: rm.id, flickerPhase: 0 });
        blocked[cell.y * W + cell.x] = 1;
      }
    }
  }

  // ---- Braziers ringing the boss arena ----
  const boss = rooms[bossId];
  {
    const ring: Cell[] = [];
    for (let dy = -boss.h; dy <= boss.h; dy++) {
      for (let dx = -boss.w; dx <= boss.w; dx++) {
        const x = boss.cx + dx, y = boss.cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (grid[y * W + x] !== FLOOR) continue;
        // must belong to the boss room (not a corridor cell on the ring edge)
        if (roomOwner[y * W + x] - 1 !== bossId) continue;
        // perimeter: on the room's bounding ring
        if (Math.abs(dx) === boss.w || Math.abs(dy) === boss.h) ring.push({ x, y });
      }
    }
    // space them out ≥ 3
    const placed: Cell[] = [];
    for (let i = ring.length - 1; i > 0; i--) { const j = rng.int(0, i); [ring[i], ring[j]] = [ring[j], ring[i]]; }
    for (const c of ring) {
      let ok = true;
      for (const p of placed) if (chebyshev(c, p) < 3) { ok = false; break; }
      if (!ok) continue;
      props.push({ kind: 'brazier', x: c.x, y: c.y, rot: 0, scale: 1, roomId: bossId, flickerPhase: rng.range(0, Math.PI * 2) });
      placed.push(c);
      blocked[c.y * W + c.x] = 1;
    }
  }

  // ---- Chest in each treasure room (center-ish) ----
  for (const id of treasureRoomIds) {
    const rm = rooms[id];
    // pick a floor cell near center, not blocked
    const candidates = roomCells[id].filter((c) => !blocked[c.y * W + c.x]);
    // closest to center
    candidates.sort((a, b) =>
      (Math.abs(a.x - rm.cx) + Math.abs(a.y - rm.cy)) -
      (Math.abs(b.x - rm.cx) + Math.abs(b.y - rm.cy)));
    if (candidates.length) {
      const c = candidates[0];
      props.push({ kind: 'chest', x: c.x, y: c.y, rot: rng.range(0, Math.PI * 2), scale: 1, roomId: id, flickerPhase: 0 });
      blocked[c.y * W + c.x] = 1;
    }
  }

  // ---- Shrine crystal in each shrine room ----
  for (const id of shrineIds) {
    const rm = rooms[id];
    const c = { x: rm.cx, y: rm.cy };
    if (grid[c.y * W + c.x] === FLOOR && !blocked[c.y * W + c.x]) {
      props.push({ kind: 'crystal', x: c.x, y: c.y, rot: 0, scale: 1, roomId: id, flickerPhase: rng.range(0, Math.PI * 2) });
      blocked[c.y * W + c.x] = 1;
    }
  }

  // ---- Entrance portal ring ----
  const ent = rooms[entranceId];
  {
    const c = { x: ent.cx, y: ent.cy };
    if (grid[c.y * W + c.x] === FLOOR) {
      props.push({ kind: 'portal', x: c.x, y: c.y, rot: 0, scale: 1, roomId: entranceId, flickerPhase: 0 });
      blocked[c.y * W + c.x] = 1;
    }
  }

  // ---- Enemy spawns ----
  for (const rm of rooms) {
    if (rm.type === 'entrance' || rm.type === 'treasure' || rm.type === 'shrine') continue;
    const count = Math.round(rm.cells / 18 * (0.5 + rm.difficulty));
    const avail = roomCells[rm.id].filter((c) => !blocked[c.y * W + c.x]);
    // partial Fisher-Yates: only shuffle the first `need` positions we'll use
    // (full shuffle of every room's cell list was the 60-room bottleneck).
    const need = Math.min(count, avail.length, rm.type === 'boss' ? 1 : 99);
    for (let i = 0; i < need; i++) {
      const j = i + rng.int(0, avail.length - 1 - i);
      const tmp = avail[i]; avail[i] = avail[j]; avail[j] = tmp;
    }
    let tier = 0;
    if (rm.type === 'elite') tier = 2;
    else if (rm.type === 'boss') tier = 3;
    for (let k = 0; k < need; k++) {
      const c = avail[k];
      // trash/normal mix for combat
      const t = rm.type === 'combat' ? (rng.chance(0.6) ? 0 : 1) : tier;
      spawns.push({ x: c.x, y: c.y, tier: t, roomId: rm.id });
      blocked[c.y * W + c.x] = 1;
    }
  }

  // ---- Lights: farthest-point-sampled subset of torches within budget ----
  const torchPropIdx: number[] = [];
  for (let i = 0; i < props.length; i++) if (props[i].kind === 'torch') torchPropIdx.push(i);
  const keyLightCount = 1 /*entrance portal*/ + (shrineIds.size > 0 ? 1 : 0) + 1 /*boss*/;
  const torchBudget = Math.max(0, LIGHT_BUDGET - keyLightCount);
  const litTorchPropIds = farthestPointSample(
    torchPropIdx.map((pi) => ({ x: props[pi].x, y: props[pi].y })),
    torchBudget, rng,
  ).map((i) => torchPropIdx[i]);

  return { props, spawns, litTorchPropIds };
}

// ---- Farthest-point sampling ---------------------------------------------
function farthestPointSample(pts: Pt[], k: number, rng: RNG): number[] {
  if (pts.length === 0 || k <= 0) return [];
  if (pts.length <= k) return pts.map((_, i) => i);
  const start = rng.int(0, pts.length - 1);
  const chosen = [start];
  const dist = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - pts[start].x, dy = pts[i].y - pts[start].y;
    dist[i] = dx * dx + dy * dy;
  }
  while (chosen.length < k) {
    let bi = -1, bd = -1;
    for (let i = 0; i < pts.length; i++) {
      if (dist[i] > bd) { bd = dist[i]; bi = i; }
    }
    if (bi === -1) break;
    chosen.push(bi);
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - pts[bi].x, dy = pts[i].y - pts[bi].y;
      const d = dx * dx + dy * dy;
      if (d < dist[i]) dist[i] = d;
    }
  }
  return chosen;
}

// ---- Stable grid checksum (FNV-1a over grid bytes) -----------------------
function gridChecksum(grid: Uint8Array): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < grid.length; i++) {
    h ^= grid[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---- Per-room tint -------------------------------------------------------
function assignTints(rng: RNG, rooms: Room[], theme: Theme) {
  const base = THEME_TINT[theme];
  for (const rm of rooms) {
    const j = 0.05;
    let r = base[0] + rng.range(-j, j);
    let g = base[1] + rng.range(-j, j);
    let b = base[2] + rng.range(-j, j);
    // boss rooms tint slightly redder, treasure slightly gold, shrine slightly cyan
    if (rm.type === 'boss') { r += 0.08; g -= 0.04; b -= 0.04; }
    else if (rm.type === 'treasure') { r += 0.05; g += 0.06; b -= 0.05; }
    else if (rm.type === 'shrine') { r -= 0.06; g += 0.0; b += 0.1; }
    rm.tint = [
      Math.max(0, Math.min(1, r)),
      Math.max(0, Math.min(1, g)),
      Math.max(0, Math.min(1, b)),
    ];
  }
}

// ---- Core single-attempt generation --------------------------------------
function coreGenerate(params: Params, seed: number): Dungeon {
  const rng = makeRng(seed);
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // 2. scatter
  let raw = scatterRooms(rng.fork('scatter'), params.roomCount);
  // 3. separate + snap + cull
  raw = separateRooms(rng.fork('separate'), raw);
  raw = cullRooms(raw, params.roomCount);

  // build Room[] with integer centers + half-extents
  const rooms: Room[] = raw.map((rm, i) => ({
    id: i, cx: rm.cx, cy: rm.cy, w: rm.rx, h: rm.ry, shape: rm.shape,
    type: 'combat' as RoomType, depth: 0, difficulty: 0.15, degree: 0, cells: 0,
    tint: [0.5, 0.5, 0.5],
  }));

  // grid bounds: encompass all room AABBs + margin
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rm of rooms) {
    minX = Math.min(minX, rm.cx - rm.w - 2);
    minY = Math.min(minY, rm.cy - rm.h - 2);
    maxX = Math.max(maxX, rm.cx + rm.w + 2);
    maxY = Math.max(maxY, rm.cy + rm.h + 2);
  }
  const W = maxX - minX + 1;
  const H = maxY - minY + 1;
  const offX = -minX;
  const offY = -minY;
  for (const rm of rooms) { rm.cx += offX; rm.cy += offY; }

  const grid = new Uint8Array(W * H);       // VOID=0
  const roomOwner = new Int16Array(W * H);  // 0 none, >0 room id+1, -1 corridor-only
  const isCorridor = new Uint8Array(W * H);

  // stamp room floors
  for (const rm of rooms) {
    const cells = roomFloorCells(rm);
    for (const c of cells) {
      if (c.x < 0 || c.y < 0 || c.x >= W || c.y >= H) continue;
      const id = c.y * W + c.x;
      grid[id] = FLOOR;
      roomOwner[id] = rm.id + 1;
    }
  }

  // 4. graph
  const centers: Pt[] = rooms.map((r) => ({ x: r.cx, y: r.cy }));
  const { edges } = buildGraph(rng.fork('graph'), centers, params.loopChance);

  // 5. semantics
  const { entranceId, bossId, criticalPath } = assignSemantics(rng.fork('semantics'), rooms, edges);
  const treasureRoomIds = new Set(rooms.filter((r) => r.type === 'treasure').map((r) => r.id));
  const shrineIds = new Set(rooms.filter((r) => r.type === 'shrine').map((r) => r.id));

  // 6. carve corridors
  const dungeonTransient = { W, H, grid, roomOwner, isCorridor, corridorCells: [] as Cell[] };
  carveCorridors(rng.fork('carve'), dungeonTransient, rooms, edges, criticalPath, treasureRoomIds);
  // collect corridor cells
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (isCorridor[y * W + x]) dungeonTransient.corridorCells.push({ x, y });

  // 7. walls + doorways + BFS
  computeWalls(W, H, grid);
  const doorways = computeDoorways(W, H, grid, roomOwner, isCorridor);
  const ent = rooms[entranceId];
  const bfs = computeBfsField(W, H, grid, ent.cx, ent.cy);

  // 8. decorate
  const doorwaySet = new Set(doorways.map((d) => d.y * W + d.x));
  assignTints(rng.fork('tints'), rooms, params.theme);
  const baseDungeon: Dungeon = {
    params: { ...params, seed: params.seed }, name: '', W, H, grid, bfs,
    rooms, edges, doorways, corridorCells: dungeonTransient.corridorCells,
    props: [], spawns: [], stats: {} as Stats, entranceId, bossId,
    // @ts-expect-error litTorchPropIds is an extension to the data contract
    litTorchPropIds: [],
  };
  const { props, spawns, litTorchPropIds } = decorate(
    rng.fork('decorate'),
    Object.assign(baseDungeon, { roomOwner, isCorridor }) as any,
    rooms, entranceId, bossId, treasureRoomIds, shrineIds, doorwaySet,
  );
  baseDungeon.props = props;
  baseDungeon.spawns = spawns;
  (baseDungeon as any).litTorchPropIds = litTorchPropIds;

  // 9. name + stats
  baseDungeon.name = generateDungeonName(rng.fork('name'));
  // maxDepth = max GRAPH distance from entrance (used by difficulty + acceptance test)
  let maxGraphDepth = 0;
  for (const rm of rooms) if (rm.depth > maxGraphDepth) maxGraphDepth = rm.depth;
  // also expose the grid-BFS max for reveal/pacing diagnostics
  let maxGridDepth = 0;
  for (let i = 0; i < bfs.length; i++) if (bfs[i] > maxGridDepth) maxGridDepth = bfs[i];
  let floorTiles = 0, wallTiles = 0;
  for (let i = 0; i < grid.length; i++) { if (grid[i] === FLOOR) floorTiles++; else if (grid[i] === WALL) wallTiles++; }
  const keyLightCount = 1 + (shrineIds.size > 0 ? 1 : 0) + 1;
  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  baseDungeon.stats = {
    rooms: rooms.length,
    edges: edges.length,
    loops: edges.length - rooms.length + 1,
    criticalLength: rooms[bossId].depth,
    floorTiles, wallTiles,
    props: props.length, spawns: spawns.length,
    lights: litTorchPropIds.length + keyLightCount,
    genMs: t1 - t0,
    maxDepth: maxGraphDepth,
    checksum: gridChecksum(grid),
  };
  (baseDungeon as any).maxGridDepth = maxGridDepth;
  return baseDungeon;
}

// ---- Connectivity validation ---------------------------------------------
function connectivityOk(d: Dungeon): boolean {
  // flood fill from entrance room center; must reach 100% of floor cells
  const ent = d.rooms[d.entranceId];
  if (d.grid[ent.cy * d.W + ent.cx] !== FLOOR) return false;
  let totalFloor = 0;
  for (let i = 0; i < d.grid.length; i++) if (d.grid[i] === FLOOR) totalFloor++;
  const reached = gridFloodCount(d.grid, d.W, d.H, ent.cx, ent.cy, (v) => v === FLOOR);
  return reached === totalFloor && totalFloor > 0;
}

// ---- Public entry: generateDungeon with re-roll safety net ---------------
export function generateDungeon(paramsIn: Partial<Params> = {}): Dungeon {
  const params: Params = { ...DEFAULT_PARAMS, ...paramsIn };
  let seed = params.seed >>> 0;
  let last: Dungeon | null = null;
  for (let attempt = 0; attempt < MAX_REROLL; attempt++) {
    const d = coreGenerate({ ...params, seed }, seed);
    last = d;
    if (connectivityOk(d)) return d;
    // derive a new seed for the next attempt (deterministic)
    seed = (hashString(`reroll:${attempt}:${seed}`) ^ 0x9e3779b9) >>> 0;
  }
  // Should never happen — but never ship a broken layout. Return the last
  // attempt; its stats will still be honest.
  return last!;
}

export { gridChecksum };
