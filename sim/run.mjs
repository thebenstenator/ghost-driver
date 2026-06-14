// Entry point for the headless chase sim. Registers the loader hook that aliases
// 'phaser' to our shim, then runs the sim.  Usage:  npm run sim
import { register } from 'node:module';
register('./phaser-loader.mjs', import.meta.url);
await import('./chase-sim.mjs');
