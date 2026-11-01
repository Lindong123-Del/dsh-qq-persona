// QQ 空间（说说）的纯函数层：内容审查、频率状态、响应解析。
//
// 动态是“对外发布”，比私聊更容易泄露，所以规则必须能被单测钉住：
//   - 手机号/邮箱/IP/路径/token/URL 一律不发（复用 guardOutbound）；
//   - 不出现“主人/账号持有人”这类主人身份称呼；
//   - 不 @ 任何人；
//   - 默认每天 1 条、内容去重；
//   - 默认 ugc_right=64（仅自己可见），确认后再放宽。

import { guardOutbound } from './persona.js'

export const QZONE_MAX_CHARS = 500
export const QZONE_VISIBILITY = {
  public: 1,
  friends: 4,
  partial: 16,
  self: 64,
  exclude: 128,
}

export function qzoneContentRejection(text, { maxChars = QZONE_MAX_CHARS } = {}) {
  const value = String(text ?? '').trim()
  if (!value) return 'empty'
  if (value.length > maxChars) return 'too-long'
  // 动态是对外的：不要把主人身份写进去。
  if (/主人|账号持有人/.test(value)) return 'master-identity'
  // 不 @ 任何人（避免把联系人带进公开内容）。
  if (/(?:^|\s)@\S+/.test(value)) return 'mention'
  const verdict = guardOutbound(value, maxChars)
  if (!verdict.ok) return verdict.category || 'blocked'
  return ''
}

export function qzoneDayKey(now = Date.now()) {
  const d = new Date(now)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export function checkQzoneRate(state, now, hash, dailyLimit = 1) {
  const day = qzoneDayKey(now)
  const current = state && state.day === day
    ? { day, count: Number(state.count) || 0, hashes: Array.isArray(state.hashes) ? state.hashes : [] }
    : { day, count: 0, hashes: [] }
  if (current.count >= Math.max(1, Number(dailyLimit) || 1)) {
    return { ok: false, reason: 'daily-limit', state: current }
  }
  if (hash && current.hashes.includes(hash)) {
    return { ok: false, reason: 'duplicate', state: current }
  }
  return { ok: true, state: current }
}

export function commitQzoneRate(state, now, hash) {
  const day = qzoneDayKey(now)
  const current = state && state.day === day
    ? { day, count: Number(state.count) || 0, hashes: Array.isArray(state.hashes) ? state.hashes.slice(-30) : [] }
    : { day, count: 0, hashes: [] }
  return {
    day,
    count: current.count + 1,
    hashes: hash ? [...current.hashes, hash].slice(-30) : current.hashes,
    lastAt: now,
  }
}

export function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(String(value))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  } catch {
    return false
  }
}

export function buildQzonePayload(content, { ugcRight = 64, echo = '' } = {}) {
  return {
    action: 'send_qzone_msg',
    params: {
      content: String(content ?? ''),
      ugc_right: Number(ugcRight) || 64,
    },
    echo: echo || undefined,
  }
}

export function parseQzoneResult(body) {
  let data = body
  if (typeof body === 'string') {
    try { data = JSON.parse(body) } catch { return { ok: false, reason: 'bad-json' } }
  }
  if (!data || data.status !== 'ok' || Number(data.retcode) !== 0) {
    return { ok: false, reason: 'qzone-api', status: data?.status, retcode: data?.retcode }
  }
  const tid = data?.data?.tid
  if (!tid) return { ok: false, reason: 'no-tid' }
  return { ok: true, tid: String(tid) }
}
