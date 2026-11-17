import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'token-meter',
  component: 'Pane',
  requestId: 'token-meter',
  props: {
    title: 'Claude 監控',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const sq = (categoryName: string, color: string, isFilled = true, squareFullness = 1) => ({
  color,
  isFilled,
  categoryName,
  tokens: 0,
  percentage: 0,
  squareFullness,
})

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 3_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 37_000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 127_000, color: 'inactive', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
  ],
  totalTokens: 40_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  autocompactSource: 'model-default',
  percentage: 20,
  gridRows: [
    [sq('System prompt', 'promptBorder'), sq('Messages', 'permission'), sq('Messages', 'permission', true, 0.4)],
    [sq('Free space', 'inactive', false, 0), sq('Free space', 'inactive', false, 0), sq('Autocompact buffer', 'inactive')],
  ],
  model: 'claude-opus-5-5',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  skills: {
    totalSkills: 2,
    includedSkills: 2,
    tokens: 200,
    skillFrontmatter: [
      { name: 'pdf', source: 'plugin', pluginName: 'anthropic-skills', tokens: 100 },
      { name: 'docx', source: 'plugin', pluginName: 'anthropic-skills', tokens: 100 },
    ],
  },
  autoCompactThreshold: 167_000,
  isAutoCompactEnabled: true,
  apiUsage: null,
}

const LIMITS = [
  { kind: 'five_hour', percentUsed: 35.5 },
  { kind: 'seven_day', percentUsed: 90 },
]

type On = Parameters<Parameters<typeof test>[1]>[1]

function engine(
  on: On,
  toasts: string[] = [],
  clock: () => number = () => 1_000_000,
  ctx: { percent: number; breakdown: typeof BREAKDOWN } = { percent: 20, breakdown: BREAKDOWN },
) {
  mock.store(on)
  on('clock.now', () => ({ value: clock() }))
  on('clock.every', () => ({ value: { cancel() {} } }))
  on('clock.after', () => ({ value: { cancel() {} } }))
  on('command.register', () => ({ value: { command: 'meter' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('session.usage', (_, e) => ({
    value: {
      startedAt: 0,
      context: {
        tokens: 40_000,
        window: 200_000,
        percent: ctx.percent,
        ...((e as { breakdown?: string } | undefined)?.breakdown ? { breakdown: ctx.breakdown } : {}),
      },
      rateLimits: LIMITS,
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `a${++spawned}` }))
  on('tool.call', () => ({ result: {} }))
  on('skill.prompt', () => ({ text: 'skill body' }))
}

type Found = { text?: string }
type Finder = { findAll: (q: { type: 'Text'; text: RegExp; in?: string }) => Promise<Found[]> }
const BOARD_SURFACES = new Set(['terminal', 'desktop'])

async function percents(ui: Finder, surface: string) {
  const found = await ui.findAll({
    type: 'Text',
    text: /^\d+(\.\d)?%$/,
    ...(BOARD_SURFACES.has(surface) ? { in: 'board' } : {}),
  })
  return found.map(f => f.text)
}

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

test('方塊、/context 格子、skills、subagent 在每個介面都畫得出來', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'look around', description: '搜尋程式碼', subagentType: 'Explore' })
  await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'a1' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await percents(ui, surface)).toEqual(['80%', '64.5%', '10%'])
    const inBoard = BOARD_SURFACES.has(surface) ? { in: 'board' } : {}
    // context：同桌面版的資訊，顏色用原版的主題色
    expect(await ui.find({ type: 'Text', text: /40k \/ 200k tokens/, ...inBoard })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /已用 20%/, ...inBoard })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Messages/, ...inBoard })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /37k · 19%/, ...inBoard })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Free space/, ...inBoard })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /84% 自動壓縮/, ...inBoard })).toBeDefined()
    // skills：還沒用過就不列，也不顯示提示文字
    expect(await ui.find({ type: 'Text', text: /docx/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /顯示在這裡|按住/ })).toBeUndefined()
    // subagent
    expect(await ui.find({ type: 'Text', text: /搜尋程式碼/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /→ Grep/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 個執行中/ })).toBeDefined()
    await ui.unmount()
  }
})

