import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  sourcemap: true,
  clean: true,
  external: [],
  // The template must not mark runtime dependencies as external; dist/index.js
  // has to run without node_modules present.
})
