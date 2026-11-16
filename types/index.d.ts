export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** Context window 的一個分類（和桌面版一樣：只算有用到的，取前 6 大） */
export type ContextCat = {
  name: string
  tokens: number
  percent: number
  /** 原版 /context 用的主題色（theme key） */
  color: string
}

export type Breakdown = {
  model: string
  tokensUsed: number
  contextWindow: number
  percentUsed: number
  /** 自動壓縮會在用到幾 % 時觸發 */
  autoCompactsAtPercent?: number
  categories: ContextCat[]
}

export type UsageSnap = {
  /** context window 已用百分比，第一次回應前沒有 */
  contextPercent?: number
  tokens?: number
  window: number
  limits: Limit[]
}

export type AgentRow = {
  id: string
  type: string
  description: string
  toolUseId: string
  isBackground: boolean
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  /** subagent 目前正在呼叫的工具 */
  tool?: string
  toolCount: number
  /** 這個 subagent 到目前為止用掉的 token（輸入 + 快取 + 輸出） */
  tokens: number
  outputTokens: number
  /** 同一批派出的 subagent 共用的批次 id（第一個的開始時間） */
  batch: number
}

/** 這個 session 裡 Claude 呼叫過的 skill */
export type SkillUse = { name: string; count: number; lastAt: number; pluginName?: string }

/** Token 看板裡的一個方塊（傳給 token-board.tsx 的資料） */
export type BoardTile = {
  id: string
  kind: 'context' | 'limit'
  label: string
  remaining?: number
  sub: string
  resetsAt?: number
  ctx?: {
    model: string
    tokensUsed: number
    contextWindow: number
    percentUsed: number
    autoCompactsAtPercent?: number
    cats: ContextCat[]
  }
}

export type BoardProps = { tiles: BoardTile[]; surface: 'terminal' | 'desktop' }

/** 看板拖曳放開後送回 hooks 的新順序 */
export type OrderMessage = { type: 'order'; order: string[] }

declare module 'claude-code' {
  interface PluginState {
    'token-meter': {
      usage: Shaped<UsageSnap | null>
      breakdown: Shaped<Breakdown | null>
      agents: Shaped<AgentRow[]>
      skillUses: Shaped<SkillUse[]>
      /** 這一輪回應正在用的 skill（回應結束就清空） */
      activeSkills: string[]
      tick: number
      /** 方塊順序（tile id），跨 session 存在 $.store */
      order: string[]
      /** 收起來的區塊 id（token、subagents、recent、skills、skills-used） */
      collapsed: string[]
    }
  }
}