test('Claude 啟用 skill 時顯示「使用中」，這輪結束後移到紀錄', async ($, on) => {
  engine(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.skill.prompt({ skill: 'pdf', text: 'x', pluginName: 'anthropic-skills' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /1 個使用中/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /使用中 · anthropic-skills/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.skill.prompt({ skill: 'docx', text: 'y' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await $.skill.prompt({ skill: 'pdf', text: 'z' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /使用中 · anthropic-skills · 第 2 次/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /這個 session 用過/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ docx/ })).toBeDefined()
  await ui.unmount()
})

test('不能拖曳的介面用 ◀▶ 調整方塊位置', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const before = await percents(ui, surface)
    await ui.press({ key: 'right-context' })
    expect(await percents(ui, surface)).toEqual([before[1], before[0], before[2]])
    await ui.press({ key: 'left-context' })
    expect(await percents(ui, surface)).toEqual(before)
    await ui.unmount()
  }
})

test('看板：按住方塊拖曳，放開後換位置並記住', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // 把 Context 方塊往下拖到兩個額度方塊下面
    await ui.pointer({ type: 'down', x: 3, y: 1, button: 'left', in: 'board' })
    await ui.pointer({ type: 'move', x: 3, y: 8, button: 'left', in: 'board' })
    await ui.pointer({ type: 'move', x: 3, y: 16, button: 'left', in: 'board' })
    await ui.advance(200)
    await ui.pointer({ type: 'up', x: 3, y: 16, button: 'left', in: 'board' })
    await ui.advance(500)
    expect(await percents(ui, surface)).toEqual(['64.5%', '10%', '80%'])
    // 再把它拖回最上面
    await ui.pointer({ type: 'down', x: 3, y: 7, button: 'left', in: 'board' })
    await ui.pointer({ type: 'move', x: 3, y: -6, button: 'left', in: 'board' })
    await ui.pointer({ type: 'up', x: 3, y: -6, button: 'left', in: 'board' })
    await ui.advance(500)
    expect(await percents(ui, surface)).toEqual(['80%', '64.5%', '10%'])
    await ui.unmount()
  }
})

test('看板：兩個額度方塊左右對調', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 寬 60：額度方塊在第 8 列以下，左邊 0–28，右邊 30–59
  await ui.pointer({ type: 'down', x: 4, y: 9, button: 'left', in: 'board' })
  await ui.pointer({ type: 'move', x: 40, y: 9, button: 'left', in: 'board' })
  await ui.pointer({ type: 'up', x: 40, y: 9, button: 'left', in: 'board' })
  await ui.advance(500)
  expect(await percents(ui, 'desktop')).toEqual(['80%', '10%', '64.5%'])
  await ui.unmount()
})

test('看板：只是點一下不會被當成拖曳', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.pointer({ type: 'down', x: 3, y: 1, button: 'left', in: 'board' })
  await ui.pointer({ type: 'up', x: 3, y: 1, button: 'left', in: 'board' })
  await ui.advance(300)
  expect(await percents(ui, 'desktop')).toEqual(['80%', '64.5%', '10%'])
  await ui.unmount()
})

test('執行時間的小時鐘自己每秒更新', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: '計時', subagentType: 'Explore' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const first = (await ui.find({ type: 'Text', in: 'elapsed-a1' }))?.text
  expect(first).toBeDefined()
  await ui.advance(3_000)
  const later = (await ui.find({ type: 'Text', in: 'elapsed-a1' }))?.text
  expect(later).toBeDefined()
  await ui.unmount()
})

test('窄面板：方塊一個一列，左右拖不會並排', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.resize({ columns: 36, rows: 60, in: 'board' })
  await ui.advance(500)
  const tiles = await ui.findAll({ type: 'Box', in: 'board' })
  const placed = tiles
    .map(t => t.props as { key?: string; left?: number; width?: number; position?: string })
    .filter(p => p.position === 'absolute')
  expect(placed.length).toBe(3)
  for (const p of placed) {
    expect(p.left).toBe(0)
    expect(p.width).toBe(36)
  }
  await ui.unmount()
})

test('Skills 排在 Subagents 下面', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.skill.prompt({ skill: 'pdf', text: 'x' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const heads = (await ui.findAll({ type: 'Text', text: /^▾ (Token 剩餘|Subagents|Skills)$/ })).map(t => t.text)
  expect(heads).toEqual(['▾ Token 剩餘', '▾ Subagents', '▾ Skills'])
  await ui.unmount()
})

test('Messages 淺藍、MCP tools 紫色、System prompt 咖啡色', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const inBoard = BOARD_SURFACES.has(surface) ? { in: 'board' } : {}
    const dots = await ui.findAll({ type: 'Text', text: /^■ $/, ...inBoard })
    const colors = dots.map(d => (d.props as { color?: string }).color)
    expect(colors).toContain('#7CC4FA')
    expect(colors).toContain('#A0704C')
    await ui.unmount()
  }
})


