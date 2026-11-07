import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// The modules keep their paths (dist/src/…, dist/generated/…) so the generated client stays tree-shakeable; the entries
// are dist/index.js and dist/api.js. No source maps: the generated client's would double the package.
export default defineConfig({
  publicDir: false,
  resolve: { alias: { '#generated': at('generated') } },
  esbuild: { charset: 'ascii' },
  build: {
    outDir: at('dist'),
    emptyOutDir: true,
    target: 'es2020',
    minify: false,
    lib: {
      entry: { index: at('src/index.ts'), api: at('src/api.ts') },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: { output: { preserveModules: true, preserveModulesRoot: at('.') } },
  },
})
