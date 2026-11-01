// QQ 空间发布逻辑的单测：内容审查、频率、响应解析。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildQzonePayload,
  checkQzoneRate,
  commitQzoneRate,
  isLoopbackHttpUrl,
  parseQzoneResult,
  qzoneContentRejection,
  qzoneDayKey,
} from '../lib/qzone.js'

test('qzone: 内容审查拦截敏感项与主人身份', () => {
  assert.equal(qzoneContentRejection('今天的天色像一块没洗干净的玻璃。'), '')
  assert.equal(qzoneContentRejection('我的手机是 13812345678'), 'phone')
  assert.equal(qzoneContentRejection('看这个 https://example.com'), 'url')
  assert.equal(qzoneContentRejection('主人今天不在'), 'master-identity')
  assert.equal(qzoneContentRejection('@某人 你好'), 'mention')
  assert.equal(qzoneContentRejection('很长'.repeat(300)), 'too-long')
  assert.equal(qzoneContentRejection('   '), 'empty')
})

test('qzone: 每天一条 + 内容去重', () => {
  const now = new Date('2026-10-22T10:00:00+08:00').getTime()
  const state = { day: qzoneDayKey(now), count: 0, hashes: [] }
  const first = checkQzoneRate(state, now, 'h1', 1)
  assert.equal(first.ok, true)
  const after = commitQzoneRate(first.state, now, 'h1')
  assert.equal(after.count, 1)
  assert.equal(checkQzoneRate(after, now, 'h2', 1).reason, 'daily-limit')
  assert.equal(checkQzoneRate(after, now, 'h1', 2).reason, 'duplicate')

  const tomorrow = now + 24 * 60 * 60 * 1000
  assert.equal(checkQzoneRate(after, tomorrow, 'h2', 1).ok, true)
})

test('qzone: 响应解析', () => {
  assert.deepEqual(parseQzoneResult({ status: 'ok', retcode: 0, data: { tid: 'abc' } }), { ok: true, tid: 'abc' })
  assert.equal(parseQzoneResult({ status: 'failed', retcode: 100 }).ok, false)
  assert.equal(parseQzoneResult('not json').reason, 'bad-json')
  assert.equal(parseQzoneResult({ status: 'ok', retcode: 0, data: {} }).reason, 'no-tid')
})

test('qzone: 只允许 loopback HTTP 地址', () => {
  assert.equal(isLoopbackHttpUrl('http://127.0.0.1:5700'), true)
  assert.equal(isLoopbackHttpUrl('http://localhost:5700'), true)
  assert.equal(isLoopbackHttpUrl('http://example.com:5700'), false)
  assert.equal(isLoopbackHttpUrl('file:///tmp/x'), false)
  assert.equal(isLoopbackHttpUrl('not a url'), false)
})

test('qzone: payload 默认仅自己可见、只发文字', () => {
  const payload = buildQzonePayload('今天有点累', { ugcRight: 64, echo: 'e1' })
  assert.equal(payload.action, 'send_qzone_msg')
  assert.equal(payload.params.content, '今天有点累')
  assert.equal(payload.params.ugc_right, 64)
  assert.equal(payload.params.images, undefined)
  assert.equal(payload.echo, 'e1')
})
