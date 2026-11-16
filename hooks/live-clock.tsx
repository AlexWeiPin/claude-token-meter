import type { ClientModule } from 'claude-code'

type Props = {
  /** 毫秒時間戳 */
  at: number
  /** since：已經過多久；until：還剩多久 */
  mode: 'since' | 'until'
  prefix?: string
  suffix?: string
  dim?: boolean
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

// 自己每秒重畫的小時鐘：只更新這一小塊，不用整個面板重繪
const LiveClock: ClientModule<Props, number> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    surface.every(1000, () => surface.setState(Date.now()))
    surface.setState(Date.now())
  }
  const now = surface.state ?? Date.now()
  const ms = props.mode === 'since' ? now - props.at : props.at - now

  return (
    <Text dimColor={props.dim}>
      {props.prefix ?? ''}
      {fmt(ms)}
      {props.suffix ?? ''}
    </Text>
  )
}

export default LiveClock
