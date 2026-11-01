// 分层记忆的 SQLite 实现。
//
// 设计约束（2026-10-22 与主人确认）：
//   - 按 umo 隔离：任何查询都必须带 umo，绝不跨联系人；
//   - 忘却默认归档（archived=1），不做硬删除；
//   - 近期窗口 7 天 / 最近 50 条；
//   - 她可以自己 pin / forget；主人也可以通过她 pin / forget 自己那份。
//
// 这里只做存储与检索，不碰 HTTP、不碰 persona prompt。纯函数在 persona.js，
// 这样 test/memory.test.js 可以直接用临时目录把行为钉住。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { factKey, factRejection, guardOutbound } from './persona.js'
import { noteKey, publicSelfState, renderRecovery, validateRecovery } from './continuity.js'

const DAY_MS = 86_400_000
const EPISODE_KEEP = 200
const EPISODE_MAX_AGE_DAYS = 90
const ARCHIVE_THRESHOLD = 0.15
const KINDS = new Set(['fact', 'identity', 'preference', 'boundary', 'commitment', 'event'])

/**
 * 本地字符 n-gram 向量：不依赖任何 embedding API，也不把内容发出去。
 * 它不是“语义模型”，但能把同一段文字里的「小猫 / 杯子 / 打翻杯子」拉近，
 * 作为 FTS/LIKE 之外的混合信号足够用。
 */
export function hashVector(text, dims = 128) {
  const vec = new Float32Array(dims)
  const value = String(text ?? '').normalize('NFKC').toLowerCase()
  for (let i = 0; i < value.length; i += 1) {
    for (let n = 1; n <= 3 && i + n <= value.length; n += 1) {
      const gram = value.slice(i, i + n)
      let h = 2166136261
      for (let j = 0; j < gram.length; j += 1) {
        h = Math.imul(h ^ gram.charCodeAt(j), 16777619)
      }
      const idx = (h >>> 0) % dims
      vec[idx] += (h & 0x80000000) ? -1 : 1
    }
  }
  let norm = 0
  for (let i = 0; i < dims; i += 1) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < dims; i += 1) vec[i] /= norm
  return vec
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return dot
}

export function clampImportance(value, fallback = 3) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(5, Math.max(1, Math.round(n)))
}

/**
 * 保留分：pinned 永不衰减；其余按重要度给不同的半衰期。
 * 这不是“删除”判据，只是“是否归档”的判据。
 */
export function retentionScore(fact, now = Date.now()) {
  if (fact?.pinned) return Number.POSITIVE_INFINITY
  const importance = clampImportance(fact?.importance)
  const ageDays = Math.max(0, (now - Number(fact?.last_seen || now)) / DAY_MS)
  const tau = 7 + 60 * importance
  return Math.exp(-ageDays / tau) * (0.5 + 0.1 * importance)
}

function textOfFact(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      text: String(value.text ?? '').trim(),
      kind: KINDS.has(String(value.kind || '')) ? String(value.kind) : '',
      importance: value.importance,
      pinned: Boolean(value.pinned),
    }
  }
  return { text: String(value ?? '').trim(), kind: '', importance: undefined, pinned: false }
}

function safeEpisodeText(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  const verdict = guardOutbound(raw, 800)
  // 敏感内容不落库；保留一个占位，近期窗口仍然知道“有过这一轮”。
  return verdict.ok ? verdict.text : '[已省略敏感内容]'
}

