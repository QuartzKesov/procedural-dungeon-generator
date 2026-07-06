// Smoke test for the generator — run with: bun run scripts/dungeon-smoke.ts
import { generateDungeon } from '../src/lib/dungeon/generator';
import { runAcceptanceTests, printTestReport } from '../src/lib/dungeon/tests';
import { DEFAULT_PARAMS } from '../src/lib/dungeon/types';

const d = generateDungeon(DEFAULT_PARAMS);
console.log('Name:', d.name);
console.log(`Grid: ${d.W}x${d.H}, rooms=${d.rooms.length}, edges=${d.edges.length}, loops=${d.stats.loops}`);
console.log(`entrance=${d.entranceId} (deg ${d.rooms[d.entranceId].degree}), boss=${d.bossId}`);
console.log(`types:`, d.rooms.reduce((m, r) => { m[r.type] = (m[r.type]||0)+1; return m; }, {} as Record<string, number>));
console.log(`floor=${d.stats.floorTiles} wall=${d.stats.wallTiles} props=${d.stats.props} spawns=${d.stats.spawns} lights=${d.stats.lights}`);
console.log(`genMs=${d.stats.genMs.toFixed(2)} checksum=${d.stats.checksum.toString(16)}`);
console.log(`maxDepth=${d.stats.maxDepth} bossDepth=${d.rooms[d.bossId].depth} criticalLen=${d.stats.criticalLength}`);

const report = runAcceptanceTests(DEFAULT_PARAMS);
printTestReport(report);
