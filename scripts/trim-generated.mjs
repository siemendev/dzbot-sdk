#!/usr/bin/env node
// The public API's description also lists PublicApiApi, which dzbot's own client leaves out; drop it the same way.
import { readFileSync, writeFileSync } from 'node:fs'

const path = new URL('../generated/apis/index.ts', import.meta.url)
const lines = readFileSync(path, 'utf8').split('\n').filter((line) => !line.includes('PublicApiApi'))
writeFileSync(path, lines.join('\n'))
