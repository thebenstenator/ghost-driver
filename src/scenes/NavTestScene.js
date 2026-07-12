import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../config.js';
import { NavGrid } from '../ai/NavGrid.js';

// DEV-ONLY visual proof of the EDGE-AWARE NavGrid (see src/ai/NavGrid.js). Nothing in the real
// game imports it; reachable only via the "🧭 nav test" dev-menu entry. It builds a NavGrid on a
// hand-carved mini-city — a superblock that swallows nodes, blocks that carve detours, and a
// deliberately walled-off (unreachable) node — then renders the DERIVED graph: valid nodes,
// pruned nodes, real edges. Click to watch it pathfind (BFS) around the obstacles; a marker
// animates the route. This is the human-eyeball companion to the headless `npm run navtest`.
//
//   left-click  = set goal (path from the yellow start)      shift/right-click = move the start
//   drag / arrows = pan     wheel = zoom     M = menu
//
// The layout is a 9×9 lattice at 120px spacing (origin 60), so node (i,j) sits at (i*120+60).
const SP = 120, OFF = 60, N = 9;
const XS = Array.from({ length: N }, (_, i) => OFF + i * SP);
const YS = Array.from({ length: N }, (_, j) => OFF + j * SP);

// Obstacles carve the topology. Node (i,j) = (i*120+60, j*120+60).
const RECTS = [
  // Headline SUPERBLOCK: swallows the 2×2 of nodes (3,3)(4,3)(3,4)(4,4) and kills their edges.
  { x: 380, y: 380, w: 200, h: 200 },
  // Blocks that each swallow a node and force detours through the surrounding streets.
  { x: 640, y: 140, w: 160, h: 120 }, // swallows (6,1)
  { x: 140, y: 400, w: 120, h: 120 }, // swallows (1,4)
  { x: 760, y: 640, w: 160, h: 160 }, // swallows (7,6) — near the SE, tightens that quarter
  // Walled-off node (2,7)@(300,900): thin walls sit on all four segments into it → ISOLATED.
  { x: 220, y: 892, w: 40, h: 16 },   // west  segment (1,7)-(2,7)
  { x: 340, y: 892, w: 40, h: 16 },   // east  segment (2,7)-(3,7)
  { x: 292, y: 820, w: 16, h: 40 },   // north segment (2,6)-(2,7)
  { x: 292, y: 940, w: 16, h: 40 },   // south segment (2,7)-(2,8)
];

const COL = {
  bg: 0x0a0a0f, building: 0x2a2a33, buildingLine: 0x4a4a58,
  edge: 0x2f6f7f, node: 0x39ff14, nodeBad: 0xff4d4d,
  start: 0xffd23f, path: 0xff9f1c, marker: 0xffffff, text: '#39ff14',
};

export class NavTestScene extends Phaser.Scene {
  constructor() { super({ key: 'NavTestScene' }); }

