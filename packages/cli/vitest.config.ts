import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'))

export default defineConfig({
  define: {
    CLI_VERSION: JSON.stringify(pkg.version),
  },
  test: {
    globals: true,
  },
})