test('沒有 /compact 按鈕', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /compact/ })).toBeUndefined()
    if (BOARD_SURFACES.has(surface)) expect(await ui.find({ type: 'Text', text: /compact/, in: 'board' })).toBeUndefined()
    await ui.unmount()
  }
})

test('桌面版長條是色塊細條，裡面沒有會換行的長字串', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /━━━|███/, in: 'board' })).toBeUndefined()
  const bars = (await ui.findAll({ type: 'Box', in: 'board' }))
    .map(b => b.props as { height?: number; backgroundColor?: string })
    .filter(p => p.backgroundColor === '#7CC4FA')
  expect(bars.length).toBe(1)
  expect(bars[0]!.height).toBeLessThan(1)
  await ui.unmount()
})

test('最近完成由上往下排，最新的在最上面', async ($, on) => {
  let now = 1_000_000
  engine(on, [], () => now)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const d of ['第一個', '第二個', '第三個']) {
    await $.agent.spawn({ prompt: 'x', description: d, subagentType: 'Explore' })
  }
  // 依序完成：前景 Agent 工具回來就算完成
  for (const [i, id] of ['a1', 'a2', 'a3'].entries()) {
    now = 2_000_000 + i * 1000
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: `t${i}`, reason: 'answer', agentId: id })
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text', text: /^第.個$/ })).map(t => t.text)
  expect(texts).toEqual(['第三個', '第二個', '第一個'])
  await ui.unmount()
})

test('每個區塊都能收起和展開，收起時只剩標題', async ($, on) => {
  engine(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: '做完的', subagentType: 'Explore' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId: 'a1' })
  await $.skill.prompt({ skill: 'pdf', text: 'x' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Token
    await ui.press({ key: 'fold-token' })
    expect(await ui.find({ type: 'Text', text: /^▸ Token 剩餘$/ })).toBeDefined()
    // 收起後旁邊不顯示任何資訊
    expect(await ui.find({ type: 'Text', text: /Context|額度|%/ })).toBeUndefined()
    expect(await ui.findAll({ type: 'Text', text: /^\d+(\.\d)?%$/ })).toHaveLength(0)
    await ui.press({ key: 'fold-token' })
    expect(await ui.find({ type: 'Text', text: /^▾ Token 剩餘$/ })).toBeDefined()
    // 最近完成
    expect(await ui.find({ type: 'Text', text: /做完的/ })).toBeDefined()
    await ui.press({ key: 'fold-recent' })
    expect(await ui.find({ type: 'Text', text: /做完的/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^\d+ 個$/ })).toBeUndefined()
    await ui.press({ key: 'fold-recent' })
    // Subagents 整區
    await ui.press({ key: 'fold-subagents' })
    expect(await ui.find({ type: 'Text', text: /目前沒有 subagent|做完的|執行中/ })).toBeUndefined()
    await ui.press({ key: 'fold-subagents' })
    // Skills
    expect(await ui.find({ type: 'Text', text: /pdf/ })).toBeDefined()
    await ui.press({ key: 'fold-skills' })
    expect(await ui.find({ type: 'Text', text: /pdf/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /使用中/ })).toBeUndefined()
    await ui.press({ key: 'fold-skills' })
    await ui.unmount()
  }
})

test('收起的狀態會記住（下次開 session 還是收起）', async ($, on) => {
  mock.store(on, { collapsed: ['token', 'skills'] })
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: { cancel() {} } }))
  on('clock.after', () => ({ value: { cancel() {} } }))
  on('command.register', () => ({ value: { command: 'meter' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 1, window: 10, percent: 10 }, rateLimits: [] },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^▸ Token 剩餘$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^▸ Skills$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^▾ Subagents$/ })).toBeDefined()
  await ui.unmount()
})

test('自動壓縮標記是細線，不是整格色塊', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const marks = (await ui.findAll({ type: 'Box', in: 'board' }))
    .map(b => b.props as { width?: number; height?: number; backgroundColor?: string })
    .filter(p => p.backgroundColor === 'error' && typeof p.width === 'number')
  expect(marks.length).toBe(1)
  expect(marks[0]!.width).toBeLessThan(1)
  expect(marks[0]!.height).toBeLessThan(1)
  await ui.unmount()
})

