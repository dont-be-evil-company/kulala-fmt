import { build } from 'vite-plus';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

if (process.env.npm_lifecycle_event === 'install') {
  process.stdout.write('Skipping build during pnpm install');
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

function isNodeBuiltin(id: string) {
  return nodeBuiltins.has(id) || id.startsWith('node:');
}

function nodeBundle(entry: string, outFile: string, emptyOutDir?: boolean | null) {
  return {
    build: {
      ssr: resolve(root, entry),
      outDir: resolve(root, 'dist'),
      emptyOutDir,
      minify: false,
      target: 'node20' as const,
      rollupOptions: {
        external: (id: string) => isNodeBuiltin(id),
        output: {
          entryFileNames: outFile,
          format: 'cjs' as const,
          codeSplitting: false,
        },
      },
    },
    ssr: {
      noExternal: true as const,
    },
  };
}

await build(nodeBundle('src/index.ts', 'cli.cjs', true));
await build(nodeBundle('src/api.ts', 'api.cjs', false));
