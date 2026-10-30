import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const projectSources = [new URL('../../src/', import.meta.url).href, new URL('./', import.meta.url).href,
  new URL('../', import.meta.url).href];
registerHooks({
  resolve(specifier, context, nextResolve) {
    let target;
    if (specifier.startsWith('@/')) target = resolve(root, 'src', specifier.slice(2));
    else if (specifier.startsWith('.') && projectSources.some((prefix) => context.parentURL?.startsWith(prefix))) {
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
