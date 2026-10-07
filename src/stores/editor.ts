import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { ObjectType, PerformanceSettings, SceneDocument, SceneObject, TransformMode, Vec3 } from '../types/scene'
import type { HistoryState, SceneSnapshot } from '../types/history'
import { createSceneObject, createStarterScene, descendantsOf, uid } from '../utils/scene'
import {
  buildPersistedState,
  loadFromStorage,
  migrateDocument,
  saveToStorage,
  snapshotOf,
  type SaveResult,
} from '../utils/persistence'

interface EditorState {
  name: string
  objects: SceneObject[]
  selectedId: string | null
  transformMode: TransformMode
  snapEnabled: boolean
  snapSize: number
  performance: PerformanceSettings
  notice: string
  past: SceneSnapshot[]
  future: SceneSnapshot[]
  batchVersion: number
  saveError: string | null
  select: (id: string | null) => void
  add: (type: ObjectType, parentId?: string | null) => void
  update: (id: string, patch: Partial<SceneObject>) => void
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
  loadScene: (document: SceneDocument) => void
  reset: () => void
  noticeMessage: (message: string) => void
  beginTransaction: () => void
  commitTransaction: () => void
  undo: () => void
  redo: () => void
  persistNow: (options?: { silent?: boolean; force?: boolean }) => SaveResult
  retryPersist: () => void
  dismissSaveError: () => void
}

const persisted = loadFromStorage()

const initialHistory: HistoryState = persisted?.history ?? { past: [], future: [] }
const initialName = persisted?.document.name ?? '产品发布会三维展台'
const initialObjects = persisted?.document.objects ?? createStarterScene()
const initialSelectedId = persisted
  ? (persisted.document.objects[0]?.id ?? null)
  : 'hero-box'
const initialNotice = persisted
  ? (persisted.quarantined > 0
    ? `已恢复上次会话，${persisted.quarantined} 个异常层级关系已隔离`
    : '已从本机恢复上次编辑的场景与历史')
  : '选择物体后可使用 G / R / S 切换变换工具'

// Last successfully persisted payload, used to skip redundant saves and to roll back on failure.
let lastGoodPayload: string | null = persisted
  ? JSON.stringify(buildPersistedState({ name: initialName, objects: initialObjects }, initialHistory))
  : null
// Full snapshot of the last known-good state (scene + history) for rollback after a failed save.
let lastGood: { snapshot: SceneSnapshot; history: HistoryState } = {
  snapshot: snapshotOf({ name: initialName, objects: initialObjects, selectedId: initialSelectedId }),
  history: JSON.parse(JSON.stringify(initialHistory)),
}

// Transaction bookkeeping (module-level so the store stays serializable).
let txDepth = 0
let txDirty = false
let txSnapshot: SceneSnapshot | null = null

