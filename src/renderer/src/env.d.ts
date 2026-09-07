import type { AppApi } from '../shared/api'

declare global {
  interface Window {
    api: AppApi
  }
}

export {}
