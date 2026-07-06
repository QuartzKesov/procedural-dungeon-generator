// types.ts — Data contract for the dungeon generator.
// Pure data: NO THREE imports. Typed arrays + POJOs only.

export type Theme = 'crypt' | 'cavern' | 'catacomb' | 'forge' | 'ice' | 'jungle';
export type WeatherType = 'none' | 'rain' | 'snow' | 'ash';

export interface Params {
  seed: number;
  roomCount: number;     // default 42
  loopChance: number;    // default 0.15
  decorDensity: number;  // default 0.6
  theme: Theme;          // default 'crypt'
  // ---- multi-level ----
  multiLevel: boolean;   // default false — generate stairs between floors
  levelCount: number;    // default 1 — number of floors (1-5)
  currentLevel: number;  // default 0 — which floor is displayed
  // ---- events ----
  eventDensity: number;  // default 0.3 — chance of traps/teleports/altars/merchants
  // ---- weather ----
  weather: WeatherType;  // default 'none'
}

export const DEFAULT_PARAMS: Params = {
  seed: 1337,
  roomCount: 42,
  loopChance: 0.15,
  decorDensity: 0.6,
  theme: 'crypt',
  multiLevel: false,
  levelCount: 1,
  currentLevel: 0,
  eventDensity: 0.3,
  weather: 'none',
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
  floor: number;       // which dungeon level (0-based)
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
  | 'statue'
  | 'sarcophagus'
  | 'mushroom'
  | 'icecrystal'
  | 'chandelier'
  | 'cobweb'
  | 'banner'
  // ---- events ----
  | 'trap'
  | 'teleport'
  | 'altar'
  | 'merchant'
  // ---- furniture/decor ----
  | 'table'
  | 'chair'
  | 'bookshelf'
  | 'candle'
  | 'rug'
  | 'pot'
  | 'door'
  // ---- multi-level ----
  | 'stairs_down'
  | 'stairs_up';

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

// ---- Event data (traps, teleports, altars, merchants) ----
export type EventType = 'trap' | 'teleport' | 'altar' | 'merchant';

export interface DungeonEvent {
  type: EventType;
  x: number;
  y: number;
  roomId: number;
  // trap: damage amount; teleport: target grid coords; altar: buff type; merchant: gold
  data: number;
  // teleport target (for teleport events)
  targetX?: number;
  targetY?: number;
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
  events: number;
  level: number;          // which floor (0-based)
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
  events: DungeonEvent[];
  stats: Stats;
  // Per-room semantic info, ordered by id (kept separate for renderer/tests)
  entranceId: number;
  bossId: number;
  // ---- multi-level ----
  stairsDown?: Cell;      // stairs to next floor (if multi-level and not top floor)
  stairsUp?: Cell;        // stairs to previous floor (if multi-level and not ground floor)
  parentSeed?: number;    // seed of the floor above (for multi-level)
}

// ---- Export format (JSON / Tiled) ----
export interface ExportData {
  format: 'dungeon-json' | 'tiled';
  version: 1;
  params: Params;
  name: string;
  level: number;
  width: number;
  height: number;
  grid: number[];         // flattened grid (VOID=0, FLOOR=1, WALL=2)
  rooms: Array<{
    id: number;
    cx: number; cy: number;
    w: number; h: number;
    shape: string; type: string;
    depth: number; difficulty: number;
  }>;
  props: Array<{
    kind: string; x: number; y: number; rot: number; scale: number; roomId: number;
  }>;
  spawns: Array<{
    x: number; y: number; tier: number; roomId: number;
  }>;
  events: Array<{
    type: string; x: number; y: number; roomId: number; data: number;
  }>;
  entranceId: number;
  bossId: number;
  // Tiled-specific (when format='tiled')
  tiled?: {
    layers: Array<{ name: string; data: number[]; width: number; height: number }>;
    tilesets: Array<{ name: string; tilewidth: number; tileheight: number }>;
  };
}

// Helper: convert (x,y) → index. Grid is row-major with stride W.
export function idx(d: { W: number }, x: number, y: number): number {
  return y * d.W + x;
}

export function inBounds(d: { W: number; H: number }, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < d.W && y < d.H;
}
