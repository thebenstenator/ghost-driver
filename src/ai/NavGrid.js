import { navLines } from '../config.js';
import { BUILDINGS } from '../world/city.js';

// Navigation graph of the city's road network. Nodes sit on a lattice (road
// centrelines + a perimeter ring); edges connect 4-neighbours. Cops pathfind over
// this graph (BFS) and steer toward the next waypoint so they follow the roads
// instead of beelining through buildings.
//
// ── EDGE-AWARE (read before editing) ─────────────────────────────────────────────────
// Connectivity is DERIVED FROM GEOMETRY, not assumed. At construction we test every node
// and every lattice segment against the building rectangles:
//   • a node is VALID only if it isn't inside a building (a superblock swallows it), and
//   • an edge exists only if the road segment between two valid nodes is CLEAR.
// So the graph reflects the actual streets: superblocks prune nodes, deleted road segments
// prune edges (dead-ends, T-junctions), and cops can never be routed across a wall. This
// replaces the OLD "assume the full lattice is drivable" invariant — which only held because
// every building stayed inside its cell envelope. That assumption is no longer required:
// districts may lay out any block pattern they like, and nav stays correct.
//
// On the current uniform city this produces the SAME graph the assumed-full lattice did
// (every node sits ≥64px from any building; every segment — alleys included, whose
// centrelines stay clear by ≥32px — is clear), so behaviour is unchanged. The margins below
// are deliberately small (< the 32px alley half-gap) so narrow drivable lanes survive.
//
// The lattice lines fall in the road gaps: for a column/row index i, the road centreline is
// at MARGIN + i*GRID_STEP - ROAD/2, plus a perimeter ring on the drivable margin lane.

const NODE_MARGIN = 8; // a node this far inside a building counts as swallowed (invalid)
const EDGE_MARGIN = 8; // a building this close to a segment's centreline blocks the edge

// Point/segment vs axis-aligned rects. Every nav segment is axis-aligned, so the segment's
// bounding box IS the segment — this AABB-overlap test is exact (not conservative).
function blocked(ax, ay, bx, by, rects, m) {
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  for (const r of rects) {
    if (r.x - m < x1 && r.x + r.w + m > x0 && r.y - m < y1 && r.y + r.h + m > y0) return true;
  }
  return false;
}

export class NavGrid {
  // opts (all optional — default builds the live city):
  //   xs, ys : lattice line positions (override for tests/other maps)
  //   rects  : obstacle rectangles {x,y,w,h} (default: the city's BUILDINGS)
  constructor(opts = {}) {
    if (opts.xs && opts.ys) {
      this.xs = opts.xs.slice();
      this.ys = opts.ys.slice();
    } else {
      // The shared city lattice (interior road centrelines + a perimeter ring on the drivable
      // margin lane), so a cop can chase/search along the very edge instead of wedging.
      const { xs, ys } = navLines();
      this.xs = xs;
      this.ys = ys;
    }

    this.cols = this.xs.length;
    this.rows = this.ys.length;

    const rects = opts.rects || BUILDINGS;
    this._buildConnectivity(rects);
  }

