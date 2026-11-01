// 表情包纯逻辑单测。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  STICKER_TAGS,
  checkStickerRate,
  commitStickerRate,
  isPathInside,
  isStickerImage,
  pickSticker,
  sanitizeStickerTag,
  stickerDayKey,
} from '../lib/stickers.js'

test('stickers: 标签白名单与图片扩展名', () => {
  assert.equal(sanitizeStickerTag('happy'), 'happy')
  assert.equal(sanitizeStickerTag('HAPPY'), 'happy')
  assert.equal(sanitizeStickerTag('../../etc'), '')
  assert.equal(sanitizeStickerTag('unknown'), '')
  assert.equal(isStickerImage('a.png'), true)
  assert.equal(isStickerImage('a.GIF'), true)
  assert.equal(isStickerImage('a.txt'), false)
})

test('stickers: 选择避开最近发过的', () => {
  const files = ['happy_1.png', 'happy_2.png', 'happy_3.png', 'readme.txt']
  assert.equal(pickSticker(files, { recent: ['happy_1.png', 'happy_2.png'], rng: () => 0 }), 'happy_3.png')
  assert.equal(pickSticker(files, { rng: () => 0 }), 'happy_1.png')
  assert.equal(pickSticker([], { rng: () => 0 }), '')
})

test('stickers: 冷却与每日上限', () => {
  const now = new Date('2026-10-24T10:00:00+08:00').getTime()
  const fresh = { day: stickerDayKey(now), count: 0, lastAt: 0, recent: [] }
  assert.equal(checkStickerRate(fresh, now, { cooldownSec: 30, dailyLimit: 2 }).ok, true)

  const after = commitStickerRate(fresh, now, 'happy_1.png')
  assert.equal(checkStickerRate(after, now + 1000, { cooldownSec: 30, dailyLimit: 2 }).reason, 'cooldown')
  assert.equal(checkStickerRate(after, now + 31_000, { cooldownSec: 30, dailyLimit: 2 }).ok, true)

  const full = { day: stickerDayKey(now), count: 2, lastAt: now - 60_000, recent: [] }
  assert.equal(checkStickerRate(full, now, { cooldownSec: 30, dailyLimit: 2 }).reason, 'daily-limit')
  assert.equal(checkStickerRate(full, now + 24 * 60 * 60 * 1000, { cooldownSec: 30, dailyLimit: 2 }).ok, true)
})

test('stickers: 路径必须落在表情包目录内', () => {
  assert.equal(isPathInside('C:\\stickers', 'C:\\stickers\\happy\\happy_1.png'), true)
  assert.equal(isPathInside('C:\\stickers', 'C:\\stickers\\..\\secret.png'), false)
  assert.equal(isPathInside('C:\\stickers', 'C:\\other\\happy_1.png'), false)
  assert.equal(isPathInside('C:\\stickers', 'C:\\stickers'), true)
  assert.equal(STICKER_TAGS.includes('cat'), true)
})