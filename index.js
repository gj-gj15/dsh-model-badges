/**
 * dsh-model-badges — 大模型选单实测速度角标（独立插件，不依赖外部脚本）。
 *
 * 功能：
 *   1. dsh 启动 15 秒后自动跑一轮轻量基准测试：模型清单来自本地 OpenAI 网关
 *      /v1/models 的「全量模型」+ our-free-model / opencode-free-model 插件
 *      catalog 补充，覆盖 dsh 大模型选单里的所有模型通道。
 *   2. 评级写入 ~/.dsh/model-badges/perf-badges.json（绿=快·稳 / 黄=中 / 红=不可用）。
 *   3. 提供 /api/model-badges/* 路由：GET /summary 返回评级+目录；POST /bench 手动重测。
 *   4. 浏览器端 client.js 拉取 /summary 动态生成快速选单彩色角标与设置页评级表。
 *
 * @module index.js
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const name = 'model-badges'
export const version = '1.1.0'
export const inject = []

const GATEWAY = 'http://127.0.0.1:8326'

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const home = process.env.USERPROFILE || os.homedir()
  const DATA_DIR = path.join(home, '.dsh', 'model-badges')
  const OFM_DIR = path.join(home, '.dsh', 'our-free-model')
  const OPENCODE_DIR = path.join(home, '.dsh', 'opencode-free-model')
  const API_KEY_PATH = path.join(home, '.dsh', 'openai-gateway', 'api-key')

  fs.mkdirSync(DATA_DIR, { recursive: true })

  // ── 数据读写 ──────────────────────────────────────────────────────────────
  const badgesFile = () => path.join(DATA_DIR, 'perf-badges.json')
  const loadPerfBadges = () => {
    try {
      return JSON.parse(fs.readFileSync(badgesFile(), 'utf8'))
    } catch {
      return { version: 1, at: 0, source: 'auto-bench', badges: {} }
    }
  }
  const savePerfBadges = data => {
    try {
      fs.writeFileSync(badgesFile(), JSON.stringify(data, null, 2), 'utf8')
      // 镜像到各插件目录：让 dsh 既有选单角标也能直接使用本插件评级。
      for (const dir of [OFM_DIR, OPENCODE_DIR]) {
        try {
          const mirrorPath = path.join(dir, 'perf-badges.json')
          fs.mkdirSync(path.dirname(mirrorPath), { recursive: true })
          fs.writeFileSync(mirrorPath, JSON.stringify(data, null, 2), 'utf8')
        } catch { /* mirror is best-effort */ }
      }
      return true
    } catch (err) {
      logger.warn?.(`model-badges: failed to write badges: ${err?.message ?? err}`)
      return false
    }
  }

  const loadApiKey = () => {
    try {
      return fs.readFileSync(API_KEY_PATH, 'utf8').trim()
    } catch {
      return ''
    }
  }

  // ── 模型清单：网关 /v1/models 全量 + 插件 catalog 补充 ─────────────────────
  // 返回 { catalog: [{ id, aliases, model }], models: [model, ...] }
  // - id:      角标匹配主 ID（即可调用的完整模型 ID）
  // - aliases: 该模型在选单里可能出现的其他 data-model-id（含简写）
  // - model:   测速请求使用的 model 参数（与 id 相同）
  const loadModelCatalog = async () => {
    const byModel = new Map() // model -> { id, aliases: Set, model }

    const addModel = (model, alias) => {
      if (!model) return
      let entry = byModel.get(model)
      if (!entry) {
        entry = { id: model, aliases: new Set(), model }
        byModel.set(model, entry)
      }
      if (alias) entry.aliases.add(alias)
    }

    // 1) 网关全量模型（主清单，覆盖所有选单通道）
    const gwByShort = new Map() // 简写 -> [完整ID, ...]
    try {
      const key = loadApiKey()
      const resp = await fetch(`${GATEWAY}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
      })
      if (resp.ok) {
        const data = await resp.json()
        for (const m of data.data ?? []) {
          const id = String(m.id ?? '').trim()
          if (!id || id.includes('/v1/')) continue
          addModel(id, id)
          const slash = id.indexOf('/')
          if (slash > 0 && slash < id.length - 1) {
            const short = id.slice(slash + 1)
            addModel(id, short)
            if (!gwByShort.has(short)) gwByShort.set(short, [])
            gwByShort.get(short).push(id)
          }
        }
      }
    } catch { /* gateway may be down; fall back to catalogs */ }

    // 2) 插件 catalog 补充（our-free-model / opencode-free-model 的简写与直写 ID）
    const ensureAliasOnGateway = (short, alias) => {
      const gwIds = gwByShort.get(short)
      if (gwIds && gwIds.length > 0) {
        for (const gid of gwIds) addModel(gid, alias)
        return true
      }
      return false
    }

    for (const dir of [OFM_DIR, OPENCODE_DIR]) {
      try {
        const cat = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'))
        for (const e of cat.entries ?? []) {
          if (typeof e === 'string' && e) {
            if (!ensureAliasOnGateway(e, e)) addModel(`our-free-model/${e}`, e)
          }
        }
        for (const e of cat.sealIds ?? []) {
          if (typeof e === 'string' && e) {
            if (!ensureAliasOnGateway(e, e)) addModel(`our-free-model/${e}`, e)
          }
        }
        for (const k of cat.kiloRows ?? []) {
          if (k && typeof k.id === 'string' && k.id) {
            if (!ensureAliasOnGateway(k.id, k.id)) addModel(`our-free-model/${k.id}`, k.id)
          }
        }
      } catch { /* ignore catalog */ }
    }

    const catalog = [...byModel.values()]
      .map(entry => ({ id: entry.id, aliases: [...entry.aliases].sort(), model: entry.model }))
      .sort((a, b) => a.id.localeCompare(b.id))
    return { catalog, models: catalog.map(entry => entry.model) }
  }

  // ── 评级规则 ──────────────────────────────────────────────────────────────
  const badgeLevelFor = (rate, ttftAvg) => {
    if (rate <= 0.6 || ttftAvg >= 8000) return 'red'
    if (ttftAvg < 3000 && rate >= 0.9) return 'green'
    if (ttftAvg < 8000) return 'yellow'
    return 'red'
  }
  const badgeLabelFor = level => level === 'green' ? '快·稳' : level === 'yellow' ? '中' : '不可用'

  // ── 单模型探测（HTTP 流式，测 TTFT）───────────────────────────────────────
  const probeModelOnce = async (modelId, timeoutMs = 35000) => {
    const key = loadApiKey()
    if (!key) return { ok: false, ttftMs: 0, error: 'no api key' }
    const body = JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      stream: true,
      max_tokens: 16,
      store: false,
    })
    const started = Date.now()
    let firstFrame = null
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      timer.unref?.()
      let resp
      try {
        resp = await fetch(`${GATEWAY}/v1/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body,
          signal: ctrl.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '')
        return { ok: false, ttftMs: 0, error: `HTTP ${resp.status}: ${text.slice(0, 160)}` }
      }
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') continue
          try {
            const obj = JSON.parse(data)
            if (obj?.error) {
              const msg = typeof obj.error === 'string' ? obj.error : (obj.error?.message ?? '')
              return { ok: false, ttftMs: 0, error: msg.slice(0, 160) }
            }
            const delta = obj?.choices?.[0]?.delta ?? {}
            if (delta?.content || delta?.reasoning_content) {
              firstFrame = Date.now() - started
              break
            }
          } catch { /* skip malformed frame */ }
        }
        if (firstFrame !== null) break
      }
      return {
        ok: firstFrame !== null,
        ttftMs: firstFrame ?? 0,
        error: firstFrame === null ? 'no content in stream' : null,
      }
    } catch (err) {
      return { ok: false, ttftMs: 0, error: String(err?.message ?? err).slice(0, 160) }
    }
  }

  // ── 自动基准测试（6 并发，滚动保留每模型 10 条样本）────────────────────────
  const runAutoBench = async () => {
    const { catalog, models } = await loadModelCatalog()
    if (models.length === 0) {
      logger.warn?.('model-badges: no models in catalog, skip auto bench')
      return true
    }
    logger.info?.(`model-badges: auto bench starting with ${models.length} models`)
    const perf = loadPerfBadges()
    const badges = perf.badges ?? {}
    let cursor = 0
    const worker = async () => {
      while (cursor < models.length) {
        const model = models[cursor++]
        const existing = badges[model] ?? {}
        const samples = Array.isArray(existing.samples) ? existing.samples.slice() : []
        const result = await probeModelOnce(model)
        samples.push({ at: Date.now(), ok: result.ok, ttftMs: result.ok ? result.ttftMs : undefined })
        while (samples.length > 10) samples.shift()
        const okCount = samples.filter(s => s.ok).length
        const rate = okCount / samples.length
        const okSamples = samples.filter(s => s.ok)
        const ttftAvg = okSamples.length
          ? okSamples.reduce((sum, s) => sum + (s.ttftMs ?? 0), 0) / okSamples.length
          : 0
        const level = badgeLevelFor(rate, ttftAvg)
        badges[model] = {
          level,
          label: badgeLabelFor(level),
          note: `自动评测：${samples.length} 次样本，成功率 ${Math.round(rate * 100)}%，平均 TTFT ${Math.round(ttftAvg)}ms${result.ok ? '' : `；最近失败: ${result.error ?? 'unknown'}`}`,
          samples,
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, () => worker()))
    savePerfBadges({ version: 1, at: Date.now(), source: 'auto-bench', badges })
    logger.info?.(`model-badges: auto bench finished, ${Object.keys(badges).length} models rated`)
    return true
  }

  // 每次进程启动只跑一次（热重载不重复）
  const AUTO_BENCH_RAN = Symbol.for('dsh-model-badges.auto-bench-ran')
  if (globalThis[AUTO_BENCH_RAN] !== true) {
    globalThis[AUTO_BENCH_RAN] = true
    let attempts = 0
    const tryBench = () => {
      attempts += 1
      runAutoBench().then(done => {
        if (!done && attempts < 6) setTimeout(tryBench, 30000).unref?.()
      }).catch(() => {})
    }
    setTimeout(tryBench, 15000).unref?.()
  }

  // ── API 路由 ───────────────────────────────────────────────────────────────
  const buildSummary = async () => {
    const perf = loadPerfBadges()
    const { catalog } = await loadModelCatalog()
    return {
      version: 1,
      at: perf.at ?? 0,
      source: perf.source ?? '',
      badges: perf.badges ?? {},
      catalog: catalog.map(entry => {
        const p = (perf.badges ?? {})[entry.model]
        return {
          id: entry.id,
          aliases: entry.aliases,
          perf: p === undefined ? undefined : { level: p.level, label: p.label, note: p.note },
        }
      }),
    }
  }

  const api = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/model-badges/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }
    try {
      if (method === 'GET' && routePath === '/summary') {
        return send(200, await buildSummary())
      }
      if (method === 'POST' && routePath === '/bench') {
        // 后台触发一轮完整基准测试，立即返回；客户端随后轮询 /summary 刷新。
        runAutoBench().catch(() => {})
        return send(200, { ok: true, message: 'bench started' })
      }
      if (method === 'GET' && routePath === '/badges') {
        const perf = loadPerfBadges()
        return send(200, { at: perf.at ?? 0, source: perf.source ?? '', badges: perf.badges ?? {} })
      }
      return send(404, { error: `unknown route ${method} ${routePath}` })
    } catch (err) {
      logger.warn?.(`model-badges: api error: ${err?.stack ?? err}`)
      return send(500, { error: String(err?.message ?? err) })
    }
  }

  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(
      () => server.register({ kind: 'prefix', path: '/api/model-badges', handler: api }),
      'model-badges: api routes'
    )
  })
}