// uvtt.ts — Universal VTT (.dd2vtt) export for Foundry VTT (Universal Battlemap
// Importer / dd-import). Generates a top-down map PNG + wall/door/light data.
//
// UVTT line_of_sight format (Universal Battlemap Importer 6.x expects this):
//   Array of ARRAYS, where each inner array is a wall segment made of points.
//   A single wall segment = [{x,y}, {x,y}] (start + end).
//   So: [ [p1,p2], [p3,p4] ] = two segments: p1→p2 and p3→p4.
//   A flat array of {x,y} objects will crash dd-import GetWalls().

import {
  Dungeon, FLOOR, WALL, VOID, Prop,
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
  bounds: [{ x: number; y: number }, { x: number; y: number }];
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

// Universal Battlemap Importer expects line_of_sight as an array of wall
// segments, where each segment is itself an array of points [{x,y},{x,y}].
interface UVTTFile {
  format: number;
  resolution: UVTTResolution;
  line_of_sight: Array<Array<{ x: number; y: number }>>;
  port: number;
  portals: UVTTPortal[];
  lights: UVTTLight[];
  image: string;
}

const PIXELS_PER_GRID = 100;

/**
 * Render a top-down map of the dungeon on a canvas.
 * @param includeMarkers If true, draw E/B/T/S markers (for display only, not for Foundry export)
 * @param includeProps If true, draw props (pillars, chests, torches, etc.) as top-down icons
 */
export function renderTopDownMap(
  d: Dungeon,
  scale: number = PIXELS_PER_GRID,
  includeMarkers: boolean = false,
  includeProps: boolean = true,
): HTMLCanvasElement {
  const { W, H, grid } = d;
  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

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
    crypt:    [85, 80, 75],
    cavern:   [76, 62, 48],
    catacomb: [102, 94, 82],
    forge:    [76, 58, 46],
    ice:      [88, 105, 122],
    jungle:   [64, 80, 52],
  };
  const wallColors: Record<string, [number, number, number]> = {
    crypt:    [52, 48, 55],
    cavern:   [50, 38, 30],
    catacomb: [72, 66, 56],
    forge:    [48, 36, 32],
    ice:      [60, 74, 84],
    jungle:   [40, 46, 30],
  };
  const floorBase = themeColors[d.params.theme] ?? themeColors.crypt;
  const wallBase = wallColors[d.params.theme] ?? wallColors.crypt;

  // ---- Pass 1: Fill background (void) ----
  ctx.fillStyle = '#060608';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // ---- Pass 2: Draw floor cells with texture ----
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (grid[i] !== FLOOR) continue;
      const px = x * scale;
      const py = y * scale;

      const rid = owner[i] - 1;
      let r = floorBase[0], g = floorBase[1], b = floorBase[2];
      if (rid >= 0) {
        const t = d.rooms[rid].tint;
        r = Math.round(r * 0.65 + t[0] * 255 * 0.35);
        g = Math.round(g * 0.65 + t[1] * 255 * 0.35);
        b = Math.round(b * 0.65 + t[2] * 255 * 0.35);
      }
      // noise texture
      const n = ((x * 73856093) ^ (y * 19349663) ^ (d.params.seed)) & 0xff;
      const j = (n / 255 - 0.5) * 16;
      r = Math.max(0, Math.min(255, r + j));
      g = Math.max(0, Math.min(255, g + j));
      b = Math.max(0, Math.min(255, b + j));

      // Gradient fill for depth
      const grad = ctx.createLinearGradient(px, py, px + scale, py + scale);
      grad.addColorStop(0, `rgb(${r},${g},${b})`);
      grad.addColorStop(1, `rgb(${Math.max(0, r - 12)},${Math.max(0, g - 12)},${Math.max(0, b - 12)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(px, py, scale, scale);
    }
  }

  // ---- Pass 3: Draw wall cells with 3D-like shading ----
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (grid[i] !== WALL) continue;
      const px = x * scale;
      const py = y * scale;

      const n = ((x * 374761393) ^ (y * 668265263) ^ (d.params.seed ^ 0xa5a5)) & 0xff;
      const j = (n / 255 - 0.5) * 12;
      let r = Math.max(0, Math.min(255, wallBase[0] + j));
      let g = Math.max(0, Math.min(255, wallBase[1] + j));
      let b = Math.max(0, Math.min(255, wallBase[2] + j));

      // Top edge highlight (if floor is above)
      const floorAbove = y > 0 && grid[(y - 1) * W + x] === FLOOR;
      if (floorAbove) {
        r = Math.min(255, r + 30);
        g = Math.min(255, g + 30);
        b = Math.min(255, b + 30);
      }
      // Bottom edge shadow (if floor is below)
      const floorBelow = y < H - 1 && grid[(y + 1) * W + x] === FLOOR;
      if (floorBelow) {
        r = Math.max(0, r - 20);
        g = Math.max(0, g - 20);
        b = Math.max(0, b - 20);
      }

      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(px, py, scale, scale);

      // Inner highlight line on top
      if (floorAbove) {
        ctx.fillStyle = `rgba(255,255,255,0.08)`;
        ctx.fillRect(px, py, scale, 3);
      }
    }
  }

  // ---- Pass 4: Draw props as top-down icons ----
  if (includeProps) {
    for (const p of d.props) {
      if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) continue;
      const px = p.x * scale + scale / 2;
      const py = p.y * scale + scale / 2;
      const s = scale * 0.3; // icon size

      switch (p.kind) {
        case 'pillar':
          ctx.fillStyle = '#7a6a5a';
          ctx.beginPath();
          ctx.arc(px, py, s, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#5a4a3a';
          ctx.lineWidth = 2;
          ctx.stroke();
          break;
        case 'chest':
          ctx.fillStyle = '#8a5a2a';
          ctx.fillRect(px - s, py - s * 0.7, s * 2, s * 1.4);
          ctx.strokeStyle = '#5a3a1a';
          ctx.lineWidth = 2;
          ctx.strokeRect(px - s, py - s * 0.7, s * 2, s * 1.4);
          // lock
          ctx.fillStyle = '#caa030';
          ctx.beginPath();
          ctx.arc(px, py, s * 0.25, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'torch':
          ctx.fillStyle = '#4a3a2a';
          ctx.fillRect(px - s * 0.2, py - s * 0.5, s * 0.4, s);
          ctx.fillStyle = '#ff9a3a';
          ctx.beginPath();
          ctx.arc(px, py - s * 0.6, s * 0.35, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffcc60';
          ctx.beginPath();
          ctx.arc(px, py - s * 0.6, s * 0.2, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'brazier':
          ctx.fillStyle = '#3a2a22';
          ctx.beginPath();
          ctx.arc(px, py, s * 0.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ff7a2a';
          ctx.beginPath();
          ctx.arc(px, py, s * 0.5, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'crystal':
          ctx.fillStyle = '#40d0ff';
          ctx.beginPath();
          ctx.moveTo(px, py - s);
          ctx.lineTo(px + s * 0.7, py);
          ctx.lineTo(px, py + s);
          ctx.lineTo(px - s * 0.7, py);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = '#20a0d0';
          ctx.lineWidth = 2;
          ctx.stroke();
          break;
        case 'portal':
          ctx.strokeStyle = '#6a8cff';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(px, py, s * 1.2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(106,140,255,0.2)';
          ctx.fill();
          break;
        case 'statue':
          ctx.fillStyle = '#8a8a90';
          ctx.fillRect(px - s * 0.4, py - s, s * 0.8, s * 2);
          ctx.strokeStyle = '#5a5a60';
          ctx.lineWidth = 2;
          ctx.strokeRect(px - s * 0.4, py - s, s * 0.8, s * 2);
          break;
        case 'sarcophagus':
          ctx.fillStyle = '#6a6a72';
          ctx.fillRect(px - s * 0.8, py - s * 1.2, s * 1.6, s * 2.4);
          ctx.strokeStyle = '#4a4a52';
          ctx.lineWidth = 2;
          ctx.strokeRect(px - s * 0.8, py - s * 1.2, s * 1.6, s * 2.4);
          break;
        case 'barrel':
          ctx.fillStyle = '#6a4a2a';
          ctx.beginPath();
          ctx.arc(px, py, s * 0.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#4a3a1a';
          ctx.lineWidth = 2;
          ctx.stroke();
          break;
        case 'crate':
          ctx.fillStyle = '#7a5a3a';
          ctx.fillRect(px - s * 0.6, py - s * 0.6, s * 1.2, s * 1.2);
          ctx.strokeStyle = '#5a3a1a';
          ctx.lineWidth = 2;
          ctx.strokeRect(px - s * 0.6, py - s * 0.6, s * 1.2, s * 1.2);
          break;
        case 'bones':
          ctx.fillStyle = '#c8c0a8';
          ctx.beginPath();
          ctx.arc(px, py, s * 0.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#a8a090';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px - s * 0.5, py);
          ctx.lineTo(px + s * 0.5, py);
          ctx.stroke();
          break;
        case 'trap':
          ctx.strokeStyle = '#ff3a3a';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(px - s, py - s);
          ctx.lineTo(px + s, py + s);
          ctx.moveTo(px + s, py - s);
          ctx.lineTo(px - s, py + s);
          ctx.stroke();
          break;
        case 'teleport':
          ctx.strokeStyle = '#dd44ff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, s, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'altar':
          ctx.fillStyle = '#5a6a8a';
          ctx.fillRect(px - s * 0.8, py - s * 0.5, s * 1.6, s);
          ctx.strokeStyle = '#3a4a6a';
          ctx.lineWidth = 2;
          ctx.strokeRect(px - s * 0.8, py - s * 0.5, s * 1.6, s);
          break;
        case 'merchant':
          ctx.fillStyle = '#4a6a3a';
          ctx.fillRect(px - s, py - s * 0.6, s * 2, s * 1.2);
          ctx.strokeStyle = '#2a4a1a';
          ctx.lineWidth = 2;
          ctx.strokeRect(px - s, py - s * 0.6, s * 2, s * 1.2);
          break;
        case 'chandelier':
          ctx.strokeStyle = '#4a3a2a';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, s, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'stairs_down':
          ctx.fillStyle = '#2a2a30';
          ctx.fillRect(px - s, py - s, s * 2, s * 2);
          ctx.strokeStyle = '#1a1a20';
          ctx.lineWidth = 2;
          for (let k = 0; k < 3; k++) {
            ctx.beginPath();
            ctx.moveTo(px - s + k * s * 0.7, py - s);
            ctx.lineTo(px - s + k * s * 0.7, py + s);
            ctx.stroke();
          }
          break;
        case 'stairs_up':
          ctx.fillStyle = '#4a4a50';
          ctx.fillRect(px - s, py - s, s * 2, s * 2);
          ctx.strokeStyle = '#3a3a40';
          ctx.lineWidth = 2;
          for (let k = 0; k < 3; k++) {
            ctx.beginPath();
            ctx.moveTo(px - s, py - s + k * s * 0.7);
            ctx.lineTo(px + s, py - s + k * s * 0.7);
            ctx.stroke();
          }
          break;
        case 'cobweb':
          ctx.strokeStyle = 'rgba(200,200,210,0.3)';
          ctx.lineWidth = 1;
          for (let a = 0; a < 8; a++) {
            const angle = (a / 8) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(px + Math.cos(angle) * s, py + Math.sin(angle) * s);
            ctx.stroke();
          }
          break;
        case 'banner':
          ctx.fillStyle = '#6a2a2a';
          ctx.fillRect(px - s * 0.3, py - s, s * 0.6, s * 2);
          break;
        case 'stalagmite':
          ctx.fillStyle = '#5a4a3a';
          ctx.beginPath();
          ctx.moveTo(px, py - s);
          ctx.lineTo(px + s * 0.5, py + s * 0.5);
          ctx.lineTo(px - s * 0.5, py + s * 0.5);
          ctx.closePath();
          ctx.fill();
          break;
        case 'mushroom':
          ctx.fillStyle = '#8a4a6a';
          ctx.beginPath();
          ctx.arc(px, py - s * 0.2, s * 0.5, 0, Math.PI);
          ctx.fill();
          ctx.fillStyle = '#caa0aa';
          ctx.fillRect(px - s * 0.15, py - s * 0.2, s * 0.3, s * 0.6);
          break;
        case 'icecrystal':
          ctx.fillStyle = '#aaddff';
          ctx.beginPath();
          ctx.moveTo(px, py - s);
          ctx.lineTo(px + s * 0.4, py);
          ctx.lineTo(px, py + s);
          ctx.lineTo(px - s * 0.4, py);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = '#80b0dd';
          ctx.lineWidth = 1;
          ctx.stroke();
          break;
        case 'debris':
          ctx.fillStyle = 'rgba(80,70,60,0.5)';
          for (let k = 0; k < 3; k++) {
            const dx = (k - 1) * s * 0.4;
            ctx.beginPath();
            ctx.arc(px + dx, py, s * 0.2, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        case 'table':
          ctx.fillStyle = '#6a4a2a';
          ctx.fillRect(px - s * 0.9, py - s * 0.5, s * 1.8, s);
          ctx.strokeStyle = '#4a2a1a';
          ctx.lineWidth = 2;
          ctx.strokeRect(px - s * 0.9, py - s * 0.5, s * 1.8, s);
          break;
        case 'chair':
          ctx.fillStyle = '#5a3a1a';
          ctx.fillRect(px - s * 0.3, py - s * 0.3, s * 0.6, s * 0.6);
          break;
        case 'bookshelf':
          ctx.fillStyle = '#3a2a1a';
          ctx.fillRect(px - s * 0.4, py - s, s * 0.8, s * 2);
          ctx.fillStyle = '#8a3a2a';
          ctx.fillRect(px - s * 0.3, py - s * 0.8, s * 0.6, s * 0.15);
          ctx.fillRect(px - s * 0.3, py - s * 0.4, s * 0.6, s * 0.15);
          ctx.fillRect(px - s * 0.3, py, s * 0.6, s * 0.15);
          ctx.fillRect(px - s * 0.3, py + s * 0.4, s * 0.6, s * 0.15);
          break;
        case 'candle':
          ctx.fillStyle = '#dac8a0';
          ctx.fillRect(px - s * 0.1, py - s * 0.2, s * 0.2, s * 0.5);
          ctx.fillStyle = '#ffcc40';
          ctx.beginPath();
          ctx.arc(px, py - s * 0.35, s * 0.15, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'rug':
          ctx.fillStyle = 'rgba(120,40,40,0.35)';
          ctx.fillRect(px - s * 0.9, py - s * 0.6, s * 1.8, s * 1.2);
          ctx.strokeStyle = 'rgba(200,160,80,0.4)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px - s * 0.9, py - s * 0.6, s * 1.8, s * 1.2);
          break;
        case 'pot':
          ctx.fillStyle = '#5a4a3a';
          ctx.beginPath();
          ctx.ellipse(px, py, s * 0.5, s * 0.4, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#3a2a1a';
          ctx.lineWidth = 2;
          ctx.stroke();
          break;
        case 'door': {
          // Draw door as a line across the corridor with a small arch
          const r = p.rot;
          const isHoriz = Math.abs(Math.sin(r)) < 0.5;
          ctx.strokeStyle = '#8a5a2a';
          ctx.lineWidth = 4;
          ctx.beginPath();
          if (isHoriz) {
            ctx.moveTo(px - s * 1.1, py);
            ctx.lineTo(px + s * 1.1, py);
          } else {
            ctx.moveTo(px, py - s * 1.1);
            ctx.lineTo(px, py + s * 1.1);
          }
          ctx.stroke();
          // door frame knobs
          ctx.fillStyle = '#caa050';
          if (isHoriz) {
            ctx.beginPath(); ctx.arc(px - s * 1.1, py, 2, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(px + s * 1.1, py, 2, 0, Math.PI * 2); ctx.fill();
          } else {
            ctx.beginPath(); ctx.arc(px, py - s * 1.1, 2, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(px, py + s * 1.1, 2, 0, Math.PI * 2); ctx.fill();
          }
          break;
        }
      }
    }

    // Draw spawn markers (small colored dots)
    for (const s of d.spawns) {
      if (s.x < 0 || s.y < 0 || s.x >= W || s.y >= H) continue;
      const px = s.x * scale + scale / 2;
      const py = s.y * scale + scale / 2;
      const colors = ['#88ff88', '#ffcc44', '#ff5544', '#ff2222'];
      ctx.fillStyle = colors[s.tier] ?? '#888';
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.arc(px, py, scale * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // ---- Pass 5: Grid lines (very subtle) ----
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
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

  // ---- Pass 6: Room markers (only if includeMarkers=true, NOT for Foundry export) ----
  if (includeMarkers) {
    const markers: Array<{ x: number; y: number; color: string; label: string }> = [];
    const ent = d.rooms[d.entranceId];
    markers.push({ x: ent.cx, y: ent.cy, color: '#6a8cff', label: 'В' });
    const boss = d.rooms[d.bossId];
    markers.push({ x: boss.cx, y: boss.cy, color: '#ff3a2a', label: 'Б' });
    for (const r of d.rooms) {
      if (r.type === 'treasure') markers.push({ x: r.cx, y: r.cy, color: '#ffd24a', label: 'С' });
      else if (r.type === 'shrine') markers.push({ x: r.cx, y: r.cy, color: '#40d0ff', label: 'Х' });
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
  }

  return canvas;
}

/**
 * Extract wall segments for UVTT.
 * Universal Battlemap Importer expects line_of_sight as an array of wall
 * segments, where each segment is an array of points [{x,y},{x,y}].
 * Returns: [ [{x,y},{x,y}], [{x,y},{x,y}], ... ]
 */
function extractWallSegments(d: Dungeon): Array<Array<{ x: number; y: number }>> {
  const { W, H, grid } = d;
  const walls: Array<Array<{ x: number; y: number }>> = [];
  const ppg = PIXELS_PER_GRID;

  // For each WALL cell, emit a wall segment along every edge that borders a
  // FLOOR cell. These are the perimeter walls. Doors live in the open passages
  // (portal bounds) and are added separately — we do NOT punch gaps here.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (grid[i] !== WALL) continue;

      const px = x * ppg;
      const py = y * ppg;

      // Top edge: floor above
      if (y > 0 && grid[(y - 1) * W + x] === FLOOR) {
        walls.push([{ x: px, y: py }, { x: px + ppg, y: py }]);
      }
      // Bottom edge: floor below
      if (y < H - 1 && grid[(y + 1) * W + x] === FLOOR) {
        walls.push([{ x: px, y: py + ppg }, { x: px + ppg, y: py + ppg }]);
      }
      // Left edge: floor to the left
      if (x > 0 && grid[y * W + (x - 1)] === FLOOR) {
        walls.push([{ x: px, y: py }, { x: px, y: py + ppg }]);
      }
      // Right edge: floor to the right
      if (x < W - 1 && grid[y * W + (x + 1)] === FLOOR) {
        walls.push([{ x: px + ppg, y: py }, { x: px + ppg, y: py + ppg }]);
      }
    }
  }

  return walls;
}

/**
 * Extract portals (doors) from door props. Each door prop has a rotation that
 * tells us which way the corridor runs:
 *   rot ≈ 0  → door in an east-west wall (corridor runs north-south) → bounds horizontal
 *   rot ≈ π/2 → door in a north-south wall (corridor runs east-west) → bounds vertical
 * The `bounds` field (two endpoints) is REQUIRED by Universal Battlemap Importer.
 */
function extractPortals(d: Dungeon): UVTTPortal[] {
  const ppg = PIXELS_PER_GRID;
  const portals: UVTTPortal[] = [];
  const doors = d.props.filter((p) => p.kind === 'door');
  for (const door of doors) {
    const cx = door.x * ppg + ppg / 2;
    const cy = door.y * ppg + ppg / 2;
    const r = ((door.rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const isHorizontal = r < Math.PI / 4 || r > (7 * Math.PI) / 4 || (r > (3 * Math.PI) / 4 && r < (5 * Math.PI) / 4);
    const bounds: [{ x: number; y: number }, { x: number; y: number }] = isHorizontal
      ? [{ x: door.x * ppg, y: cy }, { x: (door.x + 1) * ppg, y: cy }]
      : [{ x: cx, y: door.y * ppg }, { x: cx, y: (door.y + 1) * ppg }];
    portals.push({
      position: { x: cx, y: cy },
      bounds,
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
  const litTorchPropIds: number[] = (d as any).litTorchPropIds ?? [];
  const litSet = new Set(litTorchPropIds);

  for (let i = 0; i < d.props.length; i++) {
    const p = d.props[i];
    let intensity = 0;
    let color = '#ffffff';
    let range = 0;

    if (p.kind === 'torch' && litSet.has(i)) {
      intensity = 0.8; color = '#ff9a3a'; range = 15;
    } else if (p.kind === 'brazier') {
      intensity = 1.0; color = '#ff7a2a'; range = 20;
    } else if (p.kind === 'crystal') {
      intensity = 0.6; color = '#40d0ff'; range = 12;
    } else if (p.kind === 'portal') {
      intensity = 0.5; color = '#6a8cff'; range = 10;
    } else if (p.kind === 'chandelier') {
      intensity = 0.9; color = '#ffb060'; range = 18;
    }

    if (intensity > 0) {
      lights.push({
        position: { x: p.x * ppg + ppg / 2, y: p.y * ppg + ppg / 2 },
        intensity, color, range, shadows: true,
      });
    }
  }

  const boss = d.rooms[d.bossId];
  lights.push({
    position: { x: boss.cx * ppg + ppg / 2, y: boss.cy * ppg + ppg / 2 },
    intensity: 1.2, color: '#ff3a2a', range: 25, shadows: true,
  });

  return lights;
}

/**
 * Generate a UVTT (.dd2vtt) file and trigger download.
 * No markers, includes props, for Foundry import.
 */
export function downloadUVTT(d: Dungeon) {
  const ppg = PIXELS_PER_GRID;

  // Render map WITHOUT markers (Foundry doesn't need them)
  const canvas = renderTopDownMap(d, ppg, false, true);
  const dataUrl = canvas.toDataURL('image/png');
  const base64Image = dataUrl.split(',')[1];

  const los = extractWallSegments(d);
  const portals = extractPortals(d);
  const lights = extractLights(d);

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
 * Export top-down PNG with markers (for display).
 */
export function downloadTopDownPNG(d: Dungeon) {
  const canvas = renderTopDownMap(d, PIXELS_PER_GRID, true, true);
  const dataUrl = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `dungeon-${d.params.seed}-${d.params.theme}-topdown.png`;
  a.click();
}

/**
 * Export top-down PNG WITHOUT markers and WITH props (for Foundry manual import).
 */
export function downloadTopDownPNGClean(d: Dungeon) {
  const canvas = renderTopDownMap(d, PIXELS_PER_GRID, false, true);
  const dataUrl = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `dungeon-${d.params.seed}-${d.params.theme}-clean.png`;
  a.click();
}
