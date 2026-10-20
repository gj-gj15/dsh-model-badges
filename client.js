/**
 * dsh-model-badges — 浏览器端。
 *
 * 贡献：
 *   1. 对话输入框模型快速选单的彩色角标（[data-model-id]::after，绿=快·稳/黄=中/红=不可用），
 *      覆盖网关全量模型（完整 ID + 简写别名）。
 *   2. 设置页「模型体检」section：评级统计、模型评级表、「立即重新测试」按钮。
 *
 * 数据来自插件自己的 /api/model-badges/* 路由（同源），不依赖其他插件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-badges',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const NS = 'settings.modelBadges'
    const inject = ['slots', 'locale']

    const DICT = {
      zh: {
        'nav': '模型体检',
        'title': '大模型选单实测速度角标',
        'sub': '上次评测：{at} · 每次启动 dsh 约 15 秒后自动复测',
        'green': '快·稳',
        'yellow': '中',
        'red': '不可用',
        'rerun': '立即重新测试',
        'running': '测试中…',
        'benchStarted': '已开始后台基准测试，全部模型测完约需几分钟，页面会定时刷新',
        'colModel': '模型 ID',
        'colRating': '评级',
        'colNote': '说明',
        'empty': '暂无数据（等待自动评测或点击「立即重新测试」）',
        'refresh': '刷新',
      },
      en: {
        'nav': 'Model Badges',
        'title': 'Model Speed Badges',
        'sub': 'Last run: {at} · auto re-bench 15s after each dsh start',
        'green': 'Fast',
        'yellow': 'Slow',
        'red': 'Unavailable',
        'rerun': 'Re-bench now',
        'running': 'Running…',
        'benchStarted': 'Bench started, will refresh automatically in a few minutes',
        'colModel': 'Model',
        'colRating': 'Rating',
        'colNote': 'Note',
        'empty': 'No data yet. Waiting for auto bench or click "Re-bench now".',
        'refresh': 'Refresh',
      },
    }

    // 用页面 base 解析，兼容 dsh 挂在反向代理子路径下的情况
    const API = (() => {
      try { return new URL('api/model-badges', document.baseURI).pathname } catch { return '/api/model-badges' }
    })()

    async function api(path, options) {
      const { timeout = 8000, ...fetchOptions } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...fetchOptions, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    // ── 样式 ───────────────────────────────────────────────────────────────────
    const CSS = `
/* ══ dsh-model-badges：设置页样式 ═════════════════════════ */
.mb-wrap{font-size:13px;line-height:1.6;color:var(--text,#1f2d3d)}
.mb-head{margin-bottom:14px}
.mb-head h3{margin:0 0 4px;font-size:16px}
.mb-sub{color:var(--text-2,#5c6f84);font-size:12px;margin-bottom:10px}
.mb-stats{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.mb-pill{display:inline-block;font-size:12px;font-weight:700;padding:2px 10px;border-radius:999px;border:1px solid}
.mb-green{color:#0e9f6e;background:rgba(14,159,110,.12);border-color:rgba(14,159,110,.45)}
.mb-yellow{color:#b45309;background:rgba(240,164,65,.14);border-color:rgba(240,164,65,.5)}
.mb-red{color:#c81e1e;background:rgba(200,30,30,.1);border-color:rgba(200,30,30,.4)}
.mb-btn{margin-left:auto;padding:5px 14px;border-radius:8px;border:1px solid var(--line,#dbe6f2);background:var(--bg,#f5f8fc);color:var(--text,#1f2d3d);font-size:12px;font-weight:600;cursor:pointer}
.mb-btn:hover{background:var(--bg-2,#eaf2fe)}
.mb-btn:disabled{opacity:.5;cursor:wait}
.mb-msg{margin-top:8px;font-size:12px;color:#b45309}
.mb-table{width:100%;border-collapse:collapse;font-size:12.5px}
.mb-table th{text-align:left;color:var(--text-2,#5c6f84);font-size:11.5px;padding:6px 8px;border-bottom:2px solid var(--line,#dbe6f2)}
.mb-table td{padding:6px 8px;border-bottom:1px solid #edf3f9;vertical-align:middle}
.mb-model{font-weight:600;white-space:nowrap;font-family:ui-monospace,Consolas,monospace;font-size:11.5px}
.mb-badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;border:1px solid;white-space:nowrap}
.mb-note{color:var(--text-2,#5c6f84);font-size:11.5px;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mb-na{color:#9aa8b8}
.mb-empty{text-align:center;color:#9aa8b8;padding:18px}
.mb-refresh{float:right}
`

    // 快速选单角标 CSS：data-model-id 属性选择器（完整 ID + 简写别名）
    function perfCssFor(catalog) {
      const rules = (catalog ?? [])
        .filter(entry => entry?.perf !== undefined && typeof entry.perf.label === 'string' && typeof entry.perf.level === 'string')
        .map(entry => {
          const level = entry.perf.level
          const color = level === 'green' ? '#0e9f6e' : level === 'yellow' ? '#b45309' : '#c81e1e'
          const bg = level === 'green' ? '#e6f7f0' : level === 'yellow' ? '#fdf0dc' : '#fdeaea'
          const border = level === 'green' ? '#b7e4d2' : level === 'yellow' ? '#f2d9a6' : '#f0b9b9'
          const selectors = [entry.id, ...(entry.aliases ?? [])]
            .filter(Boolean)
            .map(id => `[data-model-id="${id}"]::after`)
            .join(',')
          return `${selectors}{content:"${entry.perf.label}";display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:700;color:${color};background:${bg};border:1px solid ${border}}`
        })
      return rules.join('\n')
    }

    // ── 设置页组件 ─────────────────────────────────────────────────────────────
    function SettingsPage(props) {
      const ctx = props.ctx
      const t = ctx.locale.bind(NS)
      const [summary, setSummary] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')

      const load = useCallback(() => {
        api('/summary').then(payload => setSummary(payload)).catch(() => setSummary(null))
      }, [])
      useEffect(() => { load() }, [load])

      const runBench = () => {
        if (busy) return
        setBusy(true)
        setMsg('')
        api('/bench', { method: 'POST', timeout: 15000 })
          .then(() => setMsg(t('benchStarted')))
          .catch(err => setMsg(String(err?.message ?? err)))
          .finally(() => {
            setTimeout(() => { setBusy(false); load() }, 3000)
          })
      }

      const badges = summary?.badges ?? {}
      const catalog = summary?.catalog ?? []
      const counts = { green: 0, yellow: 0, red: 0 }
      for (const item of catalog) {
        const lv = item?.perf?.level
        if (lv) counts[lv] = (counts[lv] ?? 0) + 1
      }
      const atText = summary?.at
        ? new Date(summary.at).toLocaleString()
        : '—'

      const rows = catalog.length === 0
        ? [h('tr', { key: 'empty' }, h('td', { colSpan: 3, className: 'mb-empty' }, t('empty')))]
        : catalog.map(item => {
            const p = item?.perf
            const badgeCls = p?.level === 'green' ? 'mb-green' : p?.level === 'yellow' ? 'mb-yellow' : 'mb-red'
            return h('tr', { key: item.id },
              h('td', { className: 'mb-model' }, item.id),
              h('td', null, p
                ? h('span', { className: `mb-badge ${badgeCls}`, title: p.note ?? '' }, p.label)
                : h('span', { className: 'mb-na' }, '—')),
              h('td', { className: 'mb-note', title: p?.note ?? '' }, p?.note ?? '—'))
          })

      return h('div', { className: 'mb-wrap' },
        h('div', { className: 'mb-head' },
          h('button', { className: 'mb-btn mb-refresh', onClick: load }, t('refresh')),
          h('h3', null, t('title')),
          h('div', { className: 'mb-sub' }, t('sub', { at: atText })),
          h('div', { className: 'mb-stats' },
            h('span', { className: 'mb-pill mb-green' }, `🟢 ${t('green')}: ${counts.green}`),
            h('span', { className: 'mb-pill mb-yellow' }, `🟡 ${t('yellow')}: ${counts.yellow}`),
            h('span', { className: 'mb-pill mb-red' }, `🔴 ${t('red')}: ${counts.red}`),
            h('button', { className: 'mb-btn', disabled: busy, onClick: runBench }, busy ? t('running') : t('rerun')),
          ),
          msg ? h('div', { className: 'mb-msg' }, msg) : null,
        ),
        h('table', { className: 'mb-table' },
          h('thead', null,
            h('tr', null,
              h('th', null, t('colModel')),
              h('th', null, t('colRating')),
              h('th', null, t('colNote')))),
          h('tbody', null, rows)))
    }

    // ── 插件入口 ───────────────────────────────────────────────────────────────
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'model-badges: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-model-badges')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'model-badges: styles')

      // 快速选单角标：拉取 /summary，动态生成 [data-model-id]::after CSS
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-model-badges-perf')
        document.head.appendChild(style)
        let alive = true
        const render = catalog => { style.textContent = perfCssFor(catalog) }
        api('/summary').then(payload => { if (alive) render(payload?.catalog) }).catch(() => {})
        const refreshTimer = setInterval(() => {
          api('/summary').then(payload => { if (alive) render(payload?.catalog) }).catch(() => {})
        }, 60000)
        return () => { alive = false; clearInterval(refreshTimer); style.remove() }
      }, 'model-badges: perf badges')

      // 设置页 section
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'model-badges',
        order: 36,
        label: () => t('nav'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, ctx })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'model-badges'
    return module.exports
  },
})