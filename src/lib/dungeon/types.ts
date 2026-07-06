// types.ts — Data contract for the dungeon generator.
// Pure data: NO THREE imports. Typed arrays + POJOs only.

export type Theme = 'crypt' | 'cavern' | 'catacomb' | 'forge' | 'ice' | 'jungle';

export interface Params {
  seed: number;
  roomCount: number;     // default 42
  loopChance: number;    // default 0.15
  decorDensity: number;  // default 0.6
  theme: Theme;          // default 'crypt'
}

export const DEFAULT_PARAMS: Params = {
  seed: 1337,
  roomCount: 42,
  loopChance: 0.15,
  decorDensity: 0.6,
  theme: 'crypt',
};

// ---- Grid cell constants -------------------------------------------------
export const VOID = 0;
export const FLOOR = 1;
export const WALL = 2;

export type RoomShape = 'rectangle' | 'ellipse' | 'octagon' | 'lshape' | 'cross';
export type RoomType =
  | 'entrance'
  | 'boss'
  | 'treasure'
  | 'shrine'
  | 'elite'
  | 'combat';

export interface Room {
  id: number;
  cx: number;          // center x (integer grid coords)
  cy: number;          // center y
  w: number;           // half-extents along x (for rect), or rx
  h: number;           // half-extents along y (for rect), or ry
  shape: RoomShape;
  type: RoomType;
  depth: number;       // graph distance from entrance
  difficulty: number;  // 0.15 .. 1.0 (boss = 1.0)
  degree: number;      // edges in the final graph
  cells: number;       // number of floor cells in this room (post-raster)
  tint: [number, number, number]; // linear RGB 0..1 per-room accent
}

export interface Edge {
  a: number;           // room id
  b: number;           // room id
  isLoop: boolean;     // true if non-MST
  isCritical: boolean; // true if on entrance→boss path
  len: number;         // euclidean center distance (pre-carve)
}

export interface Cell {
  x: number;
  y: number;
}

export type PropKind =
  | 'pillar'
  | 'torch'
  | 'brazier'
  | 'debris'
  | 'chest'
  | 'crystal'
  | 'portal'
  | 'stalagmite'
  | 'bones'
  | 'barrel'
  | 'crate'
  | 'statue';

export interface Prop {
  kind: PropKind;
  x: number;
  y: number;
  rot: number;        // radians, around Y
  scale: number;
  roomId: number;     // -1 for corridor props
  flickerPhase: number; // for torches/flames
}

export interface Spawn {
  x: number;
  y: number;
  tier: number;       // 0 trash, 1 normal, 2 elite, 3 boss
  roomId: number;
}

export interface Stats {
  rooms: number;
  edges: number;
  loops: number;          // E - V + 1
  criticalLength: number; // BFS hops entrance→boss
  floorTiles: number;
  wallTiles: number;
  props: number;
  spawns: number;
  lights: number;
  genMs: number;          // measured wall-clock generation time
  maxDepth: number;       // max BFS distance
  checksum: number;       // stable hash of grid for reproducibility test
}

export interface Dungeon {
  params: Params;
  name: string;
  W: number;
  H: number;
  grid: Uint8Array;       // VOID | FLOOR | WALL, length W*H
  bfs: Int16Array;        // per-cell distance from entrance, -1 = non-floor
  rooms: Room[];
  edges: Edge[];
  doorways: Cell[];
  corridorCells: Cell[];
  props: Prop[];
  spawns: Spawn[];
  stats: Stats;
  // Per-room semantic info, ordered by id (kept separate for renderer/tests)
  entranceId: number;
  bossId: number;
}

// Helper: convert (x,y) → index. Grid is row-major with stride W.
export function idx(d: { W: number }, x: number, y: number): number {
  return y * d.W + x;
}

export function inBounds(d: { W: number; H: number }, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < d.W && y < d.H;
}