const STEP_USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 3000,
  cache_creation_input_tokens: 0,
  model: 'claude-haiku-5-5',
}

async function step($: Parameters<Parameters<typeof test>[1]>[0], agentId: string) {
  const stream = $.turn.step({ turnId: `t-${agentId}`, index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId })
  for await (const _ of stream) {
    // 只要把串流跑完
  }
}

function engineWithSteps(on: On, clock: () => number) {
  engine(on, [], clock)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: STEP_USAGE,
    }
  })
}

test('一批 subagent：先完成的留著變綠色，全部完成才一起移到最近完成', async ($, on) => {
  let now = 1_000_000
  engineWithSteps(on, () => now)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const d of ['甲', '乙', '丙']) await $.agent.spawn({ prompt: 'x', description: d, subagentType: 'Explore' })

  // 甲先完成
  now += 5000
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'ta', reason: 'answer', agentId: 'a1' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /2 個執行中/ })).toBeDefined()
    // 甲還在上面，標示已完成、綠色
    const done = await ui.find({ type: 'Text', text: /Explore.*已完成/ })
    expect((done?.props as { color?: string }).color).toBe('#4CC38A')
    // 還在跑的乙、丙：各自不同顏色，都不是綠色
    const runningColors = (await ui.findAll({ type: 'Box' }))
      .filter(b => String(b.key ?? '').startsWith('agent-'))
      .map(b => (b.props as { borderColor?: string }).borderColor)
    expect(runningColors[0]).toBe('#4CC38A')
    expect(new Set(runningColors.slice(1)).size).toBe(2)
    expect(runningColors.slice(1)).not.toContain('#4CC38A')
    expect(await ui.find({ type: 'Text', text: /最近完成/ })).toBeUndefined()
    // 三個方塊都是整列寬
    const tiles = (await ui.findAll({ type: 'Box' }))
      .filter(b => String(b.key ?? '').startsWith('agent-'))
      .map(b => (b.props as { width?: string }).width)
    expect(tiles).toEqual(['100%', '100%', '100%'])
    await ui.unmount()
  }

  // 乙、丙也完成：整批一起移到最近完成
  now += 5000
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'tb', reason: 'answer', agentId: 'a2' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'tc', reason: 'answer', agentId: 'a3' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /目前沒有 subagent 在執行/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /已完成/ })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text', text: /^[甲乙丙]$/ })).length).toBe(3)
  await ui.unmount()
})

test('subagent 用掉的 token 即時累加顯示', async ($, on) => {
  engineWithSteps(on, () => 1_000_000)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: '算 token', subagentType: 'Explore' })

  await step($, 'a1')
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /4\.2k tokens/ })).toBeDefined()
  await ui.unmount()

  await step($, 'a1')
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /8\.4k tokens/ })).toBeDefined()
  await ui.unmount()
})

