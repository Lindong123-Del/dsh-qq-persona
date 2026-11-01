// 使用宿主公开服务形状的桩：真实 HTTP/SSE + SQLite，不调用模型或 QQ。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { apply } from '../lib/index.js'
import { MemoryStore } from '../lib/memory.js'

async function withBridge(mode, run) {
  const root = await mkdtemp(join(tmpdir(), 'persona-context-'))
  const env = { home: process.env.DSH_HOME, data: process.env.DSH_QQ_PERSONA_DATA_DIR }
  process.env.DSH_HOME = root
  process.env.DSH_QQ_PERSONA_DATA_DIR = join(root, 'data')
  const seed = new MemoryStore({ dbPath: join(root, 'qq-bridge', 'memory.sqlite') }).open()
  seed.writeFacts('fixture:a', ['喜欢猫'], { pinned: true })
  seed.close()
  const socket = createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  const disposers = []
  const agents = new Map()
  const userInputs = []
  let compactCalls = 0
  let created = 0
  let normalTurns = 0
  let setupCalls = 0
  let restrictions = 0
  const services = {
    sessions: { get: (id) => agents.get(id)?.session, list: () => [] },
    commands: mode === 'unsupported' ? null : {
      async execute(agent, command) {
        compactCalls++
        assert.equal(command, '/compact')
        if (mode === 'compact-failure') return { result: { kind: 'error' } }
        // 原生压缩替换当前会话的历史，不创建新会话。
        agent.session.events.splice(0)
        return { result: { kind: 'success' } }
      },
    },
  }
  services.agents = {
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
    async create({ sessionId, setup }) {
      created++
      const tools = new Map()
      let guard = () => undefined
      const agentCtx = {
        systemPrompt: { section: ({ text }) => { setupCalls++; assert.doesNotMatch(text, /喜欢猫/) } },
        tools: {
          register: (tool) => { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool) },
          guard: (fn) => { guard = fn },
          restrict: (filter) => { assert.deepEqual(filter, { allow: [] }); restrictions++ },
        },
      }
      if (setup) await setup(agentCtx)
      const session = { id: sessionId, events: [], snapshotEvents() { return this.events } }
      let idle = Promise.resolve()
      const agent = {
        session, ctx: agentCtx, status: 'idle',
        followup(message) {
          this.status = 'running'
          session.events.push({ type: 'user/message', data: { message } })
          idle = (async () => {
            const text = message.content.find((part) => part.type === 'text')?.text || ''
            if (text.startsWith('[本机内部记忆整理')) {
              assert.ok(guard({ name: 'qq_reply' }))
              assert.ok(guard({ name: 'qq_send_sticker' }))
              assert.ok(guard({ name: 'journal_read' }))
              assert.equal(guard({ name: 'recovery_write' }), undefined)
              assert.equal((await tools.get('qq_reply').execute({ text: '维护期间也不能直接发送' })).ok, false)
              if (mode !== 'recovery-failure') {
                const result = await tools.get('recovery_write').execute({ relationship: '自然熟悉', topic: '一起读书', interaction: '不必客套', pending: ['下次继续第三章'] })
                assert.equal(result.ok, true)
              }
              session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '内部整理内容不得发给联系人' }] } } })
            } else {
              normalTurns++
              userInputs.push(text)
              assert.ok(guard({ name: 'recovery_write' }))
              assert.equal((await tools.get('recovery_write').execute({ topic: '伪造更新' })).ok, false)
              assert.equal(guard({ name: 'qq_reply' }), undefined)
              if (!(mode === 'no-reply' && normalTurns === 3)) await tools.get('qq_reply').execute({ text: '好，我们继续聊。' })
            }
          })().finally(() => { agent.status = 'idle' })
        },
        whenIdle: () => idle,
      }
      agents.set(sessionId, agent)
      return { agent }
    },
  }
  const context = {
    ...services,
    logger: () => ({ info() {}, warn() {}, error() {} }),
    get: (key) => services[key],
    inject: (keys, fn) => keys.every((key) => services[key]) ? fn(services) : () => {},
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    on: () => () => {},
  }
  try {
    if (mode === 'preloaded') {
      const sessionId = 'session-preloaded-fixture'
      await mkdir(join(root, 'data'), { recursive: true })
      await writeFile(join(root, 'data', 'sessions.json'), JSON.stringify({ 'fixture:a': { sessionId, updatedAt: Date.now() } }))
      await services.agents.create({ sessionId })
    }
    apply(context, { port, allowUsers: ['10001', '10002'], beacon: false, contextMaxTurns: 2, journalEnabled: false })
    const base = `http://127.0.0.1:${port}`
    await fetch(`${base}/health`).then((response) => response.json())
    const token = JSON.parse(await readFile(join(root, 'data', 'config.json'), 'utf8')).token
    const send = async (suffix = 'a', senderId = '10001') => {
      const response = await fetch(`${base}/inbound`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ umo: `fixture:${suffix}`, senderId, chatType: 'private', text: '继续聊猫' }),
      })
      assert.equal(response.status, 200)
      return response.text()
    }
    await run({ send, root, agents, userInputs, health: () => fetch(`${base}/health`).then((res) => res.json()), stats: () => ({ compactCalls, created, setupCalls, restrictions }) })
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    if (env.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = env.home
    if (env.data === undefined) delete process.env.DSH_QQ_PERSONA_DATA_DIR; else process.env.DSH_QQ_PERSONA_DATA_DIR = env.data
    await rm(root, { recursive: true, force: true })
  }
}

