/**
 * dsh-model-badges — 大模型选单实测速度角标（独立插件，不依赖外部脚本）。
 *
 * 功能：
 *   1. dsh 启动 15 秒后自动跑一轮轻量基准测试（读取 ~/.dsh/our-free-model/catalog.json
 *      的模型清单，通过本地 OpenAI 网关 8326 实测 TTFT/成功率）。
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
export const version = '1.0.0'
export const inject = []

const GATEWAY = 'http://127.0.0.1:8326'

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const home = process.env.USERPROFILE || os.homedir()
  const DATA_DIR = path.join(home, '.dsh', 'model-badges')
  const OFM_DIR = path.join(home, '.dsh', 'our-free-model')
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
      // 镜像到 our-free-model 的 perf-badges.json：让 dsh 选单角标直接使用本插件评级。
      // 这是 best-effort：即使 our-free-model 目录不存在/不可写，也不影响本插件自身数据。
      try {
        const mirrorPath = path.join(home, '.dsh', 'our-free-model', 'perf-badges.json')
        fs.mkdirSync(path.dirname(mirrorPath), { recursive: true })
        fs.writeFileSync(mirrorPath, JSON.stringify(data, null, 2), 'utf8')
      } catch { /* mirror is best-effort */ }
      return true
    } catch (err) {
      logger.warn?.(`model-badges: failed to write badges: ${err?.message ?? err}`)
      return false
    }
  }

  // ── 模型清单：优先 our-free-model 的 catalog；不存在则回退网关 /v1/models ──
  const loadCatalog = async () => {
    try {
      const cat = JSON.parse(fs.readFileSync(path.join(OFM_DIR, 'catalog.json'), 'utf8'))
      const ids = new Set()
      for (const e of cat.entries ?? []) ids.add(e)
      for (const e of cat.sealIds ?? []) ids.add(e)
      for (const k of cat.kiloRows ?? []) ids.add(k.id)
      if (ids.size > 0) return [...ids].sort()
    } catch { /* fall through */ }
    // 回退：从网关模型列表推导简写 ID（our-free-model/ 前缀）
    try {
      const key = loadApiKey()
      const resp = await fetch(`${GATEWAY}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })
      if (resp.ok) {
        const data = await resp.json()
        const ids = (data.data ?? [])
          .map(m => String(m.id ?? ''))
          .filter(id => id.startsWith('our-free-model/'))
          .map(id => id.slice('our-free-model/'.length))
          .filter(id => id.length > 0 && !id.includes('/v1/'))
        return [...new Set(ids)].sort()
      }
    } catch { /* ignore */ }
    return []
  }

  const loadApiKey = () => {
    try {
      return fs.readFileSync(API_KEY_PATH, 'utf8').trim()
    } catch {
      return ''
    }
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
  const probeModelOnce = async (modelId, timeoutMs = 40000) => {
    const key = loadApiKey()
    if (!key) return { ok: false, ttftMs: 0, error: 'no api key' }
    const body = JSON.stringify({
      model: `our-free-model/${modelId}`,
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
    const catalog = await loadCatalog()
    if (catalog.length === 0) {
      logger.warn?.('model-badges: no models in catalog, skip auto bench')
      return true
    }
    logger.info?.(`model-badges: auto bench starting with ${catalog.length} models`)
    const perf = loadPerfBadges()
    const badges = perf.badges ?? {}
    let cursor = 0
    const worker = async () => {
      while (cursor < catalog.length) {
        const id = catalog[cursor++]
        const existing = badges[id] ?? {}
        const samples = Array.isArray(existing.samples) ? existing.samples.slice() : []
        const result = await probeModelOnce(id)
        samples.push({ at: Date.now(), ok: result.ok, ttftMs: result.ok ? result.ttftMs : undefined })
        while (samples.length > 10) samples.shift()
        const okCount = samples.filter(s => s.ok).length
        const rate = okCount / samples.length
        const okSamples = samples.filter(s => s.ok)
        const ttftAvg = okSamples.length
          ? okSamples.reduce((sum, s) => sum + (s.ttftMs ?? 0), 0) / okSamples.length
          : 0
        const level = badgeLevelFor(rate, ttftAvg)
        badges[id] = {
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
    const catalog = await loadCatalog()
    return {
      version: 1,
      at: perf.at ?? 0,
      source: perf.source ?? '',
      badges: perf.badges ?? {},
      catalog: catalog.map(id => {
        const p = (perf.badges ?? {})[id]
        return {
          id,
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