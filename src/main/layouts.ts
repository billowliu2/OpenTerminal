import { app } from 'electron'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { LayoutMeta } from '../shared/ipc'
import { writeJson } from './store'

/** Layout ids reach this module straight from the renderer and are joined into
 *  a path, so only a plain id is accepted — `..`, separators and drive prefixes
 *  would otherwise escape `userData/layouts`. */
const LAYOUT_ID = /^[A-Za-z0-9._-]{1,64}$/

const layoutsDir = (): string => {
  const dir = join(app.getPath('userData'), 'layouts')
  mkdirSync(dir, { recursive: true })
  return dir
}

function isValidLayoutId(id: unknown): id is string {
  return typeof id === 'string' && LAYOUT_ID.test(id)
}

function layoutPath(id: string): string {
  return join(layoutsDir(), `${id}.json`)
}

interface LayoutFile {
  id: string
  name: string
  createdAt: number
  json: string
}

export function listLayouts(): LayoutMeta[] {
  const dir = layoutsDir()
  const metas: LayoutMeta[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    try {
      const file = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as Partial<LayoutFile>
      const id = typeof file.id === 'string' ? file.id : entry.slice(0, -'.json'.length)
      const name = typeof file.name === 'string' ? file.name : id
      const createdAt = typeof file.createdAt === 'number' ? file.createdAt : 0
      metas.push({ id, name, createdAt })
    } catch {
      // skip corrupted file
    }
  }
  return metas.sort((a, b) => b.createdAt - a.createdAt)
}

export function getLayout(id: string): string | null {
  if (!isValidLayoutId(id)) return null
  try {
    const file = JSON.parse(readFileSync(layoutPath(id), 'utf8')) as Partial<LayoutFile>
    return typeof file.json === 'string' ? file.json : null
  } catch {
    return null
  }
}

export function saveLayout(meta: LayoutMeta, json: string): void {
  if (!isValidLayoutId(meta.id)) {
    throw new Error(`[layouts] invalid layout id: ${String(meta.id)}`)
  }
  const file: LayoutFile = { id: meta.id, name: meta.name, createdAt: meta.createdAt, json }
  writeJson(layoutPath(meta.id), file)
}

export function deleteLayout(id: string): void {
  if (!isValidLayoutId(id)) {
    throw new Error(`[layouts] invalid layout id: ${String(id)}`)
  }
  try {
    rmSync(layoutPath(id))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}