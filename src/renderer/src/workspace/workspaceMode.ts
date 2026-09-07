/** M6.1 workspace mode: local terminal vs SSH 服务器 —— 两组面板互不混排。 */
export type WorkspaceMode = 'terminal' | 'ssh'

export const WORKSPACE_MODE_ORDER: readonly WorkspaceMode[] = ['terminal', 'ssh']

/** Dockview panel id 前缀：同组内面板以此为前缀，切换模式时按前缀整体 hide/show。 */
export const WORKSPACE_GROUP_PREFIX: Record<WorkspaceMode, string> = {
  terminal: 'terminal:',
  ssh: 'ssh:'
}

/** 每个 workspace 组顶部的固定标记面板（不可关闭），作为该组显示/隐藏与激活的锚点。 */
export const WORKSPACE_MARKER_ID: Record<WorkspaceMode, string> = {
  terminal: '__workspace-marker-terminal',
  ssh: '__workspace-marker-ssh'
}

/** 判断一个面板属于哪个 workspace 组（marker 面板本身不算会话面板）。 */
export function workspaceModeOfPanelId(id: string): WorkspaceMode | null {
  if (id.startsWith(WORKSPACE_GROUP_PREFIX.terminal)) return 'terminal'
  if (id.startsWith(WORKSPACE_GROUP_PREFIX.ssh)) return 'ssh'
  return null
}

/** 从面板 params 判断（新逻辑以此为第一优先，兼容旧无 params 的面板回退到 id 前缀）。 */
export function workspaceModeOfParams(params: { sessionKind?: 'local' | 'ssh' } | undefined): WorkspaceMode | null {
  if (params?.sessionKind === 'local') return 'terminal'
  if (params?.sessionKind === 'ssh') return 'ssh'
  return null
}