  // Derive node validity + the neighbour adjacency from obstacle geometry (once, at build).
  _buildConnectivity(rects) {
    const n = this.cols * this.rows;
    this.valid = new Uint8Array(n);
    this.nbr = new Array(n);

    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const idx = this.index(i, j);
        this.valid[idx] = blocked(this.xs[i], this.ys[j], this.xs[i], this.ys[j], rects, NODE_MARGIN)
          ? 0 : 1;
      }
    }

    // Neighbours enumerated in the fixed order left, right, up, down — the SAME order the old
    // assumed-full lattice used, so BFS breaks equal-length ties identically (a bit-for-bit
    // no-op on the current map). Each edge is re-tested from both ends; cheap and order-exact.
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const idx = this.index(i, j);
        const list = [];
        if (this.valid[idx]) {
          if (i > 0)             this._link(idx, this.index(i - 1, j), rects, list);
          if (i < this.cols - 1) this._link(idx, this.index(i + 1, j), rects, list);
          if (j > 0)             this._link(idx, this.index(i, j - 1), rects, list);
          if (j < this.rows - 1) this._link(idx, this.index(i, j + 1), rects, list);
        }
        this.nbr[idx] = list;
      }
    }
  }

  // Push b onto a's neighbour list iff b is a valid node reachable by a clear road segment.
  _link(a, b, rects, aList) {
    if (!this.valid[b]) return;
    const pa = this.pos(a), pb = this.pos(b);
    if (blocked(pa.x, pa.y, pb.x, pb.y, rects, EDGE_MARGIN)) return;
    aList.push(b);
  }

  index(i, j) { return j * this.cols + i; }
  ij(idx)     { return { i: idx % this.cols, j: Math.floor(idx / this.cols) }; }
  pos(idx)    { const { i, j } = this.ij(idx); return { x: this.xs[i], y: this.ys[j] }; }

  // Nearest VALID lattice node to a world position. Fast path: the separable nearest (nearest
  // column ∩ nearest row) is valid in the common case (a cop on open road) — O(cols+rows). Only
  // when that lands inside a building (a target snapped onto a superblock) do we scan for the
  // nearest valid node by true distance.
  nearestNode(x, y) {
    let bi = 0, bj = 0, bdx = Infinity, bdy = Infinity;
    for (let i = 0; i < this.cols; i++) { const d = Math.abs(this.xs[i] - x); if (d < bdx) { bdx = d; bi = i; } }
    for (let j = 0; j < this.rows; j++) { const d = Math.abs(this.ys[j] - y); if (d < bdy) { bdy = d; bj = j; } }
    const sep = this.index(bi, bj);
    if (this.valid[sep]) return sep;

    let best = -1, bestD = Infinity;
    for (let idx = 0; idx < this.valid.length; idx++) {
      if (!this.valid[idx]) continue;
      const p = this.pos(idx);
      const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
      if (d < bestD) { bestD = d; best = idx; }
    }
    return best >= 0 ? best : sep; // sep is invalid too, but it's the best we have
  }

  // Nearest VALID node to (px,py) that lies AHEAD of origin (ox,oy) along `dir` — its offset
  // from the origin has a positive component along dir. Used so hunt prediction snaps forward
  // of where the player was last seen, never behind their travel. Falls back to nearestNode.
  nearestNodeAhead(px, py, ox, oy, dir) {
    const dx = Math.cos(dir), dy = Math.sin(dir);
    let best = -1, bestD = Infinity;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const idx = this.index(i, j);
        if (!this.valid[idx]) continue;
        const nx = this.xs[i], ny = this.ys[j];
        if ((nx - ox) * dx + (ny - oy) * dy < 0) continue; // behind the origin
        const d = (nx - px) * (nx - px) + (ny - py) * (ny - py);
        if (d < bestD) { bestD = d; best = idx; }
      }
    }
    return best >= 0 ? best : this.nearestNode(px, py);
  }

  // Walk the road graph from the node nearest (px,py), each hop taking the neighbour best
  // ALIGNED with `dir` (must be genuinely forward — positive dot), until at least `dist` px are
  // covered or the road stops heading that way. Returns { idx, heading, covered } where heading
  // is the direction of the final hop (axis-aligned on the lattice). Used to place a roadblock
  // on the road the traveller is ACTUALLY on, ahead of them — unlike nearestNode(projectedPoint),
  // which snaps to whatever node is geometrically closest and often lands on a side street.
  nodeAlongHeading(px, py, dir, dist) {
    const dx = Math.cos(dir), dy = Math.sin(dir);
    let cur = this.nearestNode(px, py);
    let covered = 0, heading = dir;
    const guard = this.cols + this.rows; // a walk can't exceed the lattice span
    for (let steps = 0; steps < guard && covered < dist; steps++) {
      const cp = this.pos(cur);
      let best = -1, bestDot = 1e-3; // require a meaningfully-forward hop, never sideways/back
      for (const nb of this.nbr[cur]) {
        const np = this.pos(nb);
        const ex = np.x - cp.x, ey = np.y - cp.y, len = Math.hypot(ex, ey) || 1;
        const dot = (ex / len) * dx + (ey / len) * dy;
        if (dot > bestDot) { bestDot = dot; best = nb; }
      }
      if (best < 0) break; // road doesn't continue forward — stop at the last node reached
      const np = this.pos(best);
      heading = Math.atan2(np.y - cp.y, np.x - cp.x);
      covered += Math.hypot(np.x - cp.x, np.y - cp.y);
      cur = best;
    }
    return { idx: cur, heading, covered };
  }

  // BFS shortest path (in node count) from start to goal over real edges. Returns an array of
  // node indices including both endpoints, [start] if already there, or [start] if unreachable
  // (goal walled off) — callers treat a path that never arrives as "can't get there from here".
  findPath(start, goal) {
    if (start === goal) return [start];

    const n = this.cols * this.rows;
    const visited = new Uint8Array(n);
    const prev    = new Int32Array(n).fill(-1);
    const queue   = [start];
    visited[start] = 1;
    let reached = false;

    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (cur === goal) { reached = true; break; }
      for (const nb of this.nbr[cur]) {
        if (!visited[nb]) { visited[nb] = 1; prev[nb] = cur; queue.push(nb); }
      }
    }

    if (!reached) return [start]; // goal unreachable over the road graph

    const path = [];
    let node = goal;
    while (node !== -1) {
      path.unshift(node);
      if (node === start) break;
      node = prev[node];
    }
    return path;
  }

  // Node indices within maxDepth steps of `start` over real edges, in BFS (outward) order,
  // excluding start. Used to build a search sweep radiating from a last-known position.
  nodesInRange(start, maxDepth) {
    const n = this.cols * this.rows;
    const visited = new Uint8Array(n);
    const depth   = new Int32Array(n);
    const queue   = [start];
    visited[start] = 1;
    const result = [];

    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (cur !== start) result.push(cur);
      if (depth[cur] >= maxDepth) continue;
      for (const nb of this.nbr[cur]) {
        if (!visited[nb]) { visited[nb] = 1; depth[nb] = depth[cur] + 1; queue.push(nb); }
      }
    }
    return result;
  }
}