  create() {
    this.cameras.main.setBackgroundColor(COL.bg);
    this.nav = new NavGrid({ xs: XS, ys: YS, rects: RECTS });

    const worldW = XS[N - 1] + OFF, worldH = YS[N - 1] + OFF;

    // --- Static layer: buildings, edges, nodes (drawn once) ---
    const g = this.add.graphics();

    // Buildings
    g.fillStyle(COL.building, 1).lineStyle(2, COL.buildingLine, 1);
    for (const r of RECTS) { g.fillRect(r.x, r.y, r.w, r.h); g.strokeRect(r.x, r.y, r.w, r.h); }

    // Edges (each real adjacency, drawn once — nbr is symmetric so guard a<b)
    g.lineStyle(3, COL.edge, 0.9);
    for (let a = 0; a < this.nav.cols * this.nav.rows; a++) {
      const pa = this.nav.pos(a);
      for (const b of this.nav.nbr[a]) {
        if (b < a) continue;
        const pb = this.nav.pos(b);
        g.lineBetween(pa.x, pa.y, pb.x, pb.y);
      }
    }

    // Nodes: green dot if valid, red × if swallowed by a building
    for (let idx = 0; idx < this.nav.cols * this.nav.rows; idx++) {
      const p = this.nav.pos(idx);
      if (this.nav.valid[idx]) {
        g.fillStyle(COL.node, 1).fillCircle(p.x, p.y, 5);
      } else {
        g.lineStyle(3, COL.nodeBad, 1);
        g.lineBetween(p.x - 6, p.y - 6, p.x + 6, p.y + 6);
        g.lineBetween(p.x + 6, p.y - 6, p.x - 6, p.y + 6);
      }
    }

    // --- Dynamic layer: start ring, path, animated marker ---
    this.dyn = this.add.graphics();
    this.startNode = this.nav.nearestNode(0, 0);          // nearest valid to the NW corner
    this.goalNode = this.nav.nearestNode(worldW, worldH); // start with a full-diagonal path
    this._marker = { t: 0 };
    this._recompute();

    // --- HUD ---
    this.msg = this.add
      .text(10, 10,
        'EDGE-AWARE NAV — click to set goal · shift/right-click to move start\n' +
        'green = valid node · red × = swallowed by a building · cyan = real edge · amber = BFS path\n' +
        'drag/arrows = pan · wheel = zoom · M = menu',
        { fontFamily: 'monospace', fontSize: '13px', color: COL.text, backgroundColor: '#000000aa', padding: { x: 6, y: 4 } })
      .setScrollFactor(0).setDepth(100);
    this.verdict = this.add
      .text(10, GAME_HEIGHT - 28, '', { fontFamily: 'monospace', fontSize: '15px', color: COL.text, backgroundColor: '#000000aa', padding: { x: 6, y: 4 } })
      .setScrollFactor(0).setDepth(100);

    // --- Camera + controls (mirrors MapTestScene) ---
    const cam = this.cameras.main;
    cam.setBounds(-worldW, -worldH, worldW * 3, worldH * 3);
    cam.centerOn(worldW / 2, worldH / 2);
    cam.setZoom(Math.min(GAME_WIDTH / worldW, GAME_HEIGHT / worldH) * 0.92);

    this.cursors = this.input.keyboard.createCursorKeys();
    this.input.keyboard.on('keydown-M', () => this.scene.start('MenuScene'));
    this.input.mouse.disableContextMenu();
    this.input.on('wheel', (_p, _o, _dx, dy) => {
      cam.zoom = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.1, 6);
    });
    // Drag-to-pan only fires when the pointer actually moves between frames with button held.
    this.input.on('pointermove', (p) => {
      if (p.isDown && p.getDistance() > 4 && p.leftButtonDown() && !p.event.shiftKey) {
        cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
        cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
        this._panned = true;
      }
    });
    this.input.on('pointerup', (p) => {
      if (this._panned) { this._panned = false; return; } // a drag, not a click
      const w = cam.getWorldPoint(p.x, p.y);
      const node = this.nav.nearestNode(w.x, w.y);
      if (p.rightButtonReleased() || p.event.shiftKey) this.startNode = node;
      else this.goalNode = node;
      this._recompute();
    });
  }

  _recompute() {
    this.path = this.nav.findPath(this.startNode, this.goalNode);
    this.pts = this.path.map((n) => this.nav.pos(n));
    this._marker.t = 0;
    const reached = this.path[this.path.length - 1] === this.goalNode && this.goalNode !== this.startNode;
    const unreachable = this.goalNode !== this.startNode && !reached;
    if (this.verdict) {
      this.verdict.setText(
        unreachable ? 'UNREACHABLE — goal is walled off (BFS gave up)'
                    : `path: ${this.path.length} nodes, ${this.path.length - 1} hops`);
      this.verdict.setColor(unreachable ? '#ff4d4d' : COL.text);
    }
  }

  update(_time, deltaMs) {
    // Pan with arrow keys
    const cam = this.cameras.main, step = 14 / cam.zoom;
    if (this.cursors) {
      if (this.cursors.left.isDown) cam.scrollX -= step;
      if (this.cursors.right.isDown) cam.scrollX += step;
      if (this.cursors.up.isDown) cam.scrollY -= step;
      if (this.cursors.down.isDown) cam.scrollY += step;
    }

    // Redraw dynamic layer: start ring, goal ring, path, marker.
    const d = this.dyn;
    d.clear();

    const s = this.nav.pos(this.startNode), gl = this.nav.pos(this.goalNode);
    d.lineStyle(3, COL.start, 1).strokeCircle(s.x, s.y, 12);
    d.lineStyle(2, COL.path, 1).strokeCircle(gl.x, gl.y, 10);

    if (this.pts && this.pts.length > 1) {
      d.lineStyle(5, COL.path, 0.95);
      for (let i = 1; i < this.pts.length; i++) d.lineBetween(this.pts[i - 1].x, this.pts[i - 1].y, this.pts[i].x, this.pts[i].y);

      // Advance the marker along the polyline at a steady speed, looping.
      const SPEED = 260; // px/s
      this._marker.t += (SPEED * deltaMs) / 1000;
      let dist = this._marker.t, seg = 0, total = 0;
      const segLen = [];
      for (let i = 1; i < this.pts.length; i++) segLen.push(Phaser.Math.Distance.BetweenPoints(this.pts[i - 1], this.pts[i]));
      const pathLen = segLen.reduce((a, b) => a + b, 0) || 1;
      if (dist > pathLen) { this._marker.t = 0; dist = 0; }
      while (seg < segLen.length && total + segLen[seg] < dist) { total += segLen[seg]; seg++; }
      const a = this.pts[seg], b = this.pts[Math.min(seg + 1, this.pts.length - 1)];
      const f = segLen[seg] ? (dist - total) / segLen[seg] : 0;
      const mx = Phaser.Math.Linear(a.x, b.x, f), my = Phaser.Math.Linear(a.y, b.y, f);
      d.fillStyle(COL.marker, 1).fillCircle(mx, my, 7);
    }
  }
}
