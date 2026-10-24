import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    let target;
    if (specifier.startsWith('@/')) target = resolve(root, 'src', specifier.slice(2));
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      target = resolve(dirname(fileURLToPath(context.parentURL)), specifier);
    }
    if (target && !extname(target)) {
      for (const extension of ['.ts', '.tsx', '.js', '.mjs']) {
        if (existsSync(target + extension)) return nextResolve(pathToFileURL(target + extension).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
