// ESM resolve hook: redirect every `import ... from 'phaser'` to our headless
// shim. Registered by run.mjs so the real game modules import unchanged.
export async function resolve(specifier, context, next) {
  if (specifier === 'phaser') {
    return {
      url: new URL('./phaser-shim.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
