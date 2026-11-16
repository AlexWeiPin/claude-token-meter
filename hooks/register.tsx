import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import type {
  AgentRow,
  BoardTile,
  Breakdown,
  Limit,
  OrderMessage,
  SkillUse,
  UsageSnap,
} from '../types'

const PANE = 'token-meter'
const TITLE = 'Claude 監控'
const ORDER_KEY = 'order'
// 分類細項（本機估算）最快多久重算一次
const BREAKDOWN_EVERY_MS = 4_000
// 額度是整個帳號共用的：各 session 把讀到的數字放進共用儲存區，互相補最新的
const LIMITS_KEY = 'limits-latest'
const LIMITS_SYNC_MS = 30_000
// 重置時間差在這之內視為同一個時間窗
const SAME_WINDOW_MS = 5 * 60_000

const usageAtom = atom({ plugin: 'token-meter', key: 'usage' } as const, null, {
  shape: 'usage-1',
})
const breakdownAtom = atom({ plugin: 'token-meter', key: 'breakdown' } as const, null, {
  shape: 'breakdown-4',
})
const agentsAtom = atom({ plugin: 'token-meter', key: 'agents' } as const, [], {
  shape: 'agents-2',
})
const skillUsesAtom = atom({ plugin: 'token-meter', key: 'skillUses' } as const, [], {
  shape: 'skill-uses-2',
})
const activeSkillsAtom = atom({ plugin: 'token-meter', key: 'activeSkills' } as const, [])
// 每秒 +1，只有終端機版會讀它（桌面版用 SVG／小時鐘自己動，不需要整個重繪）
const tickAtom = atom({ plugin: 'token-meter', key: 'tick' } as const, 0)
const orderAtom = atom({ plugin: 'token-meter', key: 'order' } as const, [])
// 收起來的區塊（跨 session 存在 $.store）
const collapsedAtom = atom({ plugin: 'token-meter', key: 'collapsed' } as const, [])
const COLLAPSED_KEY = 'collapsed'

type Api = EngineInterface

// ---------- 小工具 ----------

const clamp = (n: number) => Math.max(0, Math.min(100, n))
const round1 = (n: number) => Math.round(n * 10) / 10

function levelColor(remaining: number): string {
  if (remaining >= 50) return 'success'
  if (remaining >= 20) return 'warning'
  return 'error'
}

function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5 小時額度'
  if (kind === 'seven_day') return '每週額度'
  if (kind === 'spend_limit') return '花費上限'
  return kind
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${round1(n / 1_000_000)}M`
  if (n >= 1_000) return `${round1(n / 1_000)}k`
  return String(n)
}

function textBar(remaining: number, width = 14): string {
  const full = Math.round((clamp(remaining) / 100) * width)
  return '━'.repeat(full)
}

const PALETTE = ['#D97757', '#6A9BD8', '#58B48C', '#B07CD8', '#E0A030', '#D86A9B']
function colorFor(type: string): string {
  let h = 0
  for (const c of type) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]!
}

// 執行中的小動畫：跳動的核心 + 擴散波紋 + 繞行的小衛星
function runningSvg(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">
<circle cx="15" cy="15" r="6" fill="none" stroke="${color}" stroke-width="1.5">
  <animate attributeName="r" values="6;14" dur="1.6s" repeatCount="indefinite"/>
  <animate attributeName="opacity" values="0.9;0" dur="1.6s" repeatCount="indefinite"/>
</circle>
<circle cx="15" cy="15" r="5" fill="${color}">
  <animate attributeName="r" values="4.5;6;4.5" dur="0.9s" repeatCount="indefinite"/>
</circle>
<g>
  <animateTransform attributeName="transform" type="rotate" from="0 15 15" to="360 15 15" dur="1.3s" repeatCount="indefinite"/>
  <circle cx="15" cy="3.5" r="2.2" fill="${color}"/>
  <circle cx="25" cy="21" r="1.4" fill="${color}" opacity="0.7"/>
  <circle cx="5" cy="21" r="1" fill="${color}" opacity="0.5"/>
</g>
</svg>`
}

function idleSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">
<circle cx="15" cy="15" r="5" fill="#88888866">
  <animate attributeName="opacity" values="0.4;1;0.4" dur="3s" repeatCount="indefinite"/>
</circle>
</svg>`
}

// 同一批裡已經完成、還在等其他 subagent 的方塊：淺橘色
const DONE_IN_BATCH = '#F2B58C'

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// ---------- 方塊（tile） ----------

type Tile = { id: string; label: string; remaining?: number; sub: string; resetsAt?: number; isReset?: boolean }

function tilesOf(usage: UsageSnap, now: number): Tile[] {
  const list: Tile[] = []
  if (usage.contextPercent === undefined) {
    list.push({ id: 'context', label: 'Context window', sub: `等第一次回應後顯示（${fmtTokens(usage.window)}）` })
  } else {
    list.push({
      id: 'context',
      label: 'Context window',
      remaining: clamp(100 - usage.contextPercent),
      sub:
        usage.tokens !== undefined
          ? `${fmtTokens(usage.tokens)} / ${fmtTokens(usage.window)} tokens`
          : `${fmtTokens(usage.window)} tokens`,
    })
  }
  for (const l of usage.limits) {
    const at = l.resetsAt ? Date.parse(l.resetsAt) : Number.NaN
    // 重置時間已過：這個讀數屬於上一個時間窗，額度已經回滿
    const isReset = Number.isFinite(at) && at <= now
    const used = isReset ? 0 : l.percentUsed
    list.push({
      id: l.kind,
      label: limitLabel(l.kind),
      remaining: clamp(100 - used),
      sub: `已用 ${round1(used)}%`,
      resetsAt: Number.isNaN(at) ? undefined : at,
      isReset: isReset || undefined,
    })
  }
  return list
}

function sortByOrder<T extends { id: string }>(items: T[], order: readonly string[]): T[] {
  const rank = (id: string) => {
    const i = order.indexOf(id)
    return i === -1 ? order.length : i
  }
  return [...items].sort((a, b) => rank(a.id) - rank(b.id))
}

async function toggleSection($: Api, id: string) {
  const next = await update($, collapsedAtom, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))
  await $.store.set(COLLAPSED_KEY, next)
}

async function setOrder($: Api, ids: readonly string[]) {
  const clean = ids.filter((x): x is string => typeof x === 'string')
  await update($, orderAtom, () => clean)
  await $.store.set(ORDER_KEY, clean)
}

async function moveTile($: Api, id: string, to: number) {
  const usage = await read($, usageAtom)
  if (!usage) return
  const shown = sortByOrder(tilesOf(usage, 0), await read($, orderAtom)).map(m => m.id)
  const from = shown.indexOf(id)
  if (from === -1) return
  const target = Math.max(0, Math.min(shown.length - 1, to))
  if (target === from) return
  shown.splice(from, 1)
  shown.splice(target, 0, id)
  await update($, orderAtom, () => shown)
  await $.store.set(ORDER_KEY, shown)
}

function toBoardTiles(tiles: Tile[], b: Breakdown | null): BoardTile[] {
  // 傳給前端模組的資料不能有 undefined：轉一次 JSON 把空欄位拿掉
  return JSON.parse(JSON.stringify(tilesData(tiles, b))) as BoardTile[]
}

function tilesData(tiles: Tile[], b: Breakdown | null): BoardTile[] {
  return tiles.map(t => ({
    id: t.id,
    kind: t.id === 'context' ? 'context' : 'limit',
    label: t.label,
    // 壓縮後 /context 的細項先更新、上一則回應的數字還是舊的：有細項就用細項算剩餘，跟「已用」一致
    remaining:
      t.id === 'context' && b && b.contextWindow > 0
        ? round1(clamp(100 - (b.tokensUsed / b.contextWindow) * 100))
        : t.remaining,
    sub: t.sub,
    resetsAt: t.resetsAt,
    isReset: t.isReset,
    ctx:
      t.id === 'context' && b
        ? {
            model: b.model,
            tokensUsed: b.tokensUsed,
            contextWindow: b.contextWindow,
            percentUsed: b.percentUsed,
            autoCompactsAtPercent: b.autoCompactsAtPercent,
            cats: b.categories,
          }
        : undefined,
  }))
}

// ---------- 狀態更新 ----------

async function saveUsage(
  $: Api,
  context: { percent?: number; tokens?: number; window: number },
  rateLimits: readonly Limit[],
) {
  const snap: UsageSnap = {
    contextPercent: context.percent,
    tokens: context.tokens,
    window: context.window,
    limits: await shareLimits(
      $,
      rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    ),
  }
  const old = await read($, usageAtom)
  // 數字沒變就不寫，避免面板白白重繪
  if (old && JSON.stringify(old) === JSON.stringify(snap)) return
  await update($, usageAtom, () => snap)
  if (!old || JSON.stringify(old.limits) !== JSON.stringify(snap.limits)) await scheduleResetRedraw($, snap.limits)
}

// 兩個讀數挑比較新的：同一個時間窗取已用較多的（用量只會增加），不同時間窗取較晚重置的
function newerLimit(x: Limit, y: Limit): Limit {
  const tx = x.resetsAt ? Date.parse(x.resetsAt) : Number.NaN
  const ty = y.resetsAt ? Date.parse(y.resetsAt) : Number.NaN
  if (Number.isFinite(tx) && Number.isFinite(ty) && Math.abs(tx - ty) > SAME_WINDOW_MS) return ty > tx ? y : x
  if (!Number.isFinite(tx) && Number.isFinite(ty)) return y
  return y.percentUsed > x.percentUsed ? y : x
}

function mergeLimits(a: readonly Limit[], b: readonly Limit[]): Limit[] {
  const out = new Map<string, Limit>()
  for (const l of [...a, ...b]) {
    const cur = out.get(l.kind)
    out.set(l.kind, cur ? newerLimit(cur, l) : l)
  }
  return JSON.parse(JSON.stringify([...out.values()])) as Limit[]
}

async function storedLimits($: Api): Promise<Limit[]> {
  const v = await $.store.get(LIMITS_KEY)
  if (!Array.isArray(v)) return []
  return v.filter(
    (l): l is Limit =>
      !!l && typeof l === 'object' && typeof (l as Limit).kind === 'string' && typeof (l as Limit).percentUsed === 'number',
  )
}

// 這個 session 的讀數和其他 session 分享的合併；有更新就寫回共用儲存區
async function shareLimits($: Api, local: Limit[]): Promise<Limit[]> {
  const stored = await storedLimits($)
  const merged = mergeLimits(local, stored)
  if (merged.length > 0 && JSON.stringify(merged) !== JSON.stringify(mergeLimits(stored, []))) await $.store.set(LIMITS_KEY, merged)
  return merged
}

// 閒置的 session 不會收到新的 API 回應：定期看其他 session 有沒有更新的額度
async function syncSharedLimits($: Api) {
  const cur = await read($, usageAtom)
  if (!cur) return
  const merged = mergeLimits(cur.limits, await storedLimits($))
  if (JSON.stringify(merged) === JSON.stringify(cur.limits)) return
  await update($, usageAtom, u => (u ? { ...u, limits: merged } : u))
  await scheduleResetRedraw($, merged)
}

let limitsSync: Timer | undefined
let resetRedraw: Timer | undefined

// 到下一個重置時間就重畫一次，讓額度自己回到 100%
async function scheduleResetRedraw($: Api, limits: readonly Limit[]) {
  const now = await $.clock.now()
  const next = limits
    .map(l => (l.resetsAt ? Date.parse(l.resetsAt) : Number.NaN))
    .filter(t => Number.isFinite(t) && t > now)
    .sort((a, b) => a - b)[0]
  resetRedraw?.cancel()
  resetRedraw = undefined
  if (next === undefined) return
  try {
    resetRedraw = $.clock.after(next - now + 500, () => {
      resetRedraw = undefined
      $.ui.invalidate('ui.render')
    })
  } catch {
    resetRedraw = undefined
  }
}

// 自訂的分類顏色（其他分類沿用原版 /context 的主題色）
const CAT_COLOR_OVERRIDES: Record<string, string> = {
  Messages: '#7CC4FA', // 淺藍色
  'MCP tools': '#A879E6', // 紫色
  'System prompt': '#A0704C', // 咖啡色
}

// 只算「已使用」且 > 0 的分類，由大到小取前 6 個
function toBreakdown(u: SessionUsage): Breakdown | null {
  const b = u.context.breakdown
  if (!b) return null
  const win = Math.max(0, Math.round(b.rawMaxTokens))
  const pct = (n: number) => (win > 0 ? Math.max(0, Math.min(100, Math.round((n / win) * 100))) : 0)
  const used = Math.max(0, Math.round(b.totalTokens))
  const isUsed = (c: (typeof b.categories)[number]) => c.kind === 'used' && !c.isDeferred
  return {
    model: b.model,
    tokensUsed: used,
    contextWindow: win,
    percentUsed: pct(used),
    autoCompactsAtPercent:
      b.isAutoCompactEnabled && b.autoCompactThreshold !== undefined && b.autocompactSource !== 'auto'
        ? pct(b.autoCompactThreshold)
        : undefined,
    categories: b.categories
      .filter(c => isUsed(c) && c.tokens > 0)
      .sort((x, y) => y.tokens - x.tokens)
      .slice(0, 6)
      .map(c => ({ name: c.name, tokens: Math.round(c.tokens), percent: pct(c.tokens), color: CAT_COLOR_OVERRIDES[c.name] ?? c.color })),
  }
}

let lastBreakdownAt = 0
let pendingBreakdown: Timer | undefined

// 即時更新：數字（不花成本）每次都拿；分類細項（本機估算）最多每 4 秒算一次
async function refresh($: Api, isForced = false) {
  const u = await $.session.usage()
  await saveUsage($, u.context, u.rateLimits)
  const now = await $.clock.now()
  const wait = BREAKDOWN_EVERY_MS - (now - lastBreakdownAt)
  if (isForced || wait <= 0) {
    lastBreakdownAt = now
    pendingBreakdown?.cancel()
    pendingBreakdown = undefined
    const b = toBreakdown(await $.session.usage({ breakdown: 'summary' }))
    if (b) {
      const old = await read($, breakdownAtom)
      if (!old || JSON.stringify(old) !== JSON.stringify(b)) await update($, breakdownAtom, () => b)
    }
  } else if (!pendingBreakdown) {
    // 太快的話排一次稍後補算，確保最後的狀態一定會出現
    pendingBreakdown = $.clock.after(wait, () => {
      pendingBreakdown = undefined
      void refresh($)
    })
  }
}

// 右上角的 Reload：只在面板裡重新抓資料，不在對話裡送出任何指令
async function reloadPanel($: Api) {
  await refresh($, true)
  await tickOnce($).catch(() => undefined)
  const u = await read($, usageAtom)
  if (u) await scheduleResetRedraw($, u.limits)
  $.ui.invalidate('ui.render')
  $.ui.toast('Claude 監控已重新整理', { timeoutMs: 1500 })
}

async function finish($: Api, match: (r: AgentRow) => boolean, isFailed: boolean) {
  const now = await $.clock.now()
  await update($, agentsAtom, rows =>
    rows.map(r =>
      r.status === 'running' && match(r)
        ? { ...r, status: isFailed ? 'failed' : 'done', endedAt: now, tool: undefined }
        : r,
    ),
  )
}

let ticker: Timer | undefined

function ensureTicker($: Api) {
  if (ticker) return
  ticker = $.clock.every(1000, () => {
    void tickOnce($)
  })
}

async function tickOnce($: Api) {
  if ((await $.session.surfaces()).includes('terminal')) await update($, tickAtom, n => (n + 1) % 1_000_000)
  // 與引擎的 agent 清單對帳，抓到背景 subagent 的結束
  const list = await $.agent.list()
  const byId = new Map(list.map(a => [a.id, a]))
  const now = await $.clock.now()
  const rows = await read($, agentsAtom)
  let isChanged = false
  const next = rows.map(r => {
    if (r.status !== 'running') return r
    const info = byId.get(r.id)
    let status: AgentRow['status'] = 'running'
    if (info && (info.status === 'completed' || info.status === 'idle')) status = 'done'
    else if (info && (info.status === 'failed' || info.status === 'killed')) status = 'failed'
    else if (!info && r.isBackground && now - r.startedAt > 5_000) status = 'done'
    if (status === 'running') return r
    isChanged = true
    return { ...r, status, endedAt: now, tool: undefined }
  })
  if (isChanged) await update($, agentsAtom, () => next)
  if (!next.some(r => r.status === 'running')) {
    ticker?.cancel()
    ticker = undefined
  }
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'meter',
      description: '開啟 Claude 監控面板（token 剩餘量、context、skills 與 subagent 動畫）',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    const folded = await $.store.get(COLLAPSED_KEY)
    if (Array.isArray(folded))
      await update($, collapsedAtom, () => folded.filter((x): x is string => typeof x === 'string'))
    const saved = await $.store.get(ORDER_KEY)
    if (Array.isArray(saved))
      await update($, orderAtom, () => saved.filter((x): x is string => typeof x === 'string'))
    await refresh($, true)
    limitsSync?.cancel()
    try {
      limitsSync = $.clock.every(LIMITS_SYNC_MS, () => void syncSharedLimits($))
    } catch {
      limitsSync = undefined
    }
    const rows = await read($, agentsAtom)
    if (rows.some(r => r.status === 'running')) ensureTicker($)

    return started
  })

  on('command.run', { command: 'meter' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Claude 監控面板已開啟。' }
  })

  on('session.measure', async ($, e, next) => {
    await saveUsage($, e.context, e.rateLimits)
    void refresh($)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const res = await next(e)
    void refresh($, true)

    return res
  })

  // Claude 啟用了某個 skill（Skill 工具、/指令都會經過這裡）
  on('skill.prompt', async ($, e, next) => {
    const res = await next(e)
    const now = await $.clock.now()
    await update($, skillUsesAtom, list => {
      const found = list.find(s => s.name === e.skill)
      if (found)
        return list.map(s => (s.name === e.skill ? { ...s, count: s.count + 1, lastAt: now } : s))
      return [...list, { name: e.skill, count: 1, lastAt: now, pluginName: e.pluginName }].slice(-100)
    })
    await update($, activeSkillsAtom, list => (list.includes(e.skill) ? list : [...list, e.skill]))

    return res
  })

  // 看板拖曳放開時送來的新順序
  on('ui.message', async ($, e, next) => {
    const d = e.data as Partial<OrderMessage> | null
    if (e.requestId === PANE && d && d.type === 'order' && Array.isArray(d.order)) await setOrder($, d.order)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const res = await next(e)
    if (res.agentId) {
      const row: AgentRow = {
        id: res.agentId,
        type: e.subagentType,
        description: e.description,
        toolUseId: e.tool_use_id,
        isBackground: e.background,
        status: 'running',
        startedAt: await $.clock.now(),
        toolCount: 0,
        tokens: 0,
        outputTokens: 0,
        batch: 0,
      }
      // 同一批：還有 subagent 在跑就加入那一批，否則開新的一批
      const current = (await read($, agentsAtom)).find(r => r.status === 'running')
      row.batch = current ? current.batch : row.startedAt
      await update($, agentsAtom, rows => [...rows.filter(r => r.id !== row.id), row].slice(-30))
      ensureTicker($)
    }

    return res
  })

  on('tool.call', async ($, e, next) => {
    // subagent 內部的工具呼叫：記下它正在做什麼
    if (e.agentId) {
      const id = e.agentId
      await update($, agentsAtom, rows =>
        rows.map(r =>
          r.id === id && r.status === 'running' ? { ...r, tool: e.tool, toolCount: r.toolCount + 1 } : r,
        ),
      )
    }
    const res = await next(e)
    // 前景 subagent：Agent 工具回來就代表它做完了
    if (e.tool === 'Agent' || e.tool === 'Task') {
      const rows = await read($, agentsAtom)
      const row = rows.find(r => r.toolUseId === e.tool_use_id)
      if (row && !row.isBackground) await finish($, r => r.id === row.id, Boolean(res.deny || res.isError))
    }
    // 主對話每做完一個工具，context 就可能變了：即時刷新
    if (!e.agentId) void refresh($)

    return res
  })

  // subagent 每次呼叫模型：把這次用掉的 token 加到它身上（即時）
  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    const id = e.agentId
    const u = res?.usage
    if (id && u) {
      const input = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, agentsAtom, rows =>
        rows.map(r =>
          r.id === id
            ? { ...r, tokens: (r.tokens ?? 0) + input + u.output_tokens, outputTokens: (r.outputTokens ?? 0) + u.output_tokens }
            : r,
        ),
      )
    }

    return res
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const rows = await read($, agentsAtom)
      // subagent 自己這一輪結束就算完成（前景、背景都一樣）
      if (rows.some(r => r.id === id && r.status === 'running'))
        await finish($, r => r.id === id, e.reason === 'error')
    } else {
      // 主對話這一輪結束：「使用中」的 skill 收起來，留在紀錄裡
      if ((await read($, activeSkillsAtom)).length > 0) await update($, activeSkillsAtom, () => [])
    }

    return next(e)
  })

  // ---------- 面板繪製 ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const isTerminal = e.surface === 'terminal'
    const Svg = 'Svg' in table ? table.Svg : undefined
    const Client = (e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in table ? table.Client : undefined
    const usage = await read($, usageAtom)
    const breakdown = await read($, breakdownAtom)
    const agents = await read($, agentsAtom)
    const skillUses = await read($, skillUsesAtom)
    const activeSkills = await read($, activeSkillsAtom)
    const order = await read($, orderAtom)
    const collapsed = await read($, collapsedAtom)
    const tick = isTerminal ? await read($, tickAtom) : 0
    const now = await $.clock.now()

    // 會自己每秒更新的時間（桌面／終端機用 Client，其他介面顯示當下的值）
    const liveTime = (key: string, at: number, mode: 'since' | 'until', prefix = '', suffix = '') =>
      Client ? (
        <Client key={key} module="./live-clock.tsx" props={{ at, mode, prefix, suffix, dim: true }} />
      ) : (
        <Text dimColor>
          {prefix}
          {fmtDuration(mode === 'since' ? now - at : at - now)}
          {suffix}
        </Text>
      )

    // 可收折的區塊標題：點標題（▾／▸）就收起或展開；收起時只剩標題
    const isOpen = (id: string) => !collapsed.includes(id)
    const section = (id: string, title: string, right?: unknown, isSub = false, always?: unknown) => (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1}>
        <Button key={`fold-${id}`} plain onPress={() => void toggleSection($, id)}>
          <Text bold size={isSub ? undefined : 'heading'} dimColor={isSub}>
            {isOpen(id) ? '▾ ' : '▸ '}
            {title}
          </Text>
        </Button>
        {always ? (
          <Box flexDirection="row" alignItems="center" gap={1}>
            {isOpen(id) ? right : null}
            {always}
          </Box>
        ) : isOpen(id) ? (
          right
        ) : null}
      </Box>
    )

    // 右上角：重新整理面板資料（不碰對話）
    const reloadButton = (
      <Button key="reload" label="↻ Reload" plain dimColor onPress={() => void reloadPanel($)} />
    )

    // ---- Token 方塊 ----
    const boardTiles = usage ? toBoardTiles(sortByOrder(tilesOf(usage, now), order), breakdown) : []

    // 沒有拖曳能力的介面（VS Code、手機）：靜態方塊 + ◀▶
    const staticTile = (t: BoardTile, idx: number, count: number) => {
      const inner = 24
      const ctx = t.ctx
      return (
        <Box
          key={`tile-${t.id}`}
          flexDirection="column"
          borderStyle="round"
          borderDimColor
          paddingX={1}
          width={t.kind === 'context' ? '100%' : '48%'}
          flexGrow={1}
          marginBottom={1}
        >
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box flexGrow={1}>
              <Text>{t.label}</Text>
            </Box>
            {t.remaining !== undefined && (
              <Text bold color={levelColor(t.remaining)}>
                {round1(t.remaining)}%
              </Text>
            )}
            {idx > 0 && (
              <Button key={`left-${t.id}`} label="◀" plain dimColor onPress={() => void moveTile($, t.id, idx - 1)} />
            )}
            {idx < count - 1 && (
              <Button key={`right-${t.id}`} label="▶" plain dimColor onPress={() => void moveTile($, t.id, idx + 1)} />
            )}
          </Box>
          {ctx ? (
            <Box flexDirection="column">
              <Text>
                {fmtTokens(ctx.tokensUsed)} / {fmtTokens(ctx.contextWindow)} tokens · 已用 {ctx.percentUsed}%
              </Text>
              <Text>
                {ctx.cats.map(c => (
                  <Text color={c.color}>{'━'.repeat(Math.round((c.tokens / Math.max(1, ctx.contextWindow)) * inner))}</Text>
                ))}
              </Text>
              {ctx.cats.map(c => (
                <Text>
                  <Text color={c.color}>■ </Text>
                  {c.name}
                  <Text dimColor>
                    {' '}
                    {fmtTokens(c.tokens)} · {c.percent}%
                  </Text>
                </Text>
              ))}
              <Text dimColor>
                {ctx.model}
                {ctx.autoCompactsAtPercent !== undefined ? ` · ${ctx.autoCompactsAtPercent}% 自動壓縮` : ''}
              </Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              {t.remaining !== undefined && (
                <Text>
                  <Text color={levelColor(t.remaining)}>{textBar(t.remaining)}</Text>
                  <Text color="subtle">{'━'.repeat(14 - textBar(t.remaining).length)}</Text>
                </Text>
              )}
              <Text dimColor>{t.sub}</Text>
              {t.resetsAt !== undefined && (
                <Text dimColor>{t.isReset || t.resetsAt <= now ? '已重置' : `${fmtDuration(t.resetsAt - now)} 後重置`}</Text>
              )}
            </Box>
          )}
        </Box>
      )
    }

    // ---- Skills：只顯示 Claude 這個 session 實際啟用過的 ----
    const active = skillUses.filter(s => activeSkills.includes(s.name))
    const past = skillUses
      .filter(s => !activeSkills.includes(s.name))
      .sort((a, b) => b.lastAt - a.lastAt)

    const activeSkillTile = (s: SkillUse) => (
      <Box
        key={`skill-${s.name}`}
        flexDirection="row"
        alignItems="center"
        gap={1}
        borderStyle="round"
        borderColor="claude"
        paddingX={1}
        width="48%"
        flexGrow={1}
        marginBottom={1}
      >
        {Svg ? (
          <Svg source={runningSvg('#D97757')} alt="使用中" isInteractive width={30} height={30} />
        ) : (
          <Text color="claude">{SPIN[tick % SPIN.length]}</Text>
        )}
        <Box flexDirection="column" flexShrink={1}>
          <Text bold color="claude">
            {s.name}
          </Text>
          <Text dimColor>
            使用中{s.pluginName ? ` · ${s.pluginName}` : ''}
            {s.count > 1 ? ` · 第 ${s.count} 次` : ''}
          </Text>
        </Box>
      </Box>
    )

    const pastSkillChip = (s: SkillUse) => (
      <Box key={`skill-${s.name}`} borderStyle="round" borderDimColor paddingX={1}>
        <Text>
          <Text color="success">✓ </Text>
          {s.name}
          <Text dimColor>{s.count > 1 ? ` ×${s.count}` : ''}</Text>
        </Text>
      </Box>
    )

    // ---- Subagents：方塊 ----
    const running = agents.filter(a => a.status === 'running')
    // 這一批：只要還有一個在跑，整批（含已完成的）都留在上面；全部完成就一起移到「最近完成」
    const batchId = running[0]?.batch
    const batch = batchId === undefined ? [] : agents.filter(a => a.batch === batchId)
    // 最近完成：依完成時間排，最新的在最上面
    const ended = agents
      .filter(a => a.status !== 'running' && a.batch !== batchId)
      .sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))
      .slice(0, 4)

    const agentTile = (a: AgentRow, isInBatch = false) => {
      const isRunning = a.status === 'running'
      // 同一批裡先完成的：淺橘色；最近完成區：灰色
      const isBatchDone = isInBatch && !isRunning
      const accent = isRunning ? colorFor(a.type) : isBatchDone ? DONE_IN_BATCH : undefined
      return (
        <Box
          key={`agent-${a.id}`}
          flexDirection="row"
          alignItems="center"
          gap={1}
          borderStyle="round"
          borderColor={accent}
          borderDimColor={!accent}
          paddingX={1}
          width="100%"
          marginBottom={1}
        >
          {isRunning ? (
            Svg ? (
              <Svg source={runningSvg(colorFor(a.type))} alt="執行中" isInteractive width={30} height={30} />
            ) : (
              <Text color="claude">{SPIN[tick % SPIN.length]}</Text>
            )
          ) : (
            <Text color={isBatchDone ? DONE_IN_BATCH : a.status === 'done' ? 'success' : 'error'}>
              {a.status === 'failed' ? '✗' : '✓'}
            </Text>
          )}
          <Box flexDirection="column" flexShrink={1} flexGrow={1}>
            <Text bold color={accent} dimColor={!accent}>
              {a.type}
              {a.isBackground ? ' · 背景' : ''}
              {isBatchDone ? ' · 已完成' : ''}
            </Text>
            <Text color={isBatchDone ? DONE_IN_BATCH : undefined} dimColor={!isRunning && !isBatchDone}>
              {a.description}
            </Text>
            {isRunning ? (
              <Box flexDirection="row" gap={1}>
                <Text dimColor>
                  {a.tool ? `→ ${a.tool}` : '思考中…'} · {a.toolCount} 次 · {fmtTokens(a.tokens ?? 0)} tokens ·
                </Text>
                {liveTime(`elapsed-${a.id}`, a.startedAt, 'since')}
              </Box>
            ) : (
              <Text color={isBatchDone ? DONE_IN_BATCH : undefined} dimColor={!isBatchDone}>
                {a.toolCount} 次工具 · {fmtTokens(a.tokens ?? 0)} tokens · {fmtDuration((a.endedAt ?? now) - a.startedAt)}
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {section('token', 'Token 剩餘', undefined, false, reloadButton)}
        {isOpen('token') && (
        <Box flexDirection="column" marginTop={1}>
          {!usage && <Text dimColor>讀取中…</Text>}
          {usage &&
            (Client ? (
              <Client key="board" module="./token-board.tsx" props={{ tiles: boardTiles, surface: e.surface === 'desktop' ? 'desktop' : 'terminal' }} width="100%" />
            ) : (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                {boardTiles.map((t, i) => staticTile(t, i, boardTiles.length))}
              </Box>
            ))}
        </Box>
        )}

        {section(
          'subagents',
          'Subagents',
          running.length > 0 ? (
            <Text color="claude" bold>
              {running.length} 個執行中
            </Text>
          ) : undefined,
        )}
        {isOpen('subagents') && (
        <Box flexDirection="column" marginTop={1}>
          {running.length === 0 && (
            <Box flexDirection="row" alignItems="center" gap={1}>
              {Svg && <Svg source={idleSvg()} alt="待命" isInteractive width={30} height={30} />}
              <Text dimColor>目前沒有 subagent 在執行</Text>
            </Box>
          )}
          {batch.map(a => agentTile(a, true))}
        </Box>
        )}
        {isOpen('subagents') && ended.length > 0 && (
          <Box flexDirection="column">
            {section('recent', '最近完成', undefined, true)}
            {isOpen('recent') && <Box flexDirection="column">{ended.map(a => agentTile(a))}</Box>}
          </Box>
        )}
        {section(
          'skills',
          'Skills',
          active.length > 0 ? (
            <Text color="claude" bold>
              {active.length} 個使用中
            </Text>
          ) : undefined,
        )}
        {isOpen('skills') && active.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
            {active.map(activeSkillTile)}
          </Box>
        )}
        {isOpen('skills') && past.length > 0 && (
          <Box flexDirection="column">
            {section('skills-used', '這個 session 用過', undefined, true)}
            {isOpen('skills-used') && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                {past.map(pastSkillChip)}
              </Box>
            )}
          </Box>
        )}

      </Box>
    )
  })
}
