// 本地表情包库的纯逻辑：标签、选择、频率、路径安全。
//
// 约束：
//   - 出站只允许表情包目录里的图片，绝不发任意路径；
//   - 一轮最多一张；同一对象 30 秒冷却、每天上限；
//   - 选择时避开最近发过的，避免连续重复。

import { isAbsolute, relative, resolve } from 'node:path'

export const STICKER_TAGS = ['happy', 'confused', 'sleepy', 'refuse', 'hug', 'cat', 'thanks', 'sad']
export const STICKER_LABELS = {
  happy: '开心',
  confused: '无语',
  sleepy: '晚安',
  refuse: '拒绝',
  hug: '抱抱',
  cat: '猫猫',
  thanks: '谢谢',
  sad: '委屈',
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

export function sanitizeStickerTag(value, allowed = STICKER_TAGS) {
  const tag = String(value ?? '').trim().toLowerCase()
  return allowed.includes(tag) ? tag : ''
}

export function isStickerImage(name) {
  const lower = String(name ?? '').toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot >= 0 && IMAGE_EXT.has(lower.slice(dot))
}

/** 从某个标签的文件名列表里挑一张；优先避开 recent。 */
export function pickSticker(files, { recent = [], rng = Math.random } = {}) {
  const candidates = (Array.isArray(files) ? files : []).filter((name) => isStickerImage(name))
  if (!candidates.length) return ''
  const fresh = candidates.filter((name) => !recent.includes(name))
  const pool = fresh.length ? fresh : candidates
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(Number(rng()) * pool.length)))
  return pool[index]
}

export function stickerDayKey(now = Date.now()) {
  const d = new Date(now)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export function checkStickerRate(state, now, { cooldownSec = 30, dailyLimit = 20 } = {}) {
  const day = stickerDayKey(now)
  const current = state && state.day === day
    ? { day, count: Number(state.count) || 0, lastAt: Number(state.lastAt) || 0, recent: Array.isArray(state.recent) ? state.recent : [] }
    : { day, count: 0, lastAt: 0, recent: [] }
  if (current.count >= Math.max(1, Number(dailyLimit) || 20)) {
    return { ok: false, reason: 'daily-limit', state: current }
  }
  const cooldownMs = Math.max(0, Number(cooldownSec) || 0) * 1000
  if (cooldownMs && now - current.lastAt < cooldownMs) {
    return { ok: false, reason: 'cooldown', state: current }
  }
  return { ok: true, state: current }
}

export function commitStickerRate(state, now, name, { recentLimit = 4 } = {}) {
  const day = stickerDayKey(now)
  const current = state && state.day === day
    ? { day, count: Number(state.count) || 0, lastAt: Number(state.lastAt) || 0, recent: Array.isArray(state.recent) ? state.recent : [] }
    : { day, count: 0, lastAt: 0, recent: [] }
  return {
    day,
    count: current.count + 1,
    lastAt: now,
    recent: name ? [...current.recent, name].slice(-Math.max(1, Number(recentLimit) || 4)) : current.recent,
  }
}

/** 目标文件必须在 root 之内；resolve 后再 relative，能挡住 `..` 穿越。 */
export function isPathInside(root, target) {
  try {
    const base = resolve(String(root ?? ''))
    const full = resolve(String(target ?? ''))
    if (!base || !full) return false
    const rel = relative(base, full)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    return false
  }
}