test('context: 原生压缩保持 session，恢复未完事项，普通背景不重复注入', async () => {
  await withBridge('success', async ({ send, root, userInputs, stats, health }) => {
    assert.match(await send(), /好[,，]我们继续聊/)
    assert.match(await send(), /好[,，]我们继续聊/)
    const before = JSON.parse(await readFile(join(root, 'data', 'sessions.json'), 'utf8'))['fixture:a'].sessionId
    const body = await send()
    assert.doesNotMatch(body, /内部整理/)
    assert.equal(stats().compactCalls, 1)
    assert.equal(stats().created, 1)
    assert.match(userInputs[0], /喜欢猫/)
    assert.doesNotMatch(userInputs[1], /喜欢猫/)
    assert.match(userInputs[2], /下次继续第三章/)
    const after = JSON.parse(await readFile(join(root, 'data', 'sessions.json'), 'utf8'))['fixture:a'].sessionId
    assert.equal(after, before)
    assert.equal((await health()).contextMaintenance.status, 'ok')
    await send('b', '10002')
    assert.doesNotMatch(userInputs.at(-1), /第三章|喜欢猫/)
  })
})

test('context: 界面已打开的 agent 在原会话补挂人格，屏蔽全局工具，并且只挂载一次', async () => {
  await withBridge('preloaded', async ({ send, root, stats, health }) => {
    await send(); await send(); await send()
    const mapping = JSON.parse(await readFile(join(root, 'data', 'sessions.json'), 'utf8'))['fixture:a']
    assert.equal(mapping.sessionId, 'session-preloaded-fixture')
    assert.deepEqual(stats(), { compactCalls: 1, created: 1, setupCalls: 1, restrictions: 1 })
    assert.equal((await health()).contextMaintenance.status, 'ok')
  })
})

test('context: 摘要失败不压缩；宿主不支持或压缩失败时保留历史并继续聊天', async () => {
  for (const mode of ['recovery-failure', 'unsupported', 'compact-failure']) await withBridge(mode, async ({ send, agents, stats, health }) => {
    await send(); await send()
    const before = [...agents.values()][0].session.events.length
    assert.match(await send(), /好[,，]我们继续聊/)
    assert.ok([...agents.values()][0].session.events.length > before)
    assert.equal(stats().created, 1)
    assert.equal(stats().compactCalls, mode === 'compact-failure' ? 1 : 0)
    assert.notEqual((await health()).contextMaintenance.status, 'ok')
    await send()
    assert.equal(stats().compactCalls, mode === 'compact-failure' ? 1 : 0)
  })
})

test('context: 当前回合无回复时，不把维护回合文本或上轮回复作为兜底发出', async () => {
  await withBridge('no-reply', async ({ send }) => {
    await send(); await send()
    const body = await send()
    assert.doesNotMatch(body, /内部整理内容|好[,，]我们继续聊/)
    assert.match(body, /event: done/)
  })
})
