import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// Escapes every non-ASCII character of the emitted JavaScript. Runs on the final chunks: Rolldown prints the code
// again after renderChunk and would undo the escapes.
const asciiOutput = (): Plugin => ({
  name: 'ascii-output',
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type === 'chunk') chunk.code = chunk.code.replace(/[\u0080-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    }
  },
})

// The modules keep their paths (dist/src/…, dist/generated/…) so the generated client stays tree-shakeable; the entries
// are dist/index.js and dist/api.js. No source maps: the generated client's would double the package.
export default defineConfig({
  publicDir: false,
  resolve: { alias: { '#generated': at('generated') } },
  plugins: [asciiOutput()],
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
    rolldownOptions: { output: { preserveModules: true, preserveModulesRoot: at('.') } },
  },
})
