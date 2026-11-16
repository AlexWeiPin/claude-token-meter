import type { ClientModule } from 'claude-code'

import type { BoardProps, BoardTile } from '../types'

// Token 方塊看板：像 Miro 一樣按住方塊拖曳，方塊會跟著游標走，
// 其他方塊即時滑開讓位，放開後滑進新位置。順序存回 hooks。

type Pos = { x: number; y: number }
type Rect = Pos & { w: number; h: number }
type Drag = { id: string; offX: number; offY: number; x: number; y: number }
/** 按下但還沒拖動：移動超過一格才開始拖，只是點一下不會動到方塊 */
type Press = { id: string; x: number; y: number; offX: number; offY: number }
type State = {
  ref: { props: BoardProps }
  cur: Record<string, Pos>
  order: string[]
  propsKey: string
  drag?: Drag
  press?: Press
  hover?: string
  now: number
}

const EASE = 0.35
const FRAME_MS = 33
const NARROW_COLS = 44
const FREE_BG = '#8888882e'
// 細條的高度（一列的幾分之一）
const BAR_H = 0.35
// 自動壓縮標記：比長條稍高的細直線，不要整格色塊
const MARK_W = 0.15
const MARK_H = 0.7
const pctStr = (n: number) => `${Math.max(1, Math.min(100, Math.round(n)))}%`
const DRAG_START_CELLS = 1

function heightOf(t: BoardTile): number {
  if (t.kind === 'context') return t.ctx ? 6 + t.ctx.cats.length : 5
  return t.resetsAt !== undefined ? 6 : 5
}

function layout(order: readonly string[], tiles: readonly BoardTile[], cols: number): Record<string, Rect> {
  const byId = new Map(tiles.map(t => [t.id, t]))
  // 面板太窄就一個方塊一列，不並排
  const isNarrow = cols < NARROW_COLS
  const half = Math.max(10, Math.floor((cols - 1) / 2))
  const out: Record<string, Rect> = {}
  let y = 0
  let pending: BoardTile | undefined
  const flushPending = () => {
    if (!pending) return
    const h = heightOf(pending)
    out[pending.id] = { x: 0, y, w: half, h }
    y += h
    pending = undefined
  }
  for (const id of order) {
    const t = byId.get(id)
    if (!t) continue
    if (t.kind === 'context' || isNarrow) {
      flushPending()
      const h = heightOf(t)
      out[id] = { x: 0, y, w: cols, h }
      y += h
    } else if (!pending) {
      pending = t
    } else {
      const h = Math.max(heightOf(pending), heightOf(t))
      out[pending.id] = { x: 0, y, w: half, h }
      out[id] = { x: half + 1, y, w: cols - half - 1, h }
      y += h
      pending = undefined
    }
  }
  flushPending()
  return out
}

function totalHeight(rects: Record<string, Rect>): number {
  return Object.values(rects).reduce((m, r) => Math.max(m, r.y + r.h), 0)
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1_000) return `${Math.round(n / 100) / 10}k`
  return String(n)
}

function levelColor(remaining: number): string {
  if (remaining >= 50) return 'success'
  if (remaining >= 20) return 'warning'
  return 'error'
}

function moveTo(order: readonly string[], id: string, to: number): string[] {
  const next = order.filter(x => x !== id)
  next.splice(Math.max(0, Math.min(next.length, to)), 0, id)
  return next
}

