import type { HistoryData, HistoryEntry, SceneDocument } from '../types/scene'
import { migrateDocument, sanitizeHistory } from './scene'

export const STORAGE_KEY = 'sceneforge.document.v2'

/** 本机存储留给历史的体积预算，超出后按“先丢最远的撤销”裁剪 */
const HISTORY_BUDGET = 3_000_000
export const HISTORY_LIMIT = 60

export interface HydrateResult {
  document: SceneDocument | null
  issues: string[]
  error: string | null
}

/** 启动时从本机恢复现场与历史；任何损坏都不阻断启动，降级为初始场景 */
export function hydrateDocument(): HydrateResult {
  try {
    if (typeof localStorage === 'undefined') return { document: null, issues: [], error: null }
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { document: null, issues: [], error: null }
    const { document, issues } = migrateDocument(JSON.parse(raw))
    return { document, issues, error: null }
  } catch (error) {
    return { document: null, issues: [], error: error instanceof Error ? error.message : '本机历史无法读取' }
  }
}

export function trimHistory(past: HistoryEntry[], future: HistoryEntry[]): HistoryData {
  let nextPast = [...past]
  const nextFuture = [...future]
  if (nextPast.length > HISTORY_LIMIT) nextPast = nextPast.slice(nextPast.length - HISTORY_LIMIT)
  return { t: Date.now(), past: nextPast, future: nextFuture }
}

/**
 * 写入本机。配额不足时按“先丢重做、再丢最早的撤销”逐级裁剪重试；
 * 仍然失败就把错误抛回，现场保留在内存里，由调用方提供重试。
 */
export function persistDocument(document: SceneDocument): void {
  if (typeof localStorage === 'undefined') throw new Error('当前环境不支持本机存储')
  let history = document.history ? trimHistory(document.history.past, document.history.future) : undefined
  const attempt = (): void => {
    const payload: SceneDocument = { ...document, ...(history ? { history } : {}) }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch (error) {
      const quota = isQuotaError(error)
      if (!quota) throw new Error('本机存储写入失败')
      if (history && history.future.length > 0) {
        history = { ...history, future: history.future.slice(1) }
        attempt()
        return
      }
      if (history && history.past.length > 1 && JSON.stringify(payload).length > HISTORY_BUDGET) {
        history = { ...history, past: history.past.slice(1) }
        attempt()
        return
      }
      throw new Error('本机存储空间不足，现场已保留在当前页面，可重试保存')
    }
  }
  attempt()
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException
    && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22)
}
