export type Vec3 = [number, number, number]
export type ObjectType = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane' | 'directionalLight' | 'pointLight' | 'spotLight' | 'camera'
export type TransformMode = 'translate' | 'rotate' | 'scale'

export const SCENE_VERSION = 2

export interface MaterialSpec {
  color: string
  roughness: number
  metalness: number
  opacity: number
  wireframe: boolean
}

export interface SceneObject {
  id: string
  name: string
  type: ObjectType
  parentId: string | null
  visible: boolean
  position: Vec3
  rotation: Vec3
  scale: Vec3
  castShadow: boolean
  receiveShadow: boolean
  material: MaterialSpec
  intensity?: number
  distance?: number
  fov?: number
  activeCamera?: boolean
}

/** 一次可恢复的场景状态：对象、父子关系、世界变换都在快照里 */
export interface SceneSnapshot {
  name: string
  objects: SceneObject[]
  selectedId: string | null
}

export interface HistoryEntry {
  t: number
  label: string
  /** 连续相同键的提交会合并为一次撤销（检查器拖拽滑杆、连续输入） */
  coalesceKey?: string
  snapshot: SceneSnapshot
}

export interface HistoryData {
  t: number
  past: HistoryEntry[]
  future: HistoryEntry[]
}

export interface SceneDocument {
  version: typeof SCENE_VERSION
  name: string
  objects: SceneObject[]
  selectedId: string | null
  savedAt: string
  /** 历史随场景一起持久化，重开后可继续撤销重做 */
  history?: HistoryData
}

export interface PerformanceSettings {
  instanceMode: boolean
  shadows: boolean
  showGrid: boolean
  pixelRatio: number
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
