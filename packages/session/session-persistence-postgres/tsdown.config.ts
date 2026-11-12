import { defineConfig } from 'tsdown'

/** Postgres persistence is Host-only; the client build contributes nothing. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : [
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
