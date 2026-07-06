// uvtt.ts — Universal VTT (.dd2vtt) export for Foundry VTT dd-import module.
// Generates a top-down pixel-art map PNG + wall/door/light data in UVTT format.
// Pure data: NO THREE imports. Uses canvas for PNG rendering.

import {
  Dungeon, FLOOR, WALL, VOID, Cell,
} from './types';
import { roomFloorCells } from './generator';

// ---- UVTT format types ----
interface UVTTResolution {
  map_origin: { x: number; y: number };
  map_size: { rows: number; cols: number };
  pixels_per_grid: number;
}

interface UVTTPortal {
  position: { x: number; y: number };
  closed: boolean;
  freestanding: boolean;
  direction?: number;
}

interface UVTTLight {
  position: { x: number; y: number };
  intensity: number;
  color: string;
  range: number;
  shadows: boolean;
}

interface UVTTFile {
  format: number;
  resolution: UVTTResolution;
  line_of_sight: Array<{ x: number; y: number }>;
  port: number;
  portals: UVTTPortal[];
  lights: UVTTLight[];
  image: string; // base64 PNG (without data: prefix)
}

const PIXELS_PER_GRID = 100; // standard for Foundry

/**
 * Render a top-down pixel-art map of the dungeon on a canvas.
 * Returns the canvas for further processing.
 */