const TokenBoard: ClientModule<BoardProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const cols = Math.max(24, surface.columns || 60)
  const ids = props.tiles.map(t => t.id)
  const propsKey = ids.join('|')

  // 第一次畫：啟動動畫時鐘
  if (surface.state === undefined) {
    const ref = { props }
    const start = layout(ids, props.tiles, cols)
    surface.setState({
      ref,
      cur: Object.fromEntries(ids.map(id => [id, { x: start[id]!.x, y: start[id]!.y }])),
      order: ids,
      propsKey,
      now: Date.now(),
    })
    surface.every(FRAME_MS, () => {
      const st = surface.state
      if (!st) return
      const c = Math.max(24, surface.columns || 60)
      const target = layout(st.order, st.ref.props.tiles, c)
      let isMoving = false
      const cur: Record<string, Pos> = {}
      for (const id of st.order) {
        const t = target[id]
        if (!t) continue
        const p = st.cur[id] ?? { x: t.x, y: t.y }
        if (st.drag?.id === id) {
          cur[id] = p
          continue
        }
        const dx = t.x - p.x
        const dy = t.y - p.y
        if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) {
          cur[id] = { x: t.x, y: t.y }
          if (p.x !== t.x || p.y !== t.y) isMoving = true
        } else {
          cur[id] = { x: p.x + dx * EASE, y: p.y + dy * EASE }
          isMoving = true
        }
      }
      if (isMoving) surface.setState({ ...st, cur })
    })
    surface.every(1000, () => {
      const st = surface.state
      if (st && st.ref.props.tiles.some(t => t.resetsAt !== undefined)) surface.setState({ ...st, now: Date.now() })
    })
  }

  const st = surface.state
  if (st) st.ref.props = props
  // 外面（hooks）換了順序或方塊，且沒在拖：跟著新的順序
  const order = st && (st.drag || st.propsKey === propsKey) ? st.order.filter(id => ids.includes(id)) : ids
  for (const id of ids) if (!order.includes(id)) order.push(id)
  if (st && !st.drag && st.propsKey !== propsKey) surface.setState({ ...st, order, propsKey })

  const target = layout(order, props.tiles, cols)
  const pos = (id: string): Pos => st?.cur[id] ?? target[id] ?? { x: 0, y: 0 }

  surface.onPointer(ev => {
    const s = surface.state
    if (!s) return
    const c = Math.max(24, surface.columns || 60)
    const x = ev.fine?.x ?? ev.x
    const y = ev.fine?.y ?? ev.y
    const rects = layout(s.order, s.ref.props.tiles, c)
    const hit = (px: number, py: number) =>
      s.order.find(id => {
        const r = rects[id]
        const p = s.cur[id] ?? r
        return r && p && px >= p.x && px < p.x + r.w && py >= p.y && py < p.y + r.h
      })

    if (ev.type === 'down' && ev.button === 'left') {
      const id = hit(x, y)
      if (!id) return
      const p = s.cur[id] ?? rects[id]!
      surface.setState({ ...s, press: { id, x, y, offX: x - p.x, offY: y - p.y } })
      return
    }
    if (ev.type === 'move' && s.press && !s.drag) {
      const pr = s.press
      if (Math.abs(x - pr.x) < DRAG_START_CELLS && Math.abs(y - pr.y) < DRAG_START_CELLS) return
      const p = s.cur[pr.id] ?? rects[pr.id]!
      dragTo({ ...s, press: undefined }, { id: pr.id, offX: pr.offX, offY: pr.offY, x: p.x, y: p.y }, x, y)
      return
    }
    if (ev.type === 'up' && s.press && !s.drag) {
      surface.setState({ ...s, press: undefined })
      return
    }
    if (ev.type === 'move' && s.drag) {
      dragTo(s, s.drag, x, y)
      return
    }
    if (ev.type === 'up' && s.drag) {
      const changed = s.order.join('|') !== s.ref.props.tiles.map(t => t.id).join('|')
      surface.setState({ ...s, drag: undefined, propsKey: changed ? s.order.join('|') : s.propsKey })
      if (changed) surface.post({ type: 'order', order: s.order })
      return
    }
    if (ev.type === 'move' && !s.drag && !s.press) {
      const id = hit(x, y)
      if (id !== s.hover) surface.setState({ ...s, hover: id })
      return
    }
    if (ev.type === 'leave' && !s.drag && s.hover) surface.setState({ ...s, hover: undefined })

    function dragTo(s: State, d: Drag, x: number, y: number) {
      const fx = x - d.offX
      const fy = y - d.offY
      const r = rects[d.id]!
      // 找出放在哪一格最接近目前拖到的位置
      const home = rects[d.id]!
      const isGoingLater = fy > home.y || (fy === home.y && fx > home.x)
      let best = s.order.indexOf(d.id)
      let bestDist = Number.POSITIVE_INFINITY
      for (let i = 0; i < s.order.length; i++) {
        const trial = moveTo(s.order, d.id, i)
        const tr = layout(trial, s.ref.props.tiles, c)[d.id]!
        const dist = Math.hypot(tr.x + tr.w / 2 - (fx + r.w / 2), (tr.y + tr.h / 2 - (fy + r.h / 2)) * 2)
        // 一樣近的時候：往下／往右拖就選後面的位置
        if (dist < bestDist - 0.01 || (Math.abs(dist - bestDist) <= 0.01 && isGoingLater)) {
          bestDist = dist
          best = i
        }
      }
      const nextOrder = moveTo(s.order, d.id, best)
      surface.setState({
        ...s,
        order: nextOrder,
        drag: { ...d, x: fx, y: fy },
        cur: { ...s.cur, [d.id]: { x: fx, y: fy } },
      })
    }
  })

  const now = st?.now ?? Date.now()
  const dragId = st?.drag?.id

  const header = (t: BoardTile, isLifted: boolean) => (
    <Box flexDirection="row" justifyContent="space-between" gap={1}>
      <Box flexShrink={1} flexGrow={1}>
        <Text bold={isLifted} color={isLifted ? 'claude' : undefined} wrap="truncate-end">
          <Text dimColor={!isLifted && st?.hover !== t.id}>⠿ </Text>
          {t.label}
        </Text>
      </Box>
      {t.remaining !== undefined && (
        <Box flexShrink={0}>
          <Text bold color={levelColor(t.remaining)}>
            {Math.round(t.remaining * 10) / 10}%
          </Text>
        </Box>
      )}
    </Box>
  )

  const isDesktop = props.surface === 'desktop'

  const bar = (segs: { pct: number; color: string }[], inner: number, markPct?: number) => {
    const used = Math.min(100, segs.reduce((a, x) => a + x.pct, 0))
    const hasMark = markPct !== undefined && markPct >= used && markPct < 100
    if (isDesktop) {
      // 桌面版：色塊（按百分比算寬度，不會換行），高度只取一列的一部分，看起來是細條
      return (
        <Box flexDirection="row" width="100%" height={1} alignItems="center">
          {segs
            .filter(x => x.pct >= 0.5)
            .map(x => (
              <Box width={pctStr(x.pct)} height={BAR_H} backgroundColor={x.color} />
            ))}
          {hasMark && <Box width={pctStr(markPct! - used)} height={BAR_H} backgroundColor={FREE_BG} />}
          {hasMark && <Box width={MARK_W} height={MARK_H} backgroundColor="error" />}
          <Box flexGrow={1} height={BAR_H} backgroundColor={FREE_BG} />
        </Box>
      )
    }
    const cells = segs.map(x => ({ n: Math.floor((x.pct / 100) * inner), color: x.color }))
    const usedCells = cells.reduce((a, x) => a + x.n, 0)
    const markAt = hasMark ? Math.min(inner - 1, Math.max(usedCells, Math.round((markPct! / 100) * inner))) : -1
    const free = Math.max(0, inner - usedCells)
    const before = markAt >= 0 ? markAt - usedCells : free
    return (
      <Text wrap="truncate-end">
        {cells.map(x => (
          <Text color={x.color}>{'━'.repeat(x.n)}</Text>
        ))}
        <Text color="subtle">{'━'.repeat(Math.max(0, before))}</Text>
        {markAt >= 0 && <Text color="error">┃</Text>}
        {markAt >= 0 && <Text color="subtle">{'━'.repeat(Math.max(0, free - before - 1))}</Text>}
      </Text>
    )
  }

  const row = (left: unknown, right: unknown) => (
    <Box flexDirection="row" justifyContent="space-between" gap={1}>
      <Box flexShrink={1} flexGrow={1}>
        {left}
      </Box>
      <Box flexShrink={0}>{right}</Box>
    </Box>
  )

  const body = (t: BoardTile, w: number) => {
    const inner = Math.max(6, w - 4)
    if (t.kind === 'context' && t.ctx) {
      const ctx = t.ctx
      const segs = ctx.cats.map(c => ({ pct: (c.tokens / Math.max(1, ctx.contextWindow)) * 100, color: c.color }))
      return (
        <Box flexDirection="column">
          {row(
            <Text wrap="truncate-end">
              {fmtTokens(ctx.tokensUsed)} / {fmtTokens(ctx.contextWindow)} tokens
            </Text>,
            <Text dimColor>已用 {ctx.percentUsed}%</Text>,
          )}
          {bar(segs, inner, ctx.autoCompactsAtPercent)}
          {ctx.cats.map(c =>
            row(
              <Text wrap="truncate-end">
                <Text color={c.color}>■ </Text>
                {c.name}
              </Text>,
              <Text dimColor>
                {fmtTokens(c.tokens)} · {c.percent}%
              </Text>,
            ),
          )}
          {row(
            <Text dimColor wrap="truncate-end">
              {ctx.model}
            </Text>,
            ctx.autoCompactsAtPercent !== undefined ? (
              <Text dimColor>
                <Text color="error">┃</Text> {ctx.autoCompactsAtPercent}% 自動壓縮
              </Text>
            ) : null,
          )}

        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {t.remaining !== undefined && bar([{ pct: t.remaining, color: levelColor(t.remaining) }], inner)}
        <Text dimColor wrap="truncate-end">
          {t.sub}
        </Text>
        {t.resetsAt !== undefined && (
          <Text dimColor wrap="truncate-end">
            {t.isReset || t.resetsAt <= now ? '已重置' : `${fmt(t.resetsAt - now)} 後重置`}
          </Text>
        )}
      </Box>
    )
  }

  const tileBox = (t: BoardTile, isLifted: boolean) => {
    const r = target[t.id]!
    const p = pos(t.id)
    return (
      <Box
        key={`tile-${t.id}`}
        position="absolute"
        left={Math.round(p.x)}
        top={Math.round(p.y)}
        width={r.w}
        height={r.h}
        flexDirection="column"
        borderStyle={isLifted ? 'bold' : 'round'}
        borderColor={isLifted ? 'claude' : st?.hover === t.id ? 'claude' : undefined}
        borderDimColor={!isLifted && st?.hover !== t.id}
        paddingX={1}
        overflow="hidden"
      >
        {header(t, isLifted)}
        {body(t, r.w)}
      </Box>
    )
  }

  // 額度的重置時間到了：舊讀數作廢，當作全部剩下（等下一次回應帶回新的時間窗）
  const tiles = props.tiles
    .filter(t => target[t.id])
    .map(t => (t.kind === 'limit' && t.resetsAt !== undefined && (t.isReset || t.resetsAt <= now) ? { ...t, remaining: 100, sub: '已用 0%' } : t))
  // 拖曳中的方塊最後畫，浮在其他方塊上面
  const lifted = tiles.find(t => t.id === dragId)

  return (
    <Box position="relative" width="100%" height={totalHeight(target)}>
      {tiles.filter(t => t.id !== dragId).map(t => tileBox(t, false))}
      {lifted && tileBox(lifted, true)}
    </Box>
  )
}

export default TokenBoard
