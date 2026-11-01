#!/usr/bin/env node
// 主人本地的记忆维护 CLI。
//
// 只在本机运行；QQ 对话里不暴露导出/硬删，避免被联系人诱导。
// 用法：
//   node scripts/memory-cli.mjs umos
//   node scripts/memory-cli.mjs stats --umo <umo>
//   node scripts/memory-cli.mjs list --umo <umo> [--active]
//   node scripts/memory-cli.mjs export --umo <umo> [--out memory.json]
//   node scripts/memory-cli.mjs pin --umo <umo> --id 12
//   node scripts/memory-cli.mjs forget --umo <umo> --id 12
//   node scripts/memory-cli.mjs purge --umo <umo> --id 12 --yes
//   node scripts/memory-cli.mjs summarize
//   node scripts/memory-cli.mjs maintenance

import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../lib/memory.js'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i += 1
      } else {
        out[key] = true
      }
    } else {
      out._.push(token)
    }
  }
  return out
}

function fail(message) {
  console.error(`memory-cli: ${message}`)
  process.exitCode = 2
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
const dbPath = args.db ? String(args.db) : join(homedir(), '.dsh', 'qq-bridge', 'memory.sqlite')
const umo = args.umo ? String(args.umo) : ''
const needsUmo = ['stats', 'list', 'export', 'pin', 'forget', 'purge']
if (needsUmo.includes(command) && !umo) {
  fail('this command needs --umo <umo>')
  process.exit()
}

const store = new MemoryStore({ dbPath }).open()
try {
  if (command === 'umos') {
    console.log(JSON.stringify(store.listUmos(), null, 2))
  } else if (command === 'stats') {
    console.log(JSON.stringify(store.stats(umo), null, 2))
  } else if (command === 'list') {
    console.log(JSON.stringify(store.listFacts(umo, { includeArchived: !args.active }), null, 2))
  } else if (command === 'export') {
    const data = store.exportUmo(umo, { includeArchived: true })
    if (args.out) {
      await writeFile(String(args.out), JSON.stringify(data, null, 2), 'utf8')
      console.log(String(args.out))
    } else {
      console.log(JSON.stringify(data, null, 2))
    }
  } else if (command === 'pin') {
    console.log(JSON.stringify(store.pinFact(umo, { id: args.id, text: args.text, pinned: args.unpin ? false : true }), null, 2))
  } else if (command === 'forget') {
    console.log(JSON.stringify(store.forgetFact(umo, { id: args.id, text: args.text }), null, 2))
  } else if (command === 'purge') {
    if (!args.yes) {
      fail('purge is a hard delete; add --yes if you really mean it')
    } else {
      console.log(JSON.stringify(store.hardDeleteFact(umo, { id: args.id, text: args.text }), null, 2))
    }
  } else if (command === 'summarize') {
    console.log(JSON.stringify(store.rollupSummaries(), null, 2))
  } else if (command === 'maintenance') {
    console.log(JSON.stringify(store.maintenance(), null, 2))
  } else {
    console.log(`用法：
  node scripts/memory-cli.mjs umos
  node scripts/memory-cli.mjs stats --umo <umo>
  node scripts/memory-cli.mjs list --umo <umo> [--active]
  node scripts/memory-cli.mjs export --umo <umo> [--out memory.json]
  node scripts/memory-cli.mjs pin --umo <umo> --id 12 [--unpin]
  node scripts/memory-cli.mjs forget --umo <umo> --id 12
  node scripts/memory-cli.mjs purge --umo <umo> --id 12 --yes
  node scripts/memory-cli.mjs summarize
  node scripts/memory-cli.mjs maintenance

默认 db: ~/.dsh/qq-bridge/memory.sqlite；可用 --db 指定。`)
  }
} finally {
  store.close()
}
