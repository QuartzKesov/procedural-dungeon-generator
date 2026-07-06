// geometry.ts — Pure-data computational geometry primitives.
// NO THREE imports. Everything deterministic given input order.

export interface Pt { x: number; y: number; }

// ---- Bowyer–Watson Delaunay ----------------------------------------------
// Produces the set of Delaunay edges (undirected, deduped) for a point set.
// Deterministic: iterates points in array order; edge dedup via sorted key.

interface Tri { a: number; b: number; c: number; }

// Robust in-circle predicate (exact-ish with doubles). Returns true if d is
// inside the circumcircle of triangle (a,b,c). Orientation-aware: the sign of
// the determinant flips with triangle winding, so we divide it out.
function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
function inCircle(ax: number, ay: number, bx: number, by: number,
                  cx: number, cy: number, dx: number, dy: number): boolean {
  const o = orient(ax, ay, bx, by, cx, cy);
  if (o === 0) return false; // degenerate triangle — treat as not-in-circle
  const ax_ = ax - dx, ay_ = ay - dy;
  const bx_ = bx - dx, by_ = by - dy;
  const cx_ = cx - dx, cy_ = cy - dy;
  const det =
    (ax_ * ax_ + ay_ * ay_) * (bx_ * cy_ - cx_ * by_) -
    (bx_ * bx_ + by_ * by_) * (ax_ * cy_ - cx_ * ay_) +
    (cx_ * cx_ + cy_ * cy_) * (ax_ * by_ - bx_ * ay_);
  // For CCW (o>0): inside iff det>0. For CW (o<0): inside iff det<0.
  // Equivalent: inside iff det and o share the same sign.
  return (det > 0) === (o > 0);
}

export function delaunayEdges(points: Pt[]): Array<[number, number]> {
  const n = points.length;
  if (n < 2) return [];
  if (n === 2) return [[0, 1]];

  // Super-triangle: huge, encloses all points.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const dx = (maxX - minX) || 1;
  const dy = (maxY - minY) || 1;
  const dmax = Math.max(dx, dy) * 20;
  const midx = (minX + maxX) * 0.5;
  const midy = (minY + maxY) * 0.5;
  // Super-triangle vertices live at indices n, n+1, n+2.
  const st: Pt[] = [
    { x: midx - 20 * dmax, y: midy - dmax },
    { x: midx, y: midy + 20 * dmax },
    { x: midx + 20 * dmax, y: midy - dmax },
  ];
  const all: Pt[] = points.concat(st);

  let tris: Tri[] = [{ a: n, b: n + 1, c: n + 2 }];

  for (let i = 0; i < n; i++) {
    const p = all[i];
    const bad: Tri[] = [];
    // Collect triangles whose circumcircle contains p.
    for (const t of tris) {
      const ta = all[t.a], tb = all[t.b], tc = all[t.c];
      if (inCircle(ta.x, ta.y, tb.x, tb.y, tc.x, tc.y, p.x, p.y)) bad.push(t);
    }
    // Find boundary edges of the bad-triangle polygon: edges appearing once.
    const edgeCount = new Map<string, { a: number; b: number; count: number }>();
    for (const t of bad) {
      const es: Array<[number, number]> = [
        [t.a, t.b], [t.b, t.c], [t.c, t.a],
      ];
      for (const [u, v] of es) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        const e = edgeCount.get(key);
        if (e) e.count++;
        else edgeCount.set(key, { a: u, b: v, count: 1 });
      }
    }
    // Boundary = count===1. Iterate in a stable order (sort by key).
    const boundaryKeys = Array.from(edgeCount.keys()).sort();
    // Remove bad triangles.
    const badSet = new Set(bad);
    tris = tris.filter((t) => !badSet.has(t));
    // Add new triangles from each boundary edge to p (index i).
    for (const key of boundaryKeys) {
      const e = edgeCount.get(key)!;
      if (e.count === 1) {
        tris.push({ a: e.a, b: e.b, c: i });
      }
    }
  }

  // Extract unique edges, dropping any that touch the super-triangle vertices.
  const edgeSet = new Set<string>();
  const edges: Array<[number, number]> = [];
  for (const t of tris) {
    if (t.a >= n || t.b >= n || t.c >= n) continue; // touches super-tri
    const es: Array<[number, number]> = [
      [t.a, t.b], [t.b, t.c], [t.c, t.a],
    ];
    for (const [u, v] of es) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push(u < v ? [u, v] : [v, u]);
      }
    }
  }
  return edges;
}

