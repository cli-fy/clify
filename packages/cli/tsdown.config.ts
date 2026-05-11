import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    fileURLToPath(new URL('./src/bin.ts', import.meta.url)),
  ],
  outDir: fileURLToPath(new URL('./dist', import.meta.url)),
  format: ['esm'],
  target: 'node20',
  sourcemap: true,
  clean: true,
  dts: false,
  external: [],
  banner: { js: '#!/usr/bin/env node' },
})
