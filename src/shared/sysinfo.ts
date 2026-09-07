/** Remote server hardware monitoring sample (M3, ssh sessions only). */

export interface SysinfoMeta {
  /** e.g. "Linux 5.15.0 x86_64" */
  os: string
  hostname: string
}

export interface SysinfoSample {
  ts: number
  cpu: {
    /** 0..100 overall */
    usage: number
    cores: number
    loadavg: [number, number, number]
  }
  mem: {
    totalMb: number
    usedMb: number
  }
  disks: Array<{
    mount: string
    totalMb: number
    usedMb: number
  }>
  /** kilobytes per second since previous sample */
  net: {
    rxKbs: number
    txKbs: number
  }
  uptimeSec: number
  /** when set, the last collection failed (render an error state, keep old data) */
  error?: string
}
