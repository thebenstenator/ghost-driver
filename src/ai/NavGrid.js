import { GRID_COLS, GRID_ROWS, GRID_STEP, ROAD, MARGIN } from '../config.js';

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
    this.cols = GRID_COLS + 1; // n blocks → n+1 road lines
    this.rows = GRID_ROWS + 1;

    this.xs = [];
    for (let i = 0; i < this.cols; i++) this.xs.push(MARGIN + i * GRID_STEP - ROAD / 2);
    this.ys = [];
    for (let j = 0; j < this.rows; j++) this.ys.push(MARGIN + j * GRID_STEP - ROAD / 2);
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