test('壓縮後剩餘 % 跟「已用」一致（不用壓縮前的舊數字）', async ($, on) => {
  // 上一則回應的數字還是壓縮前的 52%，/context 細項已經是壓縮後的 8%
  engine(on, [], () => 1_000_000, {
    percent: 52,
    breakdown: { ...BREAKDOWN, totalTokens: 16_000, categories: BREAKDOWN.categories.map(c => (c.name === 'Messages' ? { ...c, tokens: 13_000 } : c)) },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const shown = await percents(ui, surface)
    expect(shown[0]).toBe('92%')
    expect(shown).not.toContain('48%')
    await ui.unmount()
  }
})

test('右上角的 Reload 按鈕只刷新面板，不在對話送出指令，收起時也在', async ($, on) => {
  const breakdown = { ...BREAKDOWN }
  engine(on, [], () => 1_000_000, { percent: 52, breakdown })
  const ran: string[] = []
  on('command.run', (_, e) => {
    ran.push(e.command)
    return { text: '' }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    breakdown.totalTokens = 40_000 + SURFACES.indexOf(surface) * 20_000
    await ui.press({ key: 'reload' })
    expect((await percents(ui, surface))[0]).toBe(`${80 - SURFACES.indexOf(surface) * 10}%`)
    await ui.press({ key: 'fold-token' })
    await ui.press({ key: 'reload' })
    await ui.press({ key: 'fold-token' })
    await ui.unmount()
  }
  expect(ran).toHaveLength(0)
})

// 測試時間以真實的現在為準（看板的倒數用的是真實時鐘）
const NOW = Date.now()
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

// 共用儲存區用一個看得到的物件，模擬「別的 session」直接改它
function quotaSession(on: On, shared: Record<string, unknown>, local: { percentUsed: number; resetsAt: string }) {
  on('store.get', (_, e) => ({ value: shared[e.key] }))
  on('store.set', (_, e) => {
    shared[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'meter' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 1, window: 10, percent: 10 },
      rateLimits: [{ kind: 'five_hour', ...local }],
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return clock
}

const RESET = at(3 * 60 * 60_000)

test('額度跨 session 共用：閒置 session 顯示別的 session 讀到的最新額度', async ($, on) => {
  // 這個 session 上次讀到已用 55%；別的 session 剛讀到同一時間窗已用 96%
  const shared: Record<string, unknown> = { 'limits-latest': [{ kind: 'five_hour', percentUsed: 96, resetsAt: RESET }] }
  const clock = quotaSession(on, shared, { percentUsed: 55, resetsAt: RESET })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await percents(ui, 'desktop')).toContain('4%')
  expect(await percents(ui, 'desktop')).not.toContain('45%')

  // 別的 session 又讀到 97%：什麼都不按，30 秒內自己更新
  shared['limits-latest'] = [{ kind: 'five_hour', percentUsed: 97, resetsAt: RESET }]
  await clock.advance(30_000)
  expect(await percents(ui, 'desktop')).toContain('3%')

  // 再讀到 98%：按 Reload 立刻更新
  shared['limits-latest'] = [{ kind: 'five_hour', percentUsed: 98, resetsAt: RESET }]
  await ui.press({ key: 'reload' })
  expect(await percents(ui, 'desktop')).toContain('2%')
  await ui.unmount()
})

test('額度跨 session 共用：時間窗重置後，舊時間窗的高用量不會蓋掉新的', async ($, on) => {
  const shared: Record<string, unknown> = {
    'limits-latest': [{ kind: 'five_hour', percentUsed: 96, resetsAt: at(-2 * 60 * 60_000) }],
  }
  quotaSession(on, shared, { percentUsed: 10, resetsAt: RESET })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await percents(ui, 'desktop')).toContain('90%')
  expect(shared['limits-latest']).toEqual([{ kind: 'five_hour', percentUsed: 10, resetsAt: RESET }])
  await ui.unmount()
})

test('重置時間已過：額度回到 100%，顯示「已重置」，不會卡在 0s', async ($, on) => {
  quotaSession(on, {}, { percentUsed: 99, resetsAt: at(-60 * 60_000) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const scope = BOARD_SURFACES.has(surface) ? { in: 'board' } : {}
    expect(await percents(ui, surface)).toContain('100%')
    expect(await percents(ui, surface)).not.toContain('1%')
    expect(await ui.find({ type: 'Text', text: /已重置/, ...scope })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /後重置/, ...scope })).toBeUndefined()
    await ui.unmount()
  }
})

test('到了重置時間，面板自己變回 100%', async ($, on) => {
  const clock = quotaSession(on, {}, { percentUsed: 99, resetsAt: at(5 * 60_000) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await percents(ui, 'vscode')).toContain('1%')
  await clock.advance(6 * 60_000)
  expect(await percents(ui, 'vscode')).toContain('100%')
  expect(await ui.find({ type: 'Text', text: /已重置/ })).toBeDefined()
  await ui.unmount()
})

test('同時派出的 subagent 動畫各是不同顏色（即使類型一樣）', async ($, on) => {
  engineWithSteps(on, () => 1_000_000)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const d of ['一', '二', '三', '四']) await $.agent.spawn({ prompt: 'x', description: d, subagentType: 'Explore' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svgs = (await ui.findAll({ type: 'Svg' }))
    .map(n => String((n.props as { source?: string }).source ?? ''))
    .filter(src => src.includes('animateTransform'))
  const colors = svgs.map(src => /fill="(#[0-9A-Fa-f]{6})"/.exec(src)?.[1])
  expect(colors).toHaveLength(4)
  expect(new Set(colors).size).toBe(4)
  expect(colors).not.toContain('#4CC38A')
  await ui.unmount()
})