function fmtTime(ts) {
  const d = new Date(Number(ts) || Date.now())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

function localDay(now = Date.now()) {
  const d = new Date(now)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export class MemoryStore {
  constructor({
    dbPath,
    logger = null,
    recentDays = 7,
    recentLimit = 50,
    maxRenderChars = 1800,
    recentRenderLimit = 8,
  } = {}) {
    if (!dbPath) throw new Error('memory dbPath is required')
    this.dbPath = dbPath
    this.logger = logger
    this.recentDays = Number(recentDays) > 0 ? Number(recentDays) : 7
    this.recentLimit = Number(recentLimit) > 0 ? Number(recentLimit) : 50
    this.maxRenderChars = Number(maxRenderChars) > 500 ? Number(maxRenderChars) : 1800
    this.recentRenderLimit = Math.max(1, Math.min(50, Number(recentRenderLimit) || 8))
    this.db = null
    this.fts = false
  }

  open() {
    if (this.db) return this
    if (this.dbPath !== ':memory:') mkdirSync(dirname(this.dbPath), { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this._schema()
    // 每次启动先摘要再清理：不要让 consolidate 先把还没摘要的老 episode 删掉。
    try { this.maintenance() } catch (err) { this.logger?.warn?.('memory maintenance failed: %s', err?.message ?? err) }
    return this
  }

  close() {
    try { this.db?.close() } catch { /* ignore */ }
    this.db = null
  }

  _schema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_cards (
        umo TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS persona_state (
        id INTEGER PRIMARY KEY CHECK(id = 1), state TEXT NOT NULL,
        updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS contacts (
        umo TEXT PRIMARY KEY,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        summary TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        umo TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'fact',
        text TEXT NOT NULL,
        normalized TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 3,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT '',
        UNIQUE(umo, normalized)
      );
      CREATE INDEX IF NOT EXISTS facts_umo_idx ON facts(umo, archived, pinned, last_seen);
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        umo TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL,
        session_id TEXT,
        importance INTEGER NOT NULL DEFAULT 2,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS episodes_umo_ts_idx ON episodes(umo, ts);
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        umo TEXT NOT NULL,
        window_start INTEGER,
        window_end INTEGER,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        day TEXT NOT NULL,
        text TEXT NOT NULL,
        mood TEXT NOT NULL DEFAULT '',
        sealed INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS journal_day_idx ON journal(day);
      CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        umo TEXT,
        event TEXT NOT NULL,
        detail TEXT
      );
    `)
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, content='facts', content_rowid='id')")
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
          INSERT INTO facts_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE OF text ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO facts_fts(rowid, text) VALUES (new.id, new.text);
        END;
      `)
      // 兼容旧库：触发器建好之前已有的 facts 需要重建索引。
      this.db.exec("INSERT INTO facts_fts(facts_fts) VALUES ('rebuild')")
      this.fts = true
    } catch (err) {
      this.fts = false
      this.logger?.warn?.('memory fts unavailable, fallback to LIKE: %s', err?.message ?? err)
    }
  }

  _tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      throw err
    }
  }

  _event(event, umo, detail) {
    try {
      this.db.prepare('INSERT INTO memory_events(ts, umo, event, detail) VALUES (?, ?, ?, ?)')
        .run(Date.now(), umo || null, event, detail ? JSON.stringify(detail) : null)
    } catch { /* audit 是旁路 */ }
  }

  _touchContact(umo, now) {
    this.db.prepare(`
      INSERT INTO contacts(umo, first_seen, last_seen) VALUES (?, ?, ?)
      ON CONFLICT(umo) DO UPDATE SET last_seen = excluded.last_seen
    `).run(umo, now, now)
  }

  /**
   * 写入 0–N 条事实。字符串保持旧接口；对象可带 kind/importance/pinned。
   * 去重键是 `(umo, factKey(text))`，同一件事重复说只更新时间与重要度。
   */
  writeFacts(umo, facts, { now = Date.now(), source = 'model', importance: defaultImportance, kind: defaultKind, pinned: defaultPinned, allowInstructionLike = false } = {}) {
    if (!umo) return { added: 0, updated: 0, skipped: 0, rejected: {} }
    const list = (Array.isArray(facts) ? facts : [facts]).slice(0, 6)
    const result = { added: 0, updated: 0, skipped: 0, rejected: {} }
    if (!list.length) return result
    this._tx(() => {
      this._touchContact(umo, now)
      for (const value of list) {
        const item = textOfFact(value)
        if (!item.text) { result.skipped += 1; continue }
        const reason = factRejection(item.text, { maxChars: 80 })
        // 迁移旧卡时放宽 instruction-like：旧数据已经过一轮校验，
        // 且「主人…」这种称呼会被 factRejection 误判成指令。
        if (reason && !(allowInstructionLike && reason === 'instruction-like')) {
          result.skipped += 1
          result.rejected[reason] = (result.rejected[reason] || 0) + 1
          continue
        }
        const normalized = factKey(item.text)
        if (!normalized) { result.skipped += 1; continue }
        const importance = clampImportance(item.importance ?? defaultImportance, 3)
        const kind = KINDS.has(item.kind)
          ? item.kind
          : (KINDS.has(String(defaultKind || '')) ? String(defaultKind) : 'fact')
        const pinned = item.pinned || Boolean(defaultPinned)
        const existing = this.db.prepare(
          'SELECT id, importance, pinned, archived FROM facts WHERE umo = ? AND normalized = ?',
        ).get(umo, normalized)
        if (existing) {
          this.db.prepare(`
            UPDATE facts
               SET text = ?, kind = ?, importance = MAX(importance, ?),
                   pinned = MAX(pinned, ?), archived = 0, last_seen = ?, source = ?
             WHERE id = ?
          `).run(
            item.text,
            kind,
            importance,
            pinned ? 1 : 0,
            now,
            source,
            existing.id,
          )
          result.updated += 1
        } else {
          this.db.prepare(`
            INSERT INTO facts(umo, kind, text, normalized, importance, pinned, archived, first_seen, last_seen, source)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
          `).run(
            umo,
            kind,
            item.text,
            normalized,
            importance,
            pinned ? 1 : 0,
            now,
            now,
            source,
          )
          result.added += 1
        }
      }
    })
    this._event('fact-write', umo, {
      added: result.added,
      updated: result.updated,
      skipped: result.skipped,
      rejected: result.rejected,
      source,
    })
    return result
  }

  listFacts(umo, { includeArchived = false } = {}) {
    const where = includeArchived ? '' : 'AND archived = 0'
    return this.db.prepare(`
      SELECT id, umo, kind, text, importance, pinned, archived, first_seen, last_seen, access_count
        FROM facts WHERE umo = ? ${where}
       ORDER BY pinned DESC, importance DESC, last_seen DESC
    `).all(umo)
  }

  _findFact(umo, { id, text } = {}) {
    if (Number.isInteger(Number(id)) && Number(id) > 0) {
      return this.db.prepare('SELECT * FROM facts WHERE id = ? AND umo = ?').get(Number(id), umo)
    }
    const normalized = factKey(String(text ?? ''))
    if (!normalized) return null
    return this.db.prepare('SELECT * FROM facts WHERE umo = ? AND normalized = ?').get(umo, normalized)
  }

  pinFact(umo, { id, text, pinned = true } = {}) {
    const fact = this._findFact(umo, { id, text })
    if (!fact) return { ok: false, reason: 'not-found' }
    this.db.prepare('UPDATE facts SET pinned = ?, archived = 0 WHERE id = ?').run(pinned ? 1 : 0, fact.id)
    this._event(pinned ? 'fact-pin' : 'fact-unpin', umo, { id: fact.id })
    return { ok: true, id: fact.id, pinned: Boolean(pinned) }
  }

  /** 默认归档：archived=1，保留可恢复；不硬删。 */
  forgetFact(umo, { id, text } = {}) {
    const fact = this._findFact(umo, { id, text })
    if (!fact) return { ok: false, reason: 'not-found' }
    this.db.prepare('UPDATE facts SET archived = 1, pinned = 0 WHERE id = ?').run(fact.id)
    this._event('fact-forget', umo, { id: fact.id })
    return { ok: true, id: fact.id, archived: true }
  }

  recordEpisode(umo, role, text, sessionId = null, { now = Date.now(), importance = 2 } = {}) {
    if (!umo) return 0
    const safe = safeEpisodeText(text)
    if (!safe) return 0
    const run = () => {
      this._touchContact(umo, now)
      return this.db.prepare(`
        INSERT INTO episodes(umo, role, text, ts, session_id, importance, archived)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `).run(umo, role === 'assistant' ? 'assistant' : 'user', safe, now, sessionId, clampImportance(importance, 2))
    }
    const info = this._tx(run)
    return Number(info.lastInsertRowid || 0)
  }

  _searchFacts(umo, query, limit = 8) {
    const value = String(query ?? '').normalize('NFKC')
    if (!value.trim()) return []
    const terms = value.match(/[\p{L}\p{N}]{2,}/gu) || []
    const expanded = new Set()
    for (const term of terms) {
      expanded.add(term)
      // 中文没有空格：补 2 字窗口，避免整句当 token 匹配不到。
      if (term.length > 2 && /[\u3400-\u9fff]/.test(term)) {
        for (let i = 0; i < term.length - 1; i += 1) expanded.add(term.slice(i, i + 2))
      }
      if (expanded.size >= 8) break
    }
    const tokens = [...expanded].filter(Boolean).slice(0, 8)
    const qv = hashVector(value)
    const rows = this.db.prepare(`
      SELECT * FROM facts
       WHERE umo = ? AND archived = 0
       ORDER BY last_seen DESC LIMIT 500
    `).all(umo)
    if (!rows.length) return []
    const now = Date.now()
    const scored = rows.map((fact) => {
      const sim = cosine(qv, hashVector(fact.text))
      const lowered = String(fact.text).normalize('NFKC').toLowerCase()
      const lexical = tokens.length
        ? tokens.reduce((n, t) => n + (lowered.includes(t.toLowerCase()) ? 1 : 0), 0) / tokens.length
        : 0
      const ageDays = Math.max(0, (now - Number(fact.last_seen || now)) / DAY_MS)
      const recency = Math.exp(-ageDays / 30)
      const score = 0.55 * sim
        + 0.25 * lexical
        + 0.12 * (clampImportance(fact.importance) / 5)
        + 0.08 * recency
        + (fact.pinned ? 0.2 : 0)
      return { fact, score }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((x) => x.fact)
  }

  /**
   * 把「已经滑出近期窗口」的 episode 压成阶段摘要。
   * 这里不做 LLM 调用：截取每轮摘要的前 100 字，去重后拼成 12 行以内的 digest。
   * 好处是确定、便宜、不会把联系人内容再发给任何 provider。
   */
  rollupSummaries({ now = Date.now(), windowDays = this.recentDays } = {}) {
    const cut = now - Math.max(1, Number(windowDays) || 7) * DAY_MS
    const umos = this.db.prepare('SELECT DISTINCT umo FROM episodes WHERE ts <= ?').all(cut)
    let created = 0
    for (const { umo } of umos) {
      const last = this.db.prepare('SELECT MAX(window_end) AS end FROM summaries WHERE umo = ?').get(umo)?.end || 0
      const rows = this.db.prepare(`
        SELECT role, text, ts FROM episodes
         WHERE umo = ? AND ts > ? AND ts <= ? AND archived = 0
         ORDER BY ts ASC LIMIT 200
      `).all(umo, last, cut)
      if (!rows.length) continue
      const lines = []
      const seen = new Set()
      for (const row of rows) {
        const text = String(row.text).replace(/\s+/g, ' ').trim().slice(0, 100)
        if (!text || seen.has(text)) continue
        seen.add(text)
        lines.push(`${row.role === 'assistant' ? '我' : '对方'}：${text}`)
        if (lines.length >= 12) break
      }
      const digest = lines.join('；').slice(0, 600)
      if (!digest) continue
      this.db.prepare(`
        INSERT INTO summaries(umo, window_start, window_end, text, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(umo, rows[0].ts, rows[rows.length - 1].ts, digest, now)
      this.db.prepare(`
        DELETE FROM summaries
         WHERE umo = ? AND id NOT IN (
           SELECT id FROM summaries WHERE umo = ? ORDER BY window_end DESC LIMIT 12
         )
      `).run(umo, umo)
      created += 1
    }
    if (created) this._event('summary-rollup', null, { created })
    return { created }
  }

  /** 夜间维护：先摘要（趁 episode 还在），再衰减/清理。 */
  maintenance(now = Date.now()) {
    const summaries = this.rollupSummaries({ now })
    const compacted = this.consolidate(now)
    return { ...summaries, ...compacted }
  }

  journalHasDay(day = localDay()) {
    return Boolean(this.db.prepare('SELECT id FROM journal WHERE day = ?').get(day))
  }

  recoveryWrite(umo, value, { now = Date.now() } = {}) {
    if (!umo) return { ok: false, reason: 'umo-required' }
    const verdict = validateRecovery(value)
    if (!verdict.ok) return verdict
    this.db.prepare(`
      INSERT INTO recovery_cards(umo, text, updated_at, revision) VALUES (?, ?, ?, 1)
      ON CONFLICT(umo) DO UPDATE SET text = excluded.text,
        updated_at = excluded.updated_at, revision = recovery_cards.revision + 1
    `).run(umo, JSON.stringify(verdict.value), now)
    this._event('recovery-write', umo, { chars: renderRecovery(verdict.value).length })
    return { ok: true }
  }

  recoveryRead(umo) {
    const row = this.db.prepare('SELECT text, updated_at, revision FROM recovery_cards WHERE umo = ?').get(umo)
    if (!row) return null
    try {
      const verdict = validateRecovery(JSON.parse(row.text))
      return verdict.ok ? { ...verdict.value, updatedAt: row.updated_at, revision: row.revision } : null
    } catch { return null }
  }

  selfState(now = Date.now()) {
    const row = this.db.prepare('SELECT state FROM persona_state WHERE id = 1 AND expires_at > ?').get(now)
    if (!row) return null
    try { return publicSelfState(JSON.parse(row.state)) } catch { return null }
  }

  /**
   * 只给 qq:inner 的夜间日记用。sealed=1；同一天只写一篇。
   * 内容仍过 guard（不把手机号/URL/密钥写进日记）。返回错误类别，不回传原文。
   */
  journalWrite(text, { now = Date.now(), mood = '', energy, expression, publishState = true } = {}) {
    const value = String(text ?? '').trim()
    if (!value) return { ok: false, reason: 'empty' }
    if (value.length > 1000) return { ok: false, reason: 'too-long' }
    const verdict = guardOutbound(value, 1000)
    if (!verdict.ok) return { ok: false, reason: verdict.category || 'blocked' }
    const day = localDay(now)
    const existing = this.db.prepare('SELECT id FROM journal WHERE day = ?').get(day)
    if (existing) return { ok: false, reason: 'already-written', id: existing.id }
    const state = publishState ? publicSelfState({ mood, energy, expression }) : null
    const info = this._tx(() => {
      const inserted = this.db.prepare(`
        INSERT INTO journal(ts, day, text, mood, sealed) VALUES (?, ?, ?, ?, 1)
      `).run(now, day, verdict.text, String(mood ?? '').slice(0, 40))
      if (state) this.db.prepare(`
        INSERT INTO persona_state(id, state, updated_at, expires_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET state = excluded.state,
          updated_at = excluded.updated_at, expires_at = excluded.expires_at
      `).run(JSON.stringify(state), now, now + DAY_MS)
      return inserted
    })
    this._event('journal-write', null, { id: Number(info.lastInsertRowid), chars: verdict.text.length })
    return { ok: true, id: Number(info.lastInsertRowid), day }
  }

  journalRead(limit = 5) {
    return this.db.prepare(`
      SELECT id, ts, day, text, mood FROM journal
       WHERE sealed = 1 ORDER BY ts DESC LIMIT ?
    `).all(Math.max(1, Math.min(30, Number(limit) || 5)))
  }

  /** 她最近说过的话（只取 assistant 侧，不含联系人原文），给夜间日记做上下文。 */
  recentAssistantTexts({ hours = 24, limit = 8 } = {}) {
    const since = Date.now() - Math.max(1, Number(hours) || 24) * 3_600_000
    return this.db.prepare(`
      SELECT text, ts FROM episodes
       WHERE role = 'assistant' AND ts >= ? AND archived = 0
       ORDER BY ts DESC LIMIT ?
    `).all(since, Math.max(1, Math.min(30, Number(limit) || 8)))
  }

  listUmos() {
    return this.db.prepare(`
      SELECT umo, first_seen, last_seen FROM contacts ORDER BY last_seen DESC
    `).all()
  }

  stats(umo) {    const facts = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived,
             SUM(CASE WHEN pinned = 1 AND archived = 0 THEN 1 ELSE 0 END) AS pinned
        FROM facts WHERE umo = ?
    `).get(umo)
    const episodes = this.db.prepare('SELECT COUNT(*) AS n, MAX(ts) AS last FROM episodes WHERE umo = ?').get(umo)
    const summaries = this.db.prepare('SELECT COUNT(*) AS n, MAX(window_end) AS last FROM summaries WHERE umo = ?').get(umo)
    const page = this.db.prepare('PRAGMA page_count').get()
    const size = this.db.prepare('PRAGMA page_size').get()
    return {
      umo,
      facts: {
        total: Number(facts?.total || 0),
        active: Number(facts?.active || 0),
        archived: Number(facts?.archived || 0),
        pinned: Number(facts?.pinned || 0),
      },
      episodes: { total: Number(episodes?.n || 0), last: episodes?.last || null },
      summaries: { total: Number(summaries?.n || 0), last: summaries?.last || null },
      dbBytes: Number(page?.page_count || 0) * Number(size?.page_size || 0),
    }
  }

  exportUmo(umo, { includeArchived = true } = {}) {
    return {
      umo,
      contact: this.db.prepare('SELECT * FROM contacts WHERE umo = ?').get(umo) || null,
      recovery: this.recoveryRead(umo),
      facts: this.listFacts(umo, { includeArchived }),
      episodes: this.db.prepare(`
        SELECT role, text, ts, session_id, importance, archived FROM episodes
         WHERE umo = ? ORDER BY ts ASC
      `).all(umo),
      summaries: this.db.prepare(`
        SELECT window_start, window_end, text, created_at FROM summaries
         WHERE umo = ? ORDER BY window_end ASC
      `).all(umo),
    }
  }

  /** 只有本地 CLI 会调用：真正的硬删除。QQ 对话里只暴露归档式 forget。 */
  hardDeleteFact(umo, { id, text } = {}) {
    const fact = this._findFact(umo, { id, text })
    if (!fact) return { ok: false, reason: 'not-found' }
    this.db.prepare('DELETE FROM facts WHERE id = ?').run(fact.id)
    this._event('fact-purge', umo, { id: fact.id })
    return { ok: true, id: fact.id, purged: true }
  }

  render(umo, { query = '', now = Date.now(), includeRecent = true, knownKeys = new Set(), maxChars = this.maxRenderChars } = {}) {
    const renderLimit = Math.max(1, Math.min(this.maxRenderChars, Number(maxChars) || this.maxRenderChars))
    const sections = []
    let used = 0
    const includedFacts = new Set()
    const addGroup = (title, items, budget, reverse = false) => {
      const selected = []
      let size = title.length + 1
      for (const item of items) {
        const key = noteKey(item.key || item.text)
        if (knownKeys.has(key)) continue
        const cost = item.text.length + 1
        if (size + cost > budget || used + size + cost > renderLimit) continue
        selected.push({ ...item, key })
        size += cost
      }
      if (!selected.length) return
      if (reverse) selected.reverse()
      sections.push(title, ...selected.map((item) => item.text))
      used += size
      for (const item of selected) {
        knownKeys.add(item.key)
        if (item.id) includedFacts.add(item.id)
      }
    }

    const contact = this.db.prepare('SELECT summary FROM contacts WHERE umo = ?').get(umo)
    const stage = this.db.prepare(`
      SELECT text FROM summaries WHERE umo = ? ORDER BY window_end DESC LIMIT 1
    `).get(umo)
    const pinned = this.db.prepare(`
      SELECT id, text, kind, importance FROM facts
       WHERE umo = ? AND pinned = 1 AND archived = 0
       ORDER BY importance DESC, last_seen DESC LIMIT 20
    `).all(umo)
    const important = this.db.prepare(`
      SELECT id, text, kind, importance FROM facts
       WHERE umo = ? AND pinned = 0 AND archived = 0
       ORDER BY importance DESC, last_seen DESC LIMIT 12
    `).all(umo)
    const since = now - this.recentDays * DAY_MS
    const recent = includeRecent ? this.db.prepare(`
      SELECT role, text, ts FROM episodes
       WHERE umo = ? AND ts >= ? AND archived = 0
       ORDER BY ts DESC, id DESC LIMIT ?
    `).all(umo, since, Math.min(this.recentLimit, this.recentRenderLimit)) : []
    const relevant = query ? this._searchFacts(umo, query, 4) : []

    const factItems = (facts) => facts.map((fact) => ({ id: fact.id, text: `- ${fact.text}`, key: `fact:${fact.id}:${fact.text}` }))
    // 分区预算避免 pinned/阶段摘要挤掉最新话题或相关事实。
    const factBudget = Math.min(260, Math.floor(renderLimit * 0.15))
    addGroup('【核心记忆】', factItems(pinned), factBudget)
    const recovery = this.recoveryRead(umo)
    if (recovery) addGroup('【恢复卡】', renderRecovery(recovery).split('\n').map((text) => ({ text: `- ${text}`, key: `recovery:${recovery.revision}:${text}` })), includeRecent ? Math.floor(renderLimit * 0.4) : Math.min(900, renderLimit - 2 * factBudget))
    addGroup('【相关记忆】', factItems(relevant), factBudget)
    addGroup(`【最近 ${this.recentDays} 天 / 展示至多 ${this.recentRenderLimit} 条】`, recent.map((row) => ({
      text: `- ${fmtTime(row.ts)} ${row.role === 'assistant' ? '我' : '对方'}：${String(row.text).replace(/\s+/g, ' ').slice(0, 160)}`,
      key: `episode:${row.ts}:${row.role}:${row.text}`,
    })), renderLimit - used, true)
    addGroup('【记得的事】', factItems(important.slice(0, 4)), renderLimit - used)
    if (!recovery && (contact?.summary || stage?.text)) addGroup('【阶段记忆】', [{ text: `- ${String(contact?.summary || stage.text).replace(/\s+/g, ' ').slice(0, 300)}` }], renderLimit - used)
    if (!sections.length) return ''

    // 被注入的 facts 记一次访问，供以后排序/衰减参考。
    if (includedFacts.size) {
      try {
        const ids = [...includedFacts]
        this.db.prepare(`UPDATE facts SET access_count = access_count + 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
      } catch { /* ignore */ }
    }
    return sections.join('\n')
  }

  migrateLegacy(umo, card, mdLines = [], { now = Date.now() } = {}) {
    const key = `legacy:${umo}`
    const done = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    if (done) return { skipped: true, added: 0, updated: 0 }
    const facts = []
    if (card && Array.isArray(card.facts)) {
      for (const f of card.facts) facts.push(f?.text || f)
    }
    for (const line of Array.isArray(mdLines) ? mdLines : []) facts.push(line)
    const result = this.writeFacts(umo, facts.filter(Boolean).slice(0, 40), {
      now,
      source: 'legacy',
      allowInstructionLike: true,
    })
    if (card?.summary) {
      this.db.prepare('UPDATE contacts SET summary = ? WHERE umo = ?').run(String(card.summary), umo)
    }
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, String(now))
    return { skipped: false, ...result }
  }

  consolidate(now = Date.now()) {
    if (!this.db) return { archived: 0, episodesDeleted: 0 }
    let archived = 0
    const facts = this.db.prepare('SELECT id, importance, pinned, last_seen FROM facts WHERE archived = 0 AND pinned = 0').all()
    const archive = this.db.prepare('UPDATE facts SET archived = 1 WHERE id = ?')
    this._tx(() => {
      for (const fact of facts) {
        if (retentionScore(fact, now) < ARCHIVE_THRESHOLD) {
          archive.run(fact.id)
          archived += 1
        }
      }
    })
    const oldBefore = now - EPISODE_MAX_AGE_DAYS * DAY_MS
    let episodesDeleted = 0
    try {
      const info = this.db.prepare('DELETE FROM episodes WHERE ts < ?').run(oldBefore)
      episodesDeleted += Number(info.changes || 0)
      for (const { umo } of this.db.prepare('SELECT DISTINCT umo FROM episodes').all()) {
        const info2 = this.db.prepare(`
          DELETE FROM episodes
           WHERE umo = ? AND id NOT IN (
             SELECT id FROM episodes WHERE umo = ? ORDER BY ts DESC LIMIT ?
           )
        `).run(umo, umo, EPISODE_KEEP)
        episodesDeleted += Number(info2.changes || 0)
      }
    } catch { /* ignore */ }
    if (archived || episodesDeleted) this._event('consolidate', null, { archived, episodesDeleted })
    return { archived, episodesDeleted }
  }
}