// ---- Prim MST ------------------------------------------------------------
// Returns the MST as a list of [u,v] edges. Ties broken by (u,v) lexical order
// so the result is deterministic given the same edge list.
export function primMst(n: number, edges: Array<[number, number]>): Array<[number, number]> {
  if (n <= 1) return [];
  // Build adjacency with weights = euclidean-free index (we'll compute from a
  // provided coord array externally; here we just use the order the caller
  // gives). Caller passes weighted edges via the parallel `weights` array.
  // To keep the API simple, we accept that the caller pre-sorts edges.
  // We reimplement below accepting coords.
  return primMstWeighted(n, edges, edges.map(() => 1));
}

export function primMstWeighted(
  n: number,
  edges: Array<[number, number]>,
  weights: number[],
): Array<[number, number]> {
  if (n <= 1) return [];
  const adj: Array<Array<{ to: number; w: number; ei: number }>> = Array.from({ length: n }, () => []);
  for (let i = 0; i < edges.length; i++) {
    const [u, v] = edges[i];
    const w = weights[i];
    adj[u].push({ to: v, w, ei: i });
    adj[v].push({ to: u, w, ei: i });
  }
  const inMst = new Uint8Array(n);
  const used = new Uint8Array(edges.length);
  // Best crossing edge per node outside the tree.
  const best = new Float64Array(n).fill(Infinity);
  const bestEdge = new Int32Array(n).fill(-1);
  best[0] = 0;
  const mst: Array<[number, number]> = [];
  // O(n^2) Prim — fine for n up to a few hundred rooms. Deterministic: when
  // multiple nodes share the best key, pick the lowest index.
  for (let added = 0; added < n; added++) {
    let u = -1;
    let bestKey = Infinity;
    for (let i = 0; i < n; i++) {
      if (!inMst[i] && best[i] < bestKey) {
        bestKey = best[i];
        u = i;
      }
    }
    if (u === -1) break; // disconnected
    inMst[u] = 1;
    const ei = bestEdge[u];
    if (ei >= 0) {
      used[ei] = 1;
      mst.push(edges[ei]);
    }
    for (const e of adj[u]) {
      if (!inMst[e.to] && e.w < best[e.to]) {
        best[e.to] = e.w;
        bestEdge[e.to] = e.ei;
      }
    }
  }
  return mst;
}

// ---- BFS over an adjacency list ------------------------------------------
// Returns distance array (Infinity if unreachable) and the predecessor array.
export function bfs(
  n: number,
  adj: Array<number[]>,
  src: number,
): { dist: Int32Array; prev: Int32Array } {
  const dist = new Int32Array(n).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  dist[src] = 0;
  const queue = [src];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    for (const v of adj[u]) {
      if (dist[v] === -1) {
        dist[v] = dist[u] + 1;
        prev[v] = u;
        queue.push(v);
      }
    }
  }
  return { dist, prev };
}

// ---- 2D grid flood fill (4-conn) for connectivity validation -------------
// Returns number of reachable floor cells starting from (sx,sy). `grid` uses
// 0=void, nonzero=floor-ish (caller decides which codes count as passable).
export function gridFloodCount(
  grid: Uint8Array, W: number, H: number,
  sx: number, sy: number, passable: (v: number) => boolean,
): number {
  const start = sy * W + sx;
  if (!passable(grid[start])) return 0;
  const seen = new Uint8Array(W * H);
  seen[start] = 1;
  const stack = [start];
  let count = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    count++;
    const cx = cur % W;
    const cy = (cur / W) | 0;
    const ns = [
      cx > 0 ? cur - 1 : -1,
      cx < W - 1 ? cur + 1 : -1,
      cy > 0 ? cur - W : -1,
      cy < H - 1 ? cur + W : -1,
    ];
    for (const ni of ns) {
      if (ni >= 0 && !seen[ni] && passable(grid[ni])) {
        seen[ni] = 1;
        stack.push(ni);
      }
    }
  }
  return count;
}
