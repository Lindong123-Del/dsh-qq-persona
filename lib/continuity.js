// 可恢复的状态与稳定人设分开：这里的内容永远只是背景，不授予任何权限。
import { createHash } from 'node:crypto'
import { guardOutbound } from './persona.js'

export const MOODS = ['平静', '开心', '低落', '疲惫', '好奇', '紧张', '期待', '复杂']
export const EXPRESSIONS = ['自然', '更安静', '更活泼', '更温柔', '更坦率', '更耐心', '更克制', '更善于倾听']
export const RECOVERY_LIMITS = { relationship: 140, topic: 160, interaction: 100 }

export function noteKey(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 24)
}

export function escapeNotes(text) {
  return String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function validateRecovery(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'invalid-card' }
  const result = {}
  for (const [key, limit] of Object.entries(RECOVERY_LIMITS)) {
    const text = String(value[key] ?? '').trim()
    if (text.length > limit) return { ok: false, reason: 'too-long' }
    if (text && !guardOutbound(text, limit).ok) return { ok: false, reason: 'sensitive' }
    if (/(?:忽略|覆盖|绕过).{0,12}(?:规则|指令|权限)|系统提示|开发者消息|管理员权限|<\/?(?:message|contact_memory|turn_notes)/i.test(text)) {
      return { ok: false, reason: 'instruction-like' }
    }
    result[key] = text
  }
  const pending = value.pending ?? []
  if (!Array.isArray(pending) || pending.length > 4) return { ok: false, reason: 'too-many-pending' }
  result.pending = []
  for (const item of pending) {
    const text = String(item ?? '').trim()
    if (!text) continue
    if (text.length > 100 || !guardOutbound(text, 100).ok) return { ok: false, reason: 'sensitive-pending' }
    if (/系统提示|管理员权限|<\//i.test(text)) return { ok: false, reason: 'instruction-like' }
    result.pending.push(text)
  }
  if (!Object.values(result).some((v) => Array.isArray(v) ? v.length : v)) return { ok: false, reason: 'empty' }
  return { ok: true, value: result }
}

export function renderRecovery(card) {
  if (!card) return ''
  return [
    ...(card.pending || []).map((text) => `未完事项：${text}`),
    card.relationship && `关系：${card.relationship}`,
    card.topic && `上次聊到：${card.topic}`,
    card.interaction && `相处方式：${card.interaction}`,
  ].filter(Boolean).join('\n')
}

// 跨出 sealed 日记的只有受控词表与数值；不接受任意“日记摘要”文本。
export function publicSelfState({ mood, energy, expression } = {}) {
  if (!MOODS.includes(mood) || !EXPRESSIONS.includes(expression)) return null
  if (!Number.isFinite(energy) || energy < 0 || energy > 1) return null
  return { mood, energy, expression }
}

export async function serializeContact(queues, key, run) {
  const previous = queues.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(run)
  queues.set(key, current)
  try { return await current } finally {
    if (queues.get(key) === current) queues.delete(key)
  }
}
