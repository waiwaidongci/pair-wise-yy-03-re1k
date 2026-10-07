import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { SCENE_VERSION } from '../types/scene'
import type {
  ObjectType,
  PerformanceSettings,
  SaveStatus,
  SceneDocument,
  SceneObject,
  SceneSnapshot,
  TransformMode,
  Vec3,
} from '../types/scene'
import {
  createSceneObject,
  createStarterScene,
  descendantsOf,
  reparentPreserveWorld,
  migrateDocument,
  uid,
} from '../utils/scene'
import { hydrateDocument, persistDocument } from '../utils/persistence'

/** 连续同键提交在此时长内合并为一次撤销（滑杆拖动、连续输入） */
const COALESCE_MS = 800

interface EditorState {
  name: string
  objects: SceneObject[]
  selectedId: string | null
  transformMode: TransformMode
  snapEnabled: boolean
  snapSize: number
  performance: PerformanceSettings
  notice: string

  past: HistoryEntryView[]
  future: HistoryEntryView[]
  /** 拖拽起点快照，mouseup 时整笔提交 */
  dragBase: SceneSnapshot | null
  /** 结构/变换每次提交自增，驱动实例批次失效重算 */
  batchRevision: number

  saveStatus: SaveStatus
  saveError: string | null
  lastSavedAt: string | null

  select: (id: string | null) => void
  beginDrag: () => void
  add: (type: ObjectType, parentId?: string | null) => void
  update: (id: string, patch: Partial<SceneObject>, coalesceKey?: string) => void
  setTransform: (id: string, patch: Pick<SceneObject, 'position' | 'rotation' | 'scale'>) => void
  reparent: (id: string, parentId: string | null) => boolean
  remove: (id: string) => void
  duplicate: (id: string) => void
  setTransformMode: (mode: TransformMode) => void
  setSnapEnabled: (enabled: boolean) => void
  setSnapSize: (size: number) => void
  setPerformance: (patch: Partial<PerformanceSettings>) => void
  align: (axis: 0 | 1 | 2) => void
  addStressObjects: (count?: number) => void
  importScene: (raw: unknown) => void
  reset: () => void
  undo: () => void
  redo: () => void
  saveScene: () => void
  noticeMessage: (message: string) => void
}

interface HistoryEntryView {
  t: number
  label: string
  coalesceKey?: string
  snapshot: SceneSnapshot
}

function takeSnapshot(get: () => EditorState): SceneSnapshot {
  const state = get()
  return {
    name: state.name,
    objects: structuredClone(state.objects),
    selectedId: state.selectedId,
  }
}

function applySnapshot(state: EditorState, snapshot: SceneSnapshot) {
  state.name = snapshot.name
  state.objects = structuredClone(snapshot.objects)
  state.selectedId = snapshot.objects.some((item) => item.id === snapshot.selectedId) ? snapshot.selectedId : null
}

function pushEntry(
  state: EditorState,
  before: SceneSnapshot,
  label: string,
  options: { coalesceKey?: string } = {},
) {
  const now = Date.now()
  const last = state.past[state.past.length - 1]
  if (options.coalesceKey && last?.coalesceKey === options.coalesceKey && now - last.t <= COALESCE_MS) {
    // 同键连续编辑：保留整组编辑前的快照，只刷新时间与标签
    last.t = now
    last.label = label
  } else {
    const entry: HistoryEntryView = {
      t: now,
      label,
      snapshot: before,
      ...(options.coalesceKey ? { coalesceKey: options.coalesceKey } : {}),
    }
    state.past.push(entry)
    if (state.past.length > 60) state.past.shift()
  }
  // 任何新改动都使旧的重做记录作废
  state.future = []
  state.batchRevision += 1
  state.dragBase = null
}

const hydration = hydrateDocument()

function initialScene(): { name: string; objects: SceneObject[]; selectedId: string | null } {
  if (hydration.document) {
    return {
      name: hydration.document.name,
      objects: hydration.document.objects,
      selectedId: hydration.document.selectedId,
    }
  }
  return { name: '产品发布会三维展台', objects: createStarterScene(), selectedId: 'hero-box' }
}

const initial = initialScene()
const initialHistory = hydration.document?.history

