// Phase A proof: the edge-aware NavGrid handles road networks the old assumed-full lattice
// couldn't — superblocks (pruned nodes), deleted segments (dead-ends / detours), and walled-off
// (unreachable) regions. Headless, assertion-based, CI-usable (exit 1 on any failure).
//
//   node.js sim/nav-test.mjs   (or: npm run navtest)
//
// Layout: a 5×5 lattice, 100px spacing. One superblock swallows the centre node and forces
// detours; one corner node is fully walled off. We assert the derived graph reflects all of it.
import { register } from 'node:module';
register('./phaser-loader.mjs', import.meta.url);

const { NavGrid } = await import('../src/ai/NavGrid.js');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '  ok  ' : 'FAIL  '} ${name}`);
  if (!cond) failures++;
}

// ── Hand-carved layout ────────────────────────────────────────────────────────
const xs = [0, 100, 200, 300, 400];
const ys = [0, 100, 200, 300, 400];
const rects = [
  // Superblock over the centre node (2,2)@(200,200): swallows it + kills its 4 edges.
  { x: 160, y: 160, w: 80, h: 80 },
  // Wall off corner node (4,4)@(400,400): block the two segments that lead into it.
  { x: 340, y: 392, w: 40, h: 16 }, // sits on the horizontal (3,4)-(4,4) segment at y=400
  { x: 392, y: 340, w: 16, h: 40 }, // sits on the vertical   (4,3)-(4,4) segment at x=400
];
const nav = new NavGrid({ xs, ys, rects });
const N = (i, j) => nav.index(i, j);

// ── Superblock: node pruned, edges gone ───────────────────────────────────────
check('centre node (2,2) is INVALID (swallowed by superblock)', !nav.valid[N(2, 2)]);
check('no edge (1,2)->(2,2) (blocked by superblock)', !nav.nbr[N(1, 2)].includes(N(2, 2)));
check('no edge (2,1)->(2,2) (blocked by superblock)', !nav.nbr[N(2, 1)].includes(N(2, 2)));
check('open node (1,1) keeps all 4 neighbours', nav.nbr[N(1, 1)].length === 4);

// ── Detour: crossing the middle row must route AROUND the superblock ───────────
const path = nav.findPath(N(0, 2), N(4, 2));
const straightHops = 4; // (0,2)->(1,2)->(2,2)->(3,2)->(4,2) if the centre were open
check('L↔R path avoids the invalid centre node', !path.includes(N(2, 2)));
check('L↔R path is a real detour (more than the straight-line hops)', path.length - 1 > straightHops);
check('every step of the detour is a real edge', path.every((n, k) =>
  k === 0 || nav.nbr[path[k - 1]].includes(n)));
check('detour reaches the goal', path[path.length - 1] === N(4, 2));

// ── Walled-off node: unreachable → findPath returns [start] ───────────────────
check('corner node (4,4) is valid but ISOLATED (no edges)', nav.valid[N(4, 4)] && nav.nbr[N(4, 4)].length === 0);
const toWalled = nav.findPath(N(0, 0), N(4, 4));
check('path to a walled-off node gives up ([start] only)', toWalled.length === 1 && toWalled[0] === N(0, 0));

// ── nearestNode snaps a point inside the superblock to a valid node ────────────
const snap = nav.nearestNode(200, 200); // dead centre of the superblock
check('nearestNode(inside superblock) returns a VALID node', !!nav.valid[snap]);
check('nearestNode(inside superblock) is NOT the swallowed node', snap !== N(2, 2));

// ── Adjacency is symmetric (a→b ⇒ b→a) ────────────────────────────────────────
let symmetric = true;
for (let a = 0; a < nav.cols * nav.rows; a++)
  for (const b of nav.nbr[a]) if (!nav.nbr[b].includes(a)) symmetric = false;
check('adjacency is symmetric', symmetric);

// ── nodesInRange respects the pruned graph (never returns invalid nodes) ───────
const near = nav.nodesInRange(N(1, 2), 3);
check('nodesInRange never returns an invalid node', near.every((n) => nav.valid[n]));

console.log(`\n${failures === 0 ? 'ALL PASS ✓' : failures + ' FAILURE(S) ✗'}`);
process.exit(failures === 0 ? 0 : 1);
