import { app } from 'electron'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { LayoutMeta } from '../shared/ipc'

const layoutsDir = (): string => {
  const dir = join(app.getPath('userData'), 'layouts')
  mkdirSync(dir, { recursive: true })
  return dir
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
  try {
    const file = JSON.parse(readFileSync(layoutPath(id), 'utf8')) as Partial<LayoutFile>
    return typeof file.json === 'string' ? file.json : null
  } catch {
    return null
  }
}

export function saveLayout(meta: LayoutMeta, json: string): void {
  const file: LayoutFile = { id: meta.id, name: meta.name, createdAt: meta.createdAt, json }
  writeFileSync(layoutPath(meta.id), JSON.stringify(file, null, 2), 'utf8')
}

export function deleteLayout(id: string): void {
  try {
    rmSync(layoutPath(id))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}