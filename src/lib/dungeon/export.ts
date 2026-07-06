// export.ts — Export dungeon data to JSON or Tiled format.
// Pure data: NO THREE imports.

import { Dungeon, ExportData, Params, FLOOR, WALL, VOID } from './types';

export function exportDungeon(d: Dungeon, format: 'dungeon-json' | 'tiled'): ExportData {
  const base: ExportData = {
    format,
    version: 1,
    params: { ...d.params },
    name: d.name,
    level: d.stats.level ?? 0,
    width: d.W,
    height: d.H,
    grid: Array.from(d.grid),
    rooms: d.rooms.map((r) => ({
      id: r.id, cx: r.cx, cy: r.cy, w: r.w, h: r.h,
      shape: r.shape, type: r.type,
      depth: r.depth, difficulty: r.difficulty,
    })),
    props: d.props.map((p) => ({
      kind: p.kind, x: p.x, y: p.y, rot: p.rot, scale: p.scale, roomId: p.roomId,
    })),
    spawns: d.spawns.map((s) => ({
      x: s.x, y: s.y, tier: s.tier, roomId: s.roomId,
    })),
    events: d.events.map((e) => ({
      type: e.type, x: e.x, y: e.y, roomId: e.roomId, data: e.data,
    })),
    entranceId: d.entranceId,
    bossId: d.bossId,
  };

  if (format === 'tiled') {
    // Tiled format: layers for floor, walls, props
    const floorLayer = new Array(d.W * d.H).fill(0);
    const wallLayer = new Array(d.W * d.H).fill(0);
    for (let i = 0; i < d.grid.length; i++) {
      if (d.grid[i] === FLOOR) floorLayer[i] = 1;
      else if (d.grid[i] === WALL) wallLayer[i] = 2;
    }
    base.tiled = {
      layers: [
        { name: 'Floor', data: floorLayer, width: d.W, height: d.H },
        { name: 'Walls', data: wallLayer, width: d.W, height: d.H },
      ],
      tilesets: [
        { name: 'dungeon_tiles', tilewidth: 16, tileheight: 16 },
      ],
    };
  }

  return base;
}

export function downloadExport(d: Dungeon, format: 'dungeon-json' | 'tiled') {
  const data = exportDungeon(d, format);
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dungeon-${d.params.seed}-${format === 'tiled' ? 'tiled' : 'json'}-level${d.stats.level ?? 0}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