export function renderTopDownMap(d: Dungeon, scale: number = PIXELS_PER_GRID): HTMLCanvasElement {
  const { W, H, grid } = d;
  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d')!;

  // Build room ownership for tinting
  const owner = new Int16Array(W * H);
  for (const r of d.rooms) {
    for (const c of roomFloorCells(r)) {
      if (c.x < 0 || c.y < 0 || c.x >= W || c.y >= H) continue;
      if (d.grid[c.y * W + c.x] === FLOOR) owner[c.y * W + c.x] = r.id + 1;
    }
  }

  // Theme colors (RGB)
  const themeColors: Record<string, [number, number, number]> = {
    crypt:    [80, 75, 70],
    cavern:   [72, 58, 44],
    catacomb: [96, 88, 78],
    forge:    [72, 54, 44],
    ice:      [84, 100, 116],
    jungle:   [60, 76, 48],
  };
  const wallColors: Record<string, [number, number, number]> = {
    crypt:    [50, 46, 52],
    cavern:   [48, 36, 28],
    catacomb: [68, 62, 54],
    forge:    [46, 34, 30],
    ice:      [58, 70, 80],
    jungle:   [38, 44, 28],
  };
  const floorBase = themeColors[d.params.theme] ?? themeColors.crypt;
  const wallBase = wallColors[d.params.theme] ?? wallColors.crypt;

  // Draw each grid cell
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = grid[i];
      const px = x * scale;
      const py = y * scale;

      if (v === FLOOR) {
        // Floor: blend with room tint
        const rid = owner[i] - 1;
        let r = floorBase[0], g = floorBase[1], b = floorBase[2];
        if (rid >= 0) {
          const t = d.rooms[rid].tint;
          r = Math.round(r * 0.7 + t[0] * 255 * 0.3);
          g = Math.round(g * 0.7 + t[1] * 255 * 0.3);
          b = Math.round(b * 0.7 + t[2] * 255 * 0.3);
        }
        // slight value noise for texture
        const n = ((x * 73856093) ^ (y * 19349663) ^ (d.params.seed)) & 0xff;
        const j = (n / 255 - 0.5) * 20;
        r = Math.max(0, Math.min(255, r + j));
        g = Math.max(0, Math.min(255, g + j));
        b = Math.max(0, Math.min(255, b + j));
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(px, py, scale, scale);
      } else if (v === WALL) {
        // Wall: darker with slight variation
        const n = ((x * 374761393) ^ (y * 668265263) ^ (d.params.seed ^ 0xa5a5)) & 0xff;
        const j = (n / 255 - 0.5) * 16;
        const r = Math.max(0, Math.min(255, wallBase[0] + j));
        const g = Math.max(0, Math.min(255, wallBase[1] + j));
        const b = Math.max(0, Math.min(255, wallBase[2] + j));
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(px, py, scale, scale);
      } else {
        // Void: very dark
        ctx.fillStyle = '#0a0a0e';
        ctx.fillRect(px, py, scale, scale);
      }
    }
  }

  // Draw grid lines (subtle)
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x++) {
    ctx.beginPath();
    ctx.moveTo(x * scale, 0);
    ctx.lineTo(x * scale, H * scale);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * scale);
    ctx.lineTo(W * scale, y * scale);
    ctx.stroke();
  }

  // Draw room markers (entrance, boss, treasure, shrine)
  const markers: Array<{ x: number; y: number; color: string; label: string }> = [];
  const ent = d.rooms[d.entranceId];
  markers.push({ x: ent.cx, y: ent.cy, color: '#6a8cff', label: 'E' });
  const boss = d.rooms[d.bossId];
  markers.push({ x: boss.cx, y: boss.cy, color: '#ff3a2a', label: 'B' });
  for (const r of d.rooms) {
    if (r.type === 'treasure') markers.push({ x: r.cx, y: r.cy, color: '#ffd24a', label: 'T' });
    else if (r.type === 'shrine') markers.push({ x: r.cx, y: r.cy, color: '#40d0ff', label: 'S' });
    else if (r.type === 'elite') markers.push({ x: r.cx, y: r.cy, color: '#ff7a3a', label: '!' });
  }
  for (const m of markers) {
    const px = m.x * scale + scale / 2;
    const py = m.y * scale + scale / 2;
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.arc(px, py, scale * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.font = `bold ${scale * 0.3}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(m.label, px, py);
  }

  return canvas;
}

/**
 * Extract wall segments from the grid for UVTT.
 * Each wall cell edge that borders a floor cell becomes a wall segment.
 * Returns array of point pairs (each pair = one wall segment).
 */
function extractWallSegments(d: Dungeon): Array<{ x: number; y: number }> {
  const { W, H, grid } = d;
  const points: Array<{ x: number; y: number }> = [];
  const ppg = PIXELS_PER_GRID;

  // For each wall cell, check its 4 edges. If the neighbor is floor,
  // that edge is a wall segment.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (grid[i] !== WALL) continue;

      const px = x * ppg;
      const py = y * ppg;

      // Top edge: neighbor (x, y-1) is floor
      if (y > 0 && grid[(y - 1) * W + x] === FLOOR) {
        points.push({ x: px, y: py }, { x: px + ppg, y: py });
      }
      // Bottom edge: neighbor (x, y+1) is floor
      if (y < H - 1 && grid[(y + 1) * W + x] === FLOOR) {
        points.push({ x: px, y: py + ppg }, { x: px + ppg, y: py + ppg });
      }
      // Left edge: neighbor (x-1, y) is floor
      if (x > 0 && grid[y * W + (x - 1)] === FLOOR) {
        points.push({ x: px, y: py }, { x: px, y: py + ppg });
      }
      // Right edge: neighbor (x+1, y) is floor
      if (x < W - 1 && grid[y * W + (x + 1)] === FLOOR) {
        points.push({ x: px + ppg, y: py }, { x: px + ppg, y: py + ppg });
      }
    }
  }

  return points;
}

/**
 * Extract portals (doors) from doorways.
 * Each doorway cell becomes a portal in UVTT format.
 */
function extractPortals(d: Dungeon): UVTTPortal[] {
  const ppg = PIXELS_PER_GRID;
  const portals: UVTTPortal[] = [];
  for (const door of d.doorways) {
    portals.push({
      position: {
        x: door.x * ppg + ppg / 2,
        y: door.y * ppg + ppg / 2,
      },
      closed: true,
      freestanding: false,
    });
  }
  return portals;
}

/**
 * Extract light sources from torches, braziers, chandeliers, crystals.
 */
function extractLights(d: Dungeon): UVTTLight[] {
  const ppg = PIXELS_PER_GRID;
  const lights: UVTTLight[] = [];

  // Lit torches (from the litTorchPropIds extension)
  const litTorchPropIds: number[] = (d as any).litTorchPropIds ?? [];
  const litSet = new Set(litTorchPropIds);

  for (let i = 0; i < d.props.length; i++) {
    const p = d.props[i];
    let intensity = 0;
    let color = '#ffffff';
    let range = 0;

    if (p.kind === 'torch' && litSet.has(i)) {
      intensity = 80;
      color = '#ff9a3a';
      range = 15;
    } else if (p.kind === 'brazier') {
      intensity = 100;
      color = '#ff7a2a';
      range = 20;
    } else if (p.kind === 'crystal') {
      intensity = 60;
      color = '#40d0ff';
      range = 12;
    } else if (p.kind === 'portal') {
      intensity = 50;
      color = '#6a8cff';
      range = 10;
    } else if (p.kind === 'chandelier') {
      intensity = 90;
      color = '#ffb060';
      range = 18;
    }

    if (intensity > 0) {
      lights.push({
        position: {
          x: p.x * ppg + ppg / 2,
          y: p.y * ppg + ppg / 2,
        },
        intensity,
        color,
        range,
        shadows: true,
      });
    }
  }

  // Boss room gets a red light
  const boss = d.rooms[d.bossId];
  lights.push({
    position: { x: boss.cx * ppg + ppg / 2, y: boss.cy * ppg + ppg / 2 },
    intensity: 120,
    color: '#ff3a2a',
    range: 25,
    shadows: true,
  });

  return lights;
}

/**
 * Generate a UVTT (.dd2vtt) file and trigger download.
 */
export function downloadUVTT(d: Dungeon) {
  const ppg = PIXELS_PER_GRID;

  // 1. Render top-down map as PNG
  const canvas = renderTopDownMap(d, ppg);
  const dataUrl = canvas.toDataURL('image/png');
  const base64Image = dataUrl.split(',')[1]; // strip "data:image/png;base64,"

  // 2. Extract walls, portals, lights
  const los = extractWallSegments(d);
  const portals = extractPortals(d);
  const lights = extractLights(d);

  // 3. Build UVTT file
  const uvtt: UVTTFile = {
    format: 0.3,
    resolution: {
      map_origin: { x: 0, y: 0 },
      map_size: { rows: d.H, cols: d.W },
      pixels_per_grid: ppg,
    },
    line_of_sight: los,
    port: 1,
    portals,
    lights,
    image: base64Image,
  };

  // 4. Download as .dd2vtt
  const json = JSON.stringify(uvtt);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dungeon-${d.params.seed}-${d.params.theme}.dd2vtt`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Also export just the top-down PNG (for manual import).
 */
export function downloadTopDownPNG(d: Dungeon) {
  const canvas = renderTopDownMap(d, PIXELS_PER_GRID);
  const dataUrl = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `dungeon-${d.params.seed}-${d.params.theme}-topdown.png`;
  a.click();
}
