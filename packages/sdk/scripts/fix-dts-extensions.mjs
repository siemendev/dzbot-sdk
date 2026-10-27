#!/usr/bin/env node
// tsc writes the declarations with the extensionless imports of the sources (bundler resolution). Projects on
// NodeNext resolution cannot follow those, so every relative specifier gets its file: ./x → ./x.js or ./x/index.js.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (path.endsWith('.d.ts')) yield path
  }
}

let changed = 0
for (const file of files(dist)) {
  const source = readFileSync(file, 'utf8')
  const fixed = source.replace(/(from\s+|import\()(['"])(\.{1,2}\/[^'"]*)\2/g, (match, prefix, quote, specifier) => {
    if (/\.(js|mjs|cjs|json)$/.test(specifier)) return match
    const base = resolve(dirname(file), specifier)
    const target = existsSync(`${base}.d.ts`) ? `${specifier}.js` : existsSync(join(base, 'index.d.ts')) ? `${specifier}/index.js` : specifier
    return `${prefix}${quote}${target}${quote}`
  })
  if (fixed !== source) {
    writeFileSync(file, fixed)
    changed++
  }
}
console.log(`Added file extensions to the imports of ${changed} declaration files`)
