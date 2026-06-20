#!/usr/bin/env node
/**
 * Build script for compiling ksefnik CLI into a standalone binary using Bun.
 * Usage: bun run apps/build/build.ts
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')
const pkg = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'))
const version = pkg.version

const outDir = join(root, 'dist-bin')

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true })
}

console.log(`Building ksefnik v${version} binary...`)

try {
  execSync(
    `bun build packages/cli/src/main.ts --compile` +
    ` --define CLI_VERSION='"${version}"'` +
    ` --outfile ${join(outDir, 'ksefnik')}`,
    { stdio: 'inherit', cwd: root },
  )
  console.log(`Binary compiled to: ${join(outDir, 'ksefnik')}`)
} catch (error) {
  console.error('Binary compilation failed. Make sure Bun is installed.')
  console.error('Install: curl -fsSL https://bun.sh/install | bash')
  process.exit(1)
}
