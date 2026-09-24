import { app } from 'electron'

/**
 * Dev-only environment overrides. A packaged build must ignore these variables
 * even when they are present in its environment: whoever can inject env vars
 * into a launch (a wrapper script, a shortcut, malware with user rights) could
 * otherwise point the renderer — and with it the IPC trust check — at a remote
 * origin, or redirect the update feed to a hostile server.
 */

/**
 * Vite dev server URL, or undefined when the packaged renderer file must be
 * loaded. Packaged builds never honor ELECTRON_RENDERER_URL.
 */
export function devRendererUrl(): string | undefined {
  if (app.isPackaged) return undefined
  return process.env['ELECTRON_RENDERER_URL'] || undefined
}

/**
 * Custom update feed URL for development, or undefined to use the production
 * Gitea feed. Packaged builds never honor OT_UPDATE_URL (OT_UPDATE_TOKEN is
 * unrelated and still read from the environment in every build).
 */
export function devUpdateFeedUrl(): string | undefined {
  if (app.isPackaged) return undefined
  return process.env['OT_UPDATE_URL'] || undefined
}
