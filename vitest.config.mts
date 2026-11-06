import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '#generated': fileURLToPath(new URL('./generated', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'] },
})