export const useEditorStore = create<EditorState>()(immer((set, get) => {
  /** Record a scene mutation as one undoable transaction (or fold into an open transaction). */
  function record(mutator: (draft: EditorState) => void) {
    set((draft) => {
      if (txDepth === 0) {
        draft.past.push(snapshotOf(get()))
        draft.future = []
      } else {
        txDirty = true
      }
      mutator(draft)
    })
  }

  function applySnapshot(draft: EditorState, snapshot: SceneSnapshot) {
    draft.name = snapshot.name
    // Snapshots live in the immer draft, so clone via JSON (structuredClone cannot read drafts).
    draft.objects = JSON.parse(JSON.stringify(snapshot.objects))
    draft.selectedId = snapshot.selectedId
    draft.batchVersion += 1
  }

  return {
    name: initialName,
    objects: initialObjects,
    selectedId: initialSelectedId,
    transformMode: 'translate',
    snapEnabled: true,
    snapSize: 0.25,
    performance: { instanceMode: false, shadows: true, showGrid: true, pixelRatio: 1.5 },
    notice: initialNotice,
    past: initialHistory.past,
    future: initialHistory.future,
    batchVersion: 0,
    saveError: null,

    select: (id) => set((state) => { state.selectedId = id }),

    add: (type, parentId = null) => record((draft) => {
      const object = createSceneObject(type, parentId)
      const index = draft.objects.filter((item) => item.parentId === parentId).length
      object.position[0] += index * 0.8
      object.position[2] += index * 0.35
      draft.objects.push(object)
      draft.selectedId = object.id
      draft.notice = `已添加${object.name}`
    }),

    update: (id, patch) => record((draft) => {
      const index = draft.objects.findIndex((item) => item.id === id)
      if (index >= 0) draft.objects[index] = { ...draft.objects[index], ...patch }
    }),

    setTransform: (id, patch) => {
      const object = get().objects.find((item) => item.id === id)
      if (!object) return
      const unchanged = object.position.every((value, axis) => value === patch.position[axis])
        && object.rotation.every((value, axis) => value === patch.rotation[axis])
        && object.scale.every((value, axis) => value === patch.scale[axis])
      if (unchanged) return
      record((draft) => {
        const target = draft.objects.find((item) => item.id === id)
        if (!target) return
        target.position = patch.position
        target.rotation = patch.rotation
        target.scale = patch.scale
      })
    },

    reparent: (id, parentId) => {
      if (id === parentId || (parentId && descendantsOf(id, get().objects).has(parentId))) {
        set((draft) => { draft.notice = '无法将物体挂载到自身的子级' })
        return false
      }
      if (parentId && !get().objects.some((item) => item.id === parentId)) {
        set((draft) => { draft.notice = '目标父级不存在' })
        return false
      }
      record((draft) => {
        const object = draft.objects.find((item) => item.id === id)
        if (object) object.parentId = parentId
        draft.batchVersion += 1
        draft.notice = parentId ? '层级关系已更新' : '已移动到场景根节点'
      })
      return true
    },

    remove: (id) => record((draft) => {
      const removed = descendantsOf(id, draft.objects)
      removed.add(id)
      draft.objects = draft.objects.filter((item) => !removed.has(item.id))
      if (draft.selectedId && removed.has(draft.selectedId)) draft.selectedId = null
      draft.notice = `已删除 ${removed.size} 个对象`
    }),

    duplicate: (id) => record((draft) => {
      const source = draft.objects.find((item) => item.id === id)
      if (!source) return
      const copy = JSON.parse(JSON.stringify(source)) as SceneObject
      copy.id = uid(source.type)
      copy.name = `${source.name} 副本`
      copy.position[0] += 0.8
      draft.objects.push(copy)
      draft.selectedId = copy.id
      draft.notice = '已复制物体'
    }),

    setTransformMode: (mode) => set((state) => { state.transformMode = mode }),
    setSnapEnabled: (enabled) => set((state) => { state.snapEnabled = enabled }),
    setSnapSize: (size) => set((state) => { state.snapSize = size }),
    setPerformance: (patch) => set((state) => { Object.assign(state.performance, patch) }),

    align: (axis) => record((draft) => {
      const object = draft.objects.find((item) => item.id === draft.selectedId)
      if (!object) return
      object.position[axis] = 0
      draft.notice = `已沿 ${['X', 'Y', 'Z'][axis]} 轴对齐到原点`
    }),

    addStressObjects: (count = 240) => record((draft) => {
      for (let index = 0; index < count; index += 1) {
        const type: ObjectType = index % 3 === 0 ? 'box' : index % 3 === 1 ? 'sphere' : 'cylinder'
        const object = createSceneObject(type)
        const grid = 20
        object.name = `压力测试 ${index + 1}`
        object.position = [((index % grid) - grid / 2) * 0.75, 0.35 + Math.floor(index / (grid * grid)) * 0.7, (Math.floor(index / grid) % grid - grid / 2) * 0.75]
        object.scale = [0.25, 0.25, 0.25]
        object.material.color = ['#3b82f6', '#14b8a6', '#f59e0b', '#ef4444'][index % 4]
        draft.objects.push(object)
      }
      draft.performance.instanceMode = true
      draft.notice = `已添加 ${count} 个几何体并开启实例化渲染`
    }),

    loadScene: (document) => {
      const { document: clean, quarantined } = migrateDocument(document)
      record((draft) => {
        draft.name = clean.name
        draft.objects = clean.objects
        draft.selectedId = clean.objects[0]?.id ?? null
        draft.batchVersion += 1
        draft.notice = quarantined > 0
          ? `场景已导入，${quarantined} 个异常层级关系已隔离`
          : '场景 JSON 已导入'
      })
    },

    reset: () => record((draft) => {
      draft.name = '产品发布会三维展台'
      draft.objects = createStarterScene()
      draft.selectedId = 'hero-box'
      draft.batchVersion += 1
      draft.notice = '已恢复示例场景（可撤销）'
    }),

    noticeMessage: (message) => set((state) => { state.notice = message }),

    beginTransaction: () => {
      if (txDepth === 0) {
        txSnapshot = snapshotOf(get())
        txDirty = false
      }
      txDepth += 1
    },

    commitTransaction: () => {
      if (txDepth === 0) return
      txDepth -= 1
      if (txDepth === 0) {
        if (txDirty && txSnapshot) {
          const before = txSnapshot
          set((draft) => {
            draft.past.push(before)
            draft.future = []
          })
        }
        txSnapshot = null
        txDirty = false
      }
    },

    undo: () => {
      if (get().past.length === 0) return
      const current = snapshotOf(get())
      set((draft) => {
        const previous = draft.past[draft.past.length - 1]
        draft.past.pop()
        draft.future = [current, ...draft.future]
        applySnapshot(draft, previous)
        draft.notice = '已撤销'
      })
    },

    redo: () => {
      if (get().future.length === 0) return
      const current = snapshotOf(get())
      set((draft) => {
        const next = draft.future[0]
        draft.future = draft.future.slice(1)
        draft.past.push(current)
        applySnapshot(draft, next)
        draft.notice = '已重做'
      })
    },

    persistNow: (options) => {
      const state = get()
      const payload = JSON.stringify(buildPersistedState(
        { name: state.name, objects: state.objects },
        { past: state.past, future: state.future },
      ))
      if (!options?.force && payload === lastGoodPayload) return { ok: true }

      const before = snapshotOf(state)
      const result = saveToStorage(JSON.parse(payload) as ReturnType<typeof buildPersistedState>)
      if (result.ok) {
        lastGoodPayload = payload
        lastGood = {
          snapshot: before,
          history: JSON.parse(JSON.stringify({ past: state.past, future: state.future })),
        }
        set((draft) => {
          draft.saveError = null
          if (!options?.silent) draft.notice = '场景与历史已保存到本机'
        })
        return { ok: true }
      }

      // Save failed: roll the scene AND history back to the last successfully persisted state, then offer retry.
      set((draft) => {
        applySnapshot(draft, lastGood.snapshot)
        draft.past = JSON.parse(JSON.stringify(lastGood.history.past))
        draft.future = JSON.parse(JSON.stringify(lastGood.history.future))
        draft.saveError = result.error
        draft.notice = '保存失败，已恢复到上次保存的现场，可重试'
      })
      return { ok: false, error: result.error }
    },

    retryPersist: () => {
      get().persistNow({ force: true })
    },

    dismissSaveError: () => set((draft) => { draft.saveError = null }),
  }
}))

// Auto-persist shortly after the scene or history changes (debounced).
let saveTimer: ReturnType<typeof setTimeout> | undefined
useEditorStore.subscribe((state, previous) => {
  if (
    state.objects === previous.objects
    && state.name === previous.name
    && state.past === previous.past
    && state.future === previous.future
  ) return
  globalThis.clearTimeout(saveTimer)
  saveTimer = globalThis.setTimeout(() => {
    useEditorStore.getState().persistNow({ silent: true })
  }, 1200)
})

export function updateVector(vector: Vec3, axis: 0 | 1 | 2, value: number): Vec3 {
  const next: Vec3 = [...vector]
  next[axis] = value
  return next
}
