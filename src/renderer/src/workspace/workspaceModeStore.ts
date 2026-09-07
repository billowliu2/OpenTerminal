import { create } from 'zustand'

/** 工作区模式：终端（本地）/ SSH（远程服务器）。 */
export type WorkspaceMode = 'terminal' | 'ssh'

interface WorkspaceModeState {
  mode: WorkspaceMode
  setMode: (mode: WorkspaceMode) => void
}

const LS_KEY = 'ot.workspaceMode'

function readInitial(): WorkspaceMode {
  try {
    const v = window.localStorage.getItem(LS_KEY)
    return v === 'ssh' ? 'ssh' : 'terminal'
  } catch {
    return 'terminal'
  }
}

/**
 * 全局工作区模式 store。IconRail 的模式入口、Workspace 的分流、
 * ConnectionSidebar 的区块过滤都订阅它。
 */
export const useWorkspaceModeStore = create<WorkspaceModeState>((set) => ({
  mode: readInitial(),
  setMode: (mode) => {
    try {
      window.localStorage.setItem(LS_KEY, mode)
    } catch {
      // ignore
    }
    set({ mode })
  }
}))
