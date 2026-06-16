import { GRID_COLS, GRID_ROWS, GRID_STEP, ROAD, MARGIN, WORLD_WIDTH, WORLD_HEIGHT } from '../config.js';

// Navigation graph of the city's road network. Nodes sit at every road
// intersection; edges connect 4-neighbours along the streets. Cops pathfind
// over this graph (BFS) and steer toward the next waypoint so they follow the
// roads instead of beelining through buildings.
//
// The lattice lines fall in the road gaps: for a column/row index i, the road
// centreline is at MARGIN + i*GRID_STEP - ROAD/2. Buildings are left-aligned and
// never wider than BLOCK, so these lines always land on drivable road (alleys
// included — they're just narrower roads).
export class NavGrid {
  constructor() {
    // Node lines: the interior road centrelines (i = 1..n-1) PLUS a perimeter ring on
    // the drivable margin lane that runs around the world edge. The perimeter nodes sit
    // at MARGIN/2 from each wall (centred in the edge lane), so a cop can chase/search
    // along the very edge instead of targeting a node through the outer buildings and
    // wedging. Each margin lane connects cleanly to every interior road, so the ring is
    // just the outer row/column of an otherwise-uniform lattice.
    this.xs = [MARGIN / 2];
    for (let i = 1; i < GRID_COLS; i++) this.xs.push(MARGIN + i * GRID_STEP - ROAD / 2);
    this.xs.push(WORLD_WIDTH - MARGIN / 2);

    this.ys = [MARGIN / 2];
    for (let j = 1; j < GRID_ROWS; j++) this.ys.push(MARGIN + j * GRID_STEP - ROAD / 2);
    this.ys.push(WORLD_HEIGHT - MARGIN / 2);

    this.cols = this.xs.length;
    this.rows = this.ys.length;
  }

  index(i, j) { return j * this.cols + i; }
  ij(idx)     { return { i: idx % this.cols, j: Math.floor(idx / this.cols) }; }
  pos(idx)    { const { i, j } = this.ij(idx); return { x: this.xs[i], y: this.ys[j] }; }

  // Nearest lattice node to a world position
  nearestNode(x, y) {
    let bi = 0, bj = 0, bdx = Infinity, bdy = Infinity;
    for (let i = 0; i < this.cols; i++) {
      const d = Math.abs(this.xs[i] - x);
      if (d < bdx) { bdx = d; bi = i; }
    }
    for (let j = 0; j < this.rows; j++) {
      const d = Math.abs(this.ys[j] - y);
      if (d < bdy) { bdy = d; bj = j; }
    }
    return this.index(bi, bj);
  }

  // Nearest node to (px,py) that lies AHEAD of origin (ox,oy) along direction
  // `dir` — i.e. its offset from the origin has a positive component along dir.
  // Used so the hunt prediction snaps forward of where the player was last seen,
  // never to a node behind their travel direction. Falls back to nearestNode.
  nearestNodeAhead(px, py, ox, oy, dir) {
    const dx = Math.cos(dir), dy = Math.sin(dir);
    let best = -1, bestD = Infinity;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const nx = this.xs[i], ny = this.ys[j];
        if ((nx - ox) * dx + (ny - oy) * dy < 0) continue; // behind the origin
        const d = (nx - px) * (nx - px) + (ny - py) * (ny - py);
        if (d < bestD) { bestD = d; best = this.index(i, j); }
      }
    }
    return best >= 0 ? best : this.nearestNode(px, py);
  }

  // BFS shortest path (in node count) from start to goal. Returns an array of
  // node indices including both endpoints, or [start] if already there.
  findPath(start, goal) {
    if (start === goal) return [start];

    const visited = new Uint8Array(this.cols * this.rows);
    const prev    = new Int32Array(this.cols * this.rows).fill(-1);
    const queue   = [start];
    visited[start] = 1;

    while (queue.length) {
      const cur = queue.shift();
      if (cur === goal) break;

      const { i, j } = this.ij(cur);
      const neighbours = [];
      if (i > 0)             neighbours.push(this.index(i - 1, j));
      if (i < this.cols - 1) neighbours.push(this.index(i + 1, j));
      if (j > 0)             neighbours.push(this.index(i, j - 1));
      if (j < this.rows - 1) neighbours.push(this.index(i, j + 1));

      for (const n of neighbours) {
        if (!visited[n]) {
          visited[n] = 1;
          prev[n] = cur;
          queue.push(n);
        }
      }
    }

    // Reconstruct
    const path = [];
    let node = goal;
    while (node !== -1) {
      path.unshift(node);
      if (node === start) break;
      node = prev[node];
    }
    return path;
  }

  // Node indices within maxDepth steps of `start`, in BFS (outward) order,
  // excluding the start itself. Used to build a search sweep radiating from a
  // last-known position.
  nodesInRange(start, maxDepth) {
    const visited = new Uint8Array(this.cols * this.rows);
    const depth   = new Int32Array(this.cols * this.rows);
    const queue   = [start];
    visited[start] = 1;
    const result = [];

    while (queue.length) {
      const cur = queue.shift();
      if (cur !== start) result.push(cur);
      if (depth[cur] >= maxDepth) continue;

      const { i, j } = this.ij(cur);
      const neighbours = [];
      if (i > 0)             neighbours.push(this.index(i - 1, j));
      if (i < this.cols - 1) neighbours.push(this.index(i + 1, j));
      if (j > 0)             neighbours.push(this.index(i, j - 1));
      if (j < this.rows - 1) neighbours.push(this.index(i, j + 1));

      for (const n of neighbours) {
        if (!visited[n]) {
          visited[n] = 1;
          depth[n] = depth[cur] + 1;
          queue.push(n);
        }
      }
    }
    return result;
  }
}
