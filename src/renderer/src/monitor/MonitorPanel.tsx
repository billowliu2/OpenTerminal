import { useEffect, useRef, useState } from 'react'
import type { SysinfoMeta, SysinfoSample } from '@shared/sysinfo'
import './monitor.css'

export interface MonitorPanelProps {
  /** ssh session id */
  sessionId: string
}

/** Max history points kept (60 samples @ 3s = ~3 minutes). */
const HISTORY_LEN = 60

interface HistoryChartProps {
  data: number[]
  lineColor: string
  fillColor: string
  /** canvas CSS height in px */
  height: number
  /** fixed Y max; omit for auto-scale (max * 1.2) */
  maxY?: number
}

/** Hand-drawn area line chart on a DPR-scaled canvas. No third-party deps. */
function HistoryChart({ data, lineColor, fillColor, height, maxY }: HistoryChartProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dataRef = useRef<number[]>(data)
  dataRef.current = data

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1
      const width = Math.max(1, container.clientWidth)
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)

      const pts = dataRef.current
      if (pts.length < 2) return

      const top = maxY ?? Math.max(1, Math.max(...pts) * 1.2)
      const x = (i: number): number => (i / (pts.length - 1)) * width
      const y = (v: number): number => height - (Math.min(v, top) / top) * height

      // area fill
      ctx.beginPath()
      pts.forEach((v, i) => {
        if (i === 0) ctx.moveTo(x(i), y(v))
        else ctx.lineTo(x(i), y(v))
      })
      ctx.lineTo(x(pts.length - 1), height)
      ctx.lineTo(0, height)
      ctx.closePath()
      ctx.fillStyle = fillColor
      ctx.fill()

      // line
      ctx.beginPath()
      pts.forEach((v, i) => {
        if (i === 0) ctx.moveTo(x(i), y(v))
        else ctx.lineTo(x(i), y(v))
      })
      ctx.strokeStyle = lineColor
      ctx.lineWidth = 1.5
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.stroke()
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(container)
    return () => ro.disconnect()
  }, [height, maxY, lineColor, fillColor])

  return (
    <div ref={containerRef} className="mm-chart">
      <canvas ref={canvasRef} />
    </div>
  )
}

/** Red/green/yellow threshold bar color for CPU usage. */
function cpuColor(usage: number): string {
  if (usage > 80) return '#f85149'
  if (usage > 60) return '#e3b341'
  return '#3fb950'
}

/** Format a size in MB: show GB (1 decimal) once over 1024 MB. */
function formatSize(mb: number): string {
  const gb = mb / 1024
  if (gb >= 1) return `${gb.toFixed(1)}G`
  return `${Math.round(mb)}MB`
}

/** human-readable uptime */
function humanizeUptime(sec: number): string {
  const s = Math.floor(sec)
  if (s < 60) return `${s}秒`
  const mins = Math.floor(s / 60)
  if (s < 3600) return `${mins}分钟`
  const hours = Math.floor(s / 3600)
  if (s < 86400) return `${hours}小时${Math.floor((s % 3600) / 60)}分`
  return `${Math.floor(s / 86400)}天`
}

function Bar({ pct, color }: { pct: number; color: string }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="mm-bar">
      <div
        className="mm-bar-fill"
        style={{ width: `${clamped}%`, background: color }}
      />
    </div>
  )
}

