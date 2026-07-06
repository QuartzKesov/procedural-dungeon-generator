// editor.ts — Level editor logic for manual dungeon editing.
// Works on a mutable copy of the dungeon grid + props.
// Pure data operations: NO THREE imports.

import {
  Dungeon, Room, Prop, Cell, FLOOR, WALL, VOID,
  PropKind, RoomShape, Params,
} from './types';
import { roomFloorCells } from './generator';

export type EditTool =
  | 'floor'      // paint floor tiles
  | 'wall'       // paint wall tiles
  | 'erase'      // erase to void
  | 'torch'      // place torch
  | 'chest'      // place chest
  | 'pillar'     // place pillar
  | 'crystal'    // place shrine crystal
  | 'trap'       // place trap
  | 'teleport'   // place teleport
  | 'door'       // place door (auto-oriented to corridor)
  | 'room_rect'  // stamp rectangular room
  | 'room_ellipse' // stamp elliptical room
  | 'room_octagon' // stamp octagonal room
  | 'select';    // select/move existing props

export interface EditAction {
  type: 'grid' | 'prop_add' | 'prop_remove';
  // for grid: store old+new values at (x,y)
  cells?: Array<{ x: number; y: number; old: number; new: number }>;
  // for prop_add: the prop that was added
  prop?: Prop;
  // for prop_remove: index of removed prop
  propIndex?: number;
  removedProp?: Prop;
}

export interface EditorState {
  enabled: boolean;
  tool: EditTool;
  brushSize: number;       // 1-5
  roomSize: number;        // 3-15 for room stamping
  history: EditAction[];
  historyIdx: number;      // current position in history (-1 = nothing undone)
}

export function createEditorState(): EditorState {
  return {
    enabled: false,
    tool: 'floor',
    brushSize: 1,
    roomSize: 7,
    history: [],
    historyIdx: -1,
  };
}

// Create a deep mutable copy of a dungeon for editing
export function cloneDungeonForEdit(d: Dungeon): Dungeon {
  return {
    ...d,
    grid: new Uint8Array(d.grid),  // copy the grid
    bfs: new Int16Array(d.bfs),
    rooms: d.rooms.map((r) => ({ ...r })),
    props: d.props.map((p) => ({ ...p })),
    spawns: d.spawns.map((s) => ({ ...s })),
    events: d.events.map((e) => ({ ...e })),
    doorways: d.doorways.map((c) => ({ ...c })),
    corridorCells: d.corridorCells.map((c) => ({ ...c })),
    edges: d.edges.map((e) => ({ ...e })),
    params: { ...d.params },
    stats: { ...d.stats },
  };
}

// Apply a grid edit: set cells to a value within brush radius
export function editGrid(
  d: Dungeon, x: number, y: number, value: number, brushSize: number,
): EditAction {
  const action: EditAction = { type: 'grid', cells: [] };
  const r = brushSize - 1;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= d.W || ny >= d.H) continue;
      const i = ny * d.W + nx;
      const old = d.grid[i];
      if (old === value) continue;
      d.grid[i] = value;
      action.cells!.push({ x: nx, y: ny, old, new: value });
    }
  }
  return action;
}

// Stamp a room shape at (cx, cy)
export function stampRoom(
  d: Dungeon, cx: number, cy: number, size: number, shape: RoomShape,
): EditAction {
  const action: EditAction = { type: 'grid', cells: [] };
  const half = Math.floor(size / 2);
  const tempRoom = { cx, cy, w: half, h: half, shape };
  const cells = roomFloorCells(tempRoom);
  for (const c of cells) {
    if (c.x < 0 || c.y < 0 || c.x >= d.W || c.y >= d.H) continue;
    const i = c.y * d.W + c.x;
    const old = d.grid[i];
    if (old === FLOOR) continue;
    d.grid[i] = FLOOR;
    action.cells!.push({ x: c.x, y: c.y, old, new: FLOOR });
  }
  return action;
}

// Add a prop at (x, y)
export function addProp(
  d: Dungeon, kind: PropKind, x: number, y: number,
): EditAction {
  const prop: Prop = {
    kind, x, y, rot: 0, scale: 1, roomId: -1, flickerPhase: Math.random() * Math.PI * 2,
  };
  d.props.push(prop);
  return { type: 'prop_add', prop };
}