export const useEditorStore = create<EditorState>()(immer((set, get) => {
  let persistTimer: ReturnType<typeof setTimeout> | undefined

  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => flushPersist(true), 600)
  }

  const buildDocument = (): SceneDocument => {
    const state = get()
    return {
      version: SCENE_VERSION,
      name: state.name,
      objects: structuredClone(state.objects),
      selectedId: state.selectedId,
      savedAt: new Date().toISOString(),
      history: {
        t: Date.now(),
        past: structuredClone(state.past),
        future: structuredClone(state.future),
      },
    }
  }

  /** 落本机；失败只改状态，内存现场原样保留，saveScene 可反复重试 */
  const flushPersist = (auto: boolean) => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = undefined
    }
    const document = buildDocument()
    set((state) => { state.saveStatus = 'saving' })
    try {
      persistDocument(document)
      set((state) => {
        state.saveStatus = 'saved'
        state.saveError = null
        state.lastSavedAt = document.savedAt
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '本机保存失败'
      set((state) => {
        state.saveStatus = 'error'
        state.saveError = message
        if (!auto) state.notice = `${message}，可点击重试`
      })
    }
  }

  return {
    name: initial.name,
    objects: initial.objects,
    selectedId: initial.selectedId,
    transformMode: 'translate',
    snapEnabled: true,
    snapSize: 0.25,
    performance: { instanceMode: false, shadows: true, showGrid: true, pixelRatio: 1.5 },
    notice: hydration.error
      ? `本机历史已损坏，已从示例场景启动：${hydration.error}`
      : hydration.issues.length > 0
        ? `本机场景已恢复：${hydration.issues.join('；')}`
        : '选择物体后可使用 G / R / S 切换变换工具',

    past: (initialHistory?.past ?? []) as HistoryEntryView[],
    future: (initialHistory?.future ?? []) as HistoryEntryView[],
    dragBase: null,
    batchRevision: 0,

    saveStatus: 'idle',
    saveError: null,
    lastSavedAt: hydration.document?.savedAt ?? null,

    select: (id) => set((state) => { state.selectedId = id }),

    beginDrag: () => {
      if (get().dragBase) return
      const snapshot = takeSnapshot(get)
      set((state) => { state.dragBase = snapshot })
    },

    add: (type, parentId = null) => {
      const before = takeSnapshot(get)
      set((state) => {
        const object = createSceneObject(type, parentId)
        const index = state.objects.filter((item) => item.parentId === parentId).length
        object.position[0] += index * 0.8
        object.position[2] += index * 0.35
        state.objects.push(object)
        state.selectedId = object.id
        state.notice = `已添加${object.name}`
        pushEntry(state, before, `添加 ${object.name}`)
      })
      schedulePersist()
    },

    update: (id, patch, coalesceKey) => {
      const before = takeSnapshot(get)
      const object = get().objects.find((item) => item.id === id)
      if (!object) return
      set((state) => {
        const index = state.objects.findIndex((item) => item.id === id)
        if (index < 0) return
        state.objects[index] = { ...state.objects[index], ...patch }
        const label = `编辑 ${state.objects[index].name}`
        pushEntry(state, before, label, coalesceKey ? { coalesceKey: `${coalesceKey}:${id}` } : undefined)
      })
      schedulePersist()
    },

    setTransform: (id, patch) => {
      const current = get().objects.find((item) => item.id === id)
      if (!current) return
      const unchanged =
        sameVec(current.position, patch.position) &&
        sameVec(current.rotation, patch.rotation) &&
        sameVec(current.scale, patch.scale)
      if (unchanged) {
        set((state) => { state.dragBase = null })
        return
      }
      // 拖拽用 dragBase（整笔一次）；其余调用用当前快照
      const before = get().dragBase ?? takeSnapshot(get)
      set((state) => {
        const object = state.objects.find((item) => item.id === id)
        if (!object) return
        object.position = [...patch.position]
        object.rotation = [...patch.rotation]
        object.scale = [...patch.scale]
        pushEntry(state, before, `变换 ${object.name}`)
      })
      schedulePersist()
    },

    reparent: (id, parentId) => {
      if (id === parentId) return false
      if (parentId && descendantsOf(id, get().objects).has(parentId)) {
        set((state) => { state.notice = '无法将物体挂载到自身的子级' })
        return false
      }
      const target = get().objects.find((item) => item.id === id)
      if (!target || target.parentId === parentId) return false
      const before = takeSnapshot(get)
      set((state) => {
        reparentPreserveWorld(state.objects, id, parentId)
        state.notice = parentId ? '层级关系已更新，世界位置保持不变' : '已移动到场景根节点'
        pushEntry(state, before, '调整层级')
      })
      schedulePersist()
      return true
    },

    remove: (id) => {
      const before = takeSnapshot(get)
      set((state) => {
        const removed = descendantsOf(id, state.objects)
        removed.add(id)
        state.objects = state.objects.filter((item) => !removed.has(item.id))
        if (state.selectedId && removed.has(state.selectedId)) state.selectedId = null
        state.notice = `已删除 ${removed.size} 个对象`
        pushEntry(state, before, `删除 ${removed.size} 个对象`)
      })
      schedulePersist()
    },

    duplicate: (id) => {
      const before = takeSnapshot(get)
      set((state) => {
        const source = state.objects.find((item) => item.id === id)
        if (!source) return
        const copy = structuredClone(source)
        copy.id = uid(source.type)
        copy.name = `${source.name} 副本`
        copy.position[0] += 0.8
        state.objects.push(copy)
        state.selectedId = copy.id
        state.notice = '已复制物体'
        pushEntry(state, before, `复制 ${source.name}`)
      })
      schedulePersist()
    },

    setTransformMode: (mode) => set((state) => { state.transformMode = mode }),
    setSnapEnabled: (enabled) => set((state) => { state.snapEnabled = enabled }),
    setSnapSize: (size) => set((state) => { state.snapSize = size }),
    setPerformance: (patch) => set((state) => { Object.assign(state.performance, patch) }),

    align: (axis) => {
      const before = takeSnapshot(get)
      set((state) => {
        const object = state.objects.find((item) => item.id === state.selectedId)
        if (!object) return
        object.position[axis] = 0
        state.notice = `已沿 ${['X', 'Y', 'Z'][axis]} 轴对齐到原点`
        pushEntry(state, before, '轴对齐')
      })
      schedulePersist()
    },

    addStressObjects: (count = 240) => {
      const before = takeSnapshot(get)
      set((state) => {
        for (let index = 0; index < count; index += 1) {
          const type: ObjectType = index % 3 === 0 ? 'box' : index % 3 === 1 ? 'sphere' : 'cylinder'
          const object = createSceneObject(type)
          const grid = 20
          object.name = `压力测试 ${index + 1}`
          object.position = [((index % grid) - grid / 2) * 0.75, 0.35 + Math.floor(index / (grid * grid)) * 0.7, (Math.floor(index / grid) % grid - grid / 2) * 0.75]
          object.scale = [0.25, 0.25, 0.25]
          object.material.color = ['#3b82f6', '#14b8a6', '#f59e0b', '#ef4444'][index % 4]
          state.objects.push(object)
        }
        state.performance.instanceMode = true
        state.notice = `已添加 ${count} 个几何体并开启实例化渲染`
        pushEntry(state, before, `批量添加 ${count} 个对象`)
      })
      schedulePersist()
    },

    importScene: (raw) => {
      // 迁移与隔离在提交前完成；致命错误直接抛出，当前场景一点不动
      const { document, issues } = migrateDocument(raw)
      const before = takeSnapshot(get)
      set((state) => {
        state.name = document.name
        state.objects = document.objects
        state.selectedId = document.selectedId
        state.notice = issues.length > 0 ? `导入完成（可撤销）：${issues.join('；')}` : '场景 JSON 已导入，可随时撤销'
        pushEntry(state, before, '导入场景')
      })
      schedulePersist()
    },

    reset: () => {
      const before = takeSnapshot(get)
      set((state) => {
        state.name = '产品发布会三维展台'
        state.objects = createStarterScene()
        state.selectedId = 'hero-box'
        state.notice = '已恢复示例场景，可撤销回到刚才的编辑'
        pushEntry(state, before, '重置为示例场景')
      })
      schedulePersist()
    },

    undo: () => {
      const entry = get().past[get().past.length - 1]
      if (!entry) return
      const current = takeSnapshot(get)
      set((state) => {
        state.past.pop()
        state.future.unshift({ t: Date.now(), label: entry.label, snapshot: current })
        applySnapshot(state, entry.snapshot)
        state.batchRevision += 1
        state.dragBase = null
        state.notice = `已撤销：${entry.label}`
      })
      schedulePersist()
    },

    redo: () => {
      const entry = get().future[0]
      if (!entry) return
      const current = takeSnapshot(get)
      set((state) => {
        state.future.shift()
        state.past.push({ t: Date.now(), label: entry.label, snapshot: current })
        applySnapshot(state, entry.snapshot)
        state.batchRevision += 1
        state.dragBase = null
        state.notice = `已重做：${entry.label}`
      })
      schedulePersist()
    },

    saveScene: () => flushPersist(false),

    noticeMessage: (message) => set((state) => { state.notice = message }),
  }
}))

function sameVec(a: Vec3, b: Vec3) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}