export function MonitorPanel({ sessionId }: MonitorPanelProps): React.JSX.Element {
  const [meta, setMeta] = useState<SysinfoMeta | null>(null)
  const [sample, setSample] = useState<SysinfoSample | null>(null)
  const sampleRef = useRef<SysinfoSample | null>(null)
  const [cpuHist, setCpuHist] = useState<number[]>([])
  const [rxHist, setRxHist] = useState<number[]>([])
  const [txHist, setTxHist] = useState<number[]>([])

  useEffect(() => {
    let disposed = false
    setCpuHist([])
    setRxHist([])
    setTxHist([])
    window.api.sysinfoStart(sessionId)
    const offMeta = window.api.onSysinfoMeta((e: { id: string; meta: SysinfoMeta }) => {
      if (e.id !== sessionId || disposed) return
      setMeta(e.meta)
    })
    const offSample = window.api.onSysinfoSample((e: { id: string; sample: SysinfoSample }) => {
      if (e.id !== sessionId || disposed) return
      sampleRef.current = e.sample
      setSample(e.sample)
      if (!e.sample.error) {
        setCpuHist((prev) => (prev.length >= HISTORY_LEN ? [...prev.slice(1), e.sample.cpu.usage] : [...prev, e.sample.cpu.usage]))
        setRxHist((prev) => (prev.length >= HISTORY_LEN ? [...prev.slice(1), e.sample.net.rxKbs] : [...prev, e.sample.net.rxKbs]))
        setTxHist((prev) => (prev.length >= HISTORY_LEN ? [...prev.slice(1), e.sample.net.txKbs] : [...prev, e.sample.net.txKbs]))
      }
    })
    return () => {
      disposed = true
      offMeta()
      offSample()
      window.api.sysinfoStop(sessionId)
    }
  }, [sessionId])

  if (!meta || !sample) {
    return (
      <div className="mm-root mm-empty">
        <span className="mm-dots"><span /> <span /> <span /></span>
        采集中…
      </div>
    )
  }

  const cpu = sample.cpu
  const mem = sample.mem
  const disks = sample.disks ?? []
  const net = sample.net
  const failed = Boolean(sample.error)
  const memPct = mem.totalMb > 0 ? (mem.usedMb / mem.totalMb) * 100 : 0

  return (
    <div className={`mm-root${failed ? ' mm-failed' : ''}`}>
      {failed && <div className="mm-error">采集中断：{sample.error}</div>}

      <header className="mm-header">
        <span className="mm-host">{meta.hostname || 'unknown'}</span>
        <span className="mm-os">{meta.os}</span>
      </header>

      <section className="mm-block" aria-label="CPU">
        <div className="mm-block-row">
          <span className="mm-label">CPU</span>
          <span className="mm-value" style={{ color: cpuColor(cpu.usage) }}>
            {cpu.usage.toFixed(0)}%<span className="mm-value-sub"> · {cpu.cores} 核</span>
          </span>
        </div>
        <Bar pct={cpu.usage} color={cpuColor(cpu.usage)} />
        <div className="mm-sub mm-load">
          负载 {cpu.loadavg.map((v) => v.toFixed(1)).join(' / ')}
        </div>
        <HistoryChart data={cpuHist} lineColor="#3fb950" fillColor="rgba(63,185,80,0.15)" height={48} maxY={100} />
      </section>

      <section className="mm-block" aria-label="内存">
        <div className="mm-block-row">
          <span className="mm-label">内存</span>
          <span className="mm-mem-size">
            {formatSize(mem.usedMb)} / {formatSize(mem.totalMb)}
          </span>
        </div>
        <div className="mm-mem-row">
          <div className="mm-mem-bar">
            <Bar pct={memPct} color="#d29922" />
          </div>
          <span className="mm-mem-pct">{memPct.toFixed(0)}%</span>
        </div>
      </section>

      {disks.length > 0 && (
        <section className="mm-block" aria-label="磁盘">
          <div className="mm-block-row">
            <span className="mm-label">磁盘</span>
          </div>
          <div className="mm-disks">
            {disks.slice(0, 6).map((d) => {
              const pct = d.totalMb > 0 ? (d.usedMb / d.totalMb) * 100 : 0
              return (
                <div className="mm-disk" key={d.mount}>
                  <span className="mm-mount" title={d.mount}>
                    {d.mount}
                  </span>
                  <div className="mm-disk-bar">
                    <Bar pct={pct} color={cpuColor(pct)} />
                  </div>
                  <span className="mm-disk-size">
                    {formatSize(d.usedMb)} / {formatSize(d.totalMb)}
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      )}

      <section className="mm-block" aria-label="网络">
        <div className="mm-block-row">
          <span className="mm-label">网络</span>
          <div className="mm-net">
            <span className="mm-net-item mm-rx">
              <span className="mm-arrow mm-up">↓</span>
              {(net?.rxKbs ?? 0).toFixed(4)}
              <span className="mm-net-unit"> KB/s</span>
            </span>
            <span className="mm-net-item mm-tx">
              <span className="mm-arrow mm-down">↑</span>
              {(net?.txKbs ?? 0).toFixed(4)}
              <span className="mm-net-unit"> KB/s</span>
            </span>
          </div>
        </div>
        <div className="mm-net-charts">
          <HistoryChart data={rxHist} lineColor="#58a6ff" fillColor="rgba(88,166,255,0.15)" height={40} />
          <HistoryChart data={txHist} lineColor="#f2cc60" fillColor="rgba(242,204,96,0.15)" height={40} />
        </div>
      </section>

      <footer className="mm-footer">
        运行时间 <span className="mm-uptime">{humanizeUptime(sample.uptimeSec)}</span>
      </footer>
    </div>
  )
}