// Add a door at (x, y) with orientation auto-detected from the surrounding
// floor cells. If floor exists to the LEFT or RIGHT, the passage runs
// north-south → door slab horizontal (rot = 0). Otherwise (floor above/below)
// → passage runs east-west → door slab vertical (rot = π/2).
export function addDoor(d: Dungeon, x: number, y: number): EditAction {
  const { W, H, grid } = d;
  const left = x > 0 && grid[y * W + (x - 1)] === FLOOR;
  const right = x < W - 1 && grid[y * W + (x + 1)] === FLOOR;
  // If floor is on the sides, passage runs N-S → door blocks N-S → slab horizontal
  const rot = (left || right) ? 0 : Math.PI / 2;
  const prop: Prop = {
    kind: 'door', x, y, rot, scale: 1, roomId: -1, flickerPhase: 0,
  };
  d.props.push(prop);
  return { type: 'prop_add', prop };
}

// Remove a prop by index
export function removeProp(d: Dungeon, index: number): EditAction {
  const removed = d.props[index];
  d.props.splice(index, 1);
  return { type: 'prop_remove', propIndex: index, removedProp: removed };
}

// Recompute walls from the current grid state
export function recomputeWalls(d: Dungeon) {
  const { W, H, grid } = d;
  // First, clear all walls back to void
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === WALL) grid[i] = VOID;
  }
  // Then, for each void cell with a floor neighbor, make it a wall
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (grid[i] !== VOID) continue;
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

// Undo an action
export function undoAction(d: Dungeon, action: EditAction) {
  if (action.type === 'grid' && action.cells) {
    for (const c of action.cells) {
      d.grid[c.y * d.W + c.x] = c.old;
    }
  } else if (action.type === 'prop_add' && action.prop) {
    const idx = d.props.lastIndexOf(action.prop);
    if (idx >= 0) d.props.splice(idx, 1);
  } else if (action.type === 'prop_remove' && action.removedProp) {
    d.props.push(action.removedProp);
  }
}

// Redo an action
export function redoAction(d: Dungeon, action: EditAction) {
  if (action.type === 'grid' && action.cells) {
    for (const c of action.cells) {
      d.grid[c.y * d.W + c.x] = c.new;
    }
  } else if (action.type === 'prop_add' && action.prop) {
    d.props.push(action.prop);
  } else if (action.type === 'prop_remove' && action.propIndex !== undefined) {
    d.props.splice(action.propIndex, 1);
  }
}

// Push an action to history (truncates any redo tail)
export function pushHistory(state: EditorState, action: EditAction) {
  state.history = state.history.slice(0, state.historyIdx + 1);
  state.history.push(action);
  state.historyIdx = state.history.length - 1;
  // cap history at 100 actions
  if (state.history.length > 100) {
    state.history.shift();
    state.historyIdx--;
  }
}

// Save edited dungeon to localStorage
export function saveEditedDungeon(d: Dungeon, name: string) {
  const key = `dungeon-edit-${name}`;
  const data = {
    name,
    params: d.params,
    grid: Array.from(d.grid),
    W: d.W, H: d.H,
    props: d.props,
    spawns: d.spawns,
    events: d.events,
    rooms: d.rooms,
    edges: d.edges,
    entranceId: d.entranceId,
    bossId: d.bossId,
    at: Date.now(),
  };
  try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
}

// Load edited dungeons list from localStorage
export function listEditedDungeons(): Array<{ name: string; at: number }> {
  const result: Array<{ name: string; at: number }> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('dungeon-edit-')) {
        const raw = localStorage.getItem(key);
        if (raw) {
          const data = JSON.parse(raw);
          result.push({ name: data.name, at: data.at });
        }
      }
    }
  } catch {}
  return result.sort((a, b) => b.at - a.at);
}

// Delete an edited dungeon from localStorage
export function deleteEditedDungeon(name: string) {
  try { localStorage.removeItem(`dungeon-edit-${name}`); } catch {}
}
