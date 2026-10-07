import * as THREE from 'three'
import { SCENE_VERSION } from '../types/scene'
import type {
  HistoryData,
  HistoryEntry,
  ObjectType,
  SceneDocument,
  SceneObject,
  SceneSnapshot,
  Vec3,
} from '../types/scene'

export const GEOMETRY_TYPES: ObjectType[] = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane']
export const LIGHT_TYPES: ObjectType[] = ['directionalLight', 'pointLight', 'spotLight']
const KNOWN_TYPES: ObjectType[] = [...GEOMETRY_TYPES, ...LIGHT_TYPES, 'camera']

export const TYPE_LABELS: Record<ObjectType, string> = {
  box: '立方体',
  sphere: '球体',
  cylinder: '圆柱体',
  cone: '圆锥体',
  torus: '圆环',
  plane: '平面',
  directionalLight: '平行光',
  pointLight: '点光源',
  spotLight: '聚光灯',
  camera: '透视相机',
}

export const TYPE_COLORS: Record<ObjectType, string> = {
  box: '#3b82f6',
  sphere: '#14b8a6',
  cylinder: '#f59e0b',
  cone: '#ef4444',
  torus: '#8b5cf6',
  plane: '#64748b',
  directionalLight: '#fbbf24',
  pointLight: '#f97316',
  spotLight: '#fb7185',
  camera: '#0ea5e9',
}

export function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export function createSceneObject(type: ObjectType, parentId: string | null = null): SceneObject {
  const base: SceneObject = {
    id: uid(type),
    name: TYPE_LABELS[type],
    type,
    parentId,
    visible: true,
    position: [0, type === 'plane' ? 0 : 0.8, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    castShadow: !['plane', 'directionalLight', 'pointLight', 'spotLight', 'camera'].includes(type),
    receiveShadow: true,
    material: {
      color: TYPE_COLORS[type],
      roughness: 0.45,
      metalness: 0.05,
      opacity: 1,
      wireframe: false,
    },
  }
  if (type === 'plane') {
    base.scale = [4, 4, 4]
    base.rotation = [-Math.PI / 2, 0, 0]
  }
  if (type === 'directionalLight') {
    base.position = [4, 6, 3]
    base.intensity = 1.8
    base.material.color = '#fff4d6'
  }
  if (type === 'pointLight') {
    base.position = [1, 3, 1]
    base.intensity = 2
    base.distance = 12
    base.material.color = '#ffd7a8'
  }
  if (type === 'spotLight') {
    base.position = [3, 5, 3]
    base.intensity = 3
    base.distance = 15
    base.material.color = '#ffffff'
  }
  if (type === 'camera') {
    base.position = [5, 4, 7]
    base.fov = 52
    base.activeCamera = false
  }
  return base
}

export function createStarterScene(): SceneObject[] {
  const ground = createSceneObject('plane')
  ground.id = 'ground'
  ground.name = '主地面'
  ground.material.color = '#9aa7b8'

  const hero = createSceneObject('box')
  hero.id = 'hero-box'
  hero.name = '核心展台'
  hero.position = [0, 0.75, 0]
  hero.scale = [1.5, 1.5, 1.5]
  hero.material.color = '#2563eb'
  hero.castShadow = true

  const sphere = createSceneObject('sphere')
  sphere.id = 'hero-sphere'
  sphere.name = '悬浮球体'
  sphere.position = [2.3, 1.25, 0]
  sphere.material.color = '#14b8a6'

  const ring = createSceneObject('torus')
  ring.id = 'hero-ring'
  ring.name = '装饰圆环'
  ring.position = [-2.2, 1.4, 0]
  ring.rotation = [Math.PI / 2, 0, 0]
  ring.material.color = '#f59e0b'

  const sun = createSceneObject('directionalLight')
  sun.id = 'sun-light'
  sun.name = '主平行光'

  return [ground, hero, sphere, ring, sun]
}

export function isGeometry(type: ObjectType) {
  return GEOMETRY_TYPES.includes(type)
}

// ---------------------------------------------------------------------------
// 数据迁移与坏关系隔离
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  objects: SceneObject[]
  issues: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

function asString(value: unknown, fallback: string) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function asVec3(value: unknown, fallback: Vec3): Vec3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return [value[0], value[1], value[2]]
  }
  return [...fallback]
}

/** 旧数据 / 坏数据里的单个对象：字段缺失用默认值补齐，无法识别的对象整体隔离 */
function normalizeObject(raw: unknown, index: number, issues: string[]): { object: SceneObject; rawParentId: unknown } | null {
  if (!isRecord(raw)) {
    issues.push(`第 ${index + 1} 个对象不是有效记录，已隔离`)
    return null
  }
  if (!KNOWN_TYPES.includes(raw.type as ObjectType)) {
    issues.push(`对象 “${asString(raw.name, `#${index + 1}`)}” 的类型无法识别，已隔离`)
    return null
  }
  const type = raw.type as ObjectType
  const fallback = createSceneObject(type)
  const rawMaterial = isRecord(raw.material) ? raw.material : {}
  const color = asString(rawMaterial.color, fallback.material.color)
  const object: SceneObject = {
    ...fallback,
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : uid(type),
    name: asString(raw.name, fallback.name),
    parentId: null,
    visible: asBoolean(raw.visible, fallback.visible),
    position: asVec3(raw.position, fallback.position),
    rotation: asVec3(raw.rotation, fallback.rotation),
    scale: asVec3(raw.scale, fallback.scale),
    castShadow: asBoolean(raw.castShadow, fallback.castShadow),
    receiveShadow: asBoolean(raw.receiveShadow, fallback.receiveShadow),
    material: {
      color: /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : fallback.material.color,
      roughness: THREE.MathUtils.clamp(asNumber(rawMaterial.roughness, fallback.material.roughness), 0, 1),
      metalness: THREE.MathUtils.clamp(asNumber(rawMaterial.metalness, fallback.material.metalness), 0, 1),
      opacity: THREE.MathUtils.clamp(asNumber(rawMaterial.opacity, fallback.material.opacity), 0, 1),
      wireframe: asBoolean(rawMaterial.wireframe, fallback.material.wireframe),
    },
  }
  if (typeof raw.intensity === 'number') object.intensity = raw.intensity
  if (typeof raw.distance === 'number') object.distance = raw.distance
  if (typeof raw.fov === 'number') object.fov = raw.fov
  if (typeof raw.activeCamera === 'boolean') object.activeCamera = raw.activeCamera
  return { object, rawParentId: raw.parentId }
}

/**
 * 规整一份对象列表：
 * - 补 id、补默认字段、隔离无法识别的记录
 * - 重复 id 重新分配
 * - 指向不存在父级的关系断开到根节点
 * - 父子成环时沿链断开成环的那条边
 * 所有修复动作都会汇总成 issues，供界面提示，且不丢任何可识别对象。
 */
export function sanitizeObjects(input: unknown): SanitizeResult {
  const issues: string[] = []
  const list = Array.isArray(input) ? input : []
  if (!Array.isArray(input)) issues.push('objects 不是数组，已重建为空场景')

  const objects: SceneObject[] = []
  const rawParentIds = new Map<string, unknown>()
  const seen = new Set<string>()
  list.forEach((raw, index) => {
    const normalized = normalizeObject(raw, index, issues)
    if (!normalized) return
    const { object } = normalized
    if (seen.has(object.id)) {
      issues.push(`对象 “${object.name}” 的 id 重复，已重新分配`)
      object.id = uid(object.type)
    }
    seen.add(object.id)
    rawParentIds.set(object.id, normalized.rawParentId)
    objects.push(object)
  })

  const byId = new Map(objects.map((object) => [object.id, object]))

  // 先建立 parentId（悬空或指向自身的断到根）
  objects.forEach((object) => {
    const parentId = rawParentIds.get(object.id)
    if (parentId === null || parentId === undefined) {
      object.parentId = null
    } else if (typeof parentId === 'string' && parentId !== object.id && byId.has(parentId)) {
      object.parentId = parentId
    } else {
      object.parentId = null
      issues.push(`对象 “${object.name}” 的父级无效，已移动到场景根节点`)
    }
  })

  // 再检测父子环：沿父链走，重复访问说明成环，断开第二次访问的节点的 parentId
  objects.forEach((object) => {
    const chain = new Set<string>()
    let current: SceneObject | undefined = object
    while (current && current.parentId) {
      if (chain.has(current.id)) {
        const name = current.name
        const parent = byId.get(current.parentId)
        current.parentId = null
        issues.push(`检测到 “${name}” 与其父级${parent ? ` “${parent.name}”` : ''}构成循环，已移动到场景根节点`)
        break
      }
      chain.add(current.id)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
  })

  return { objects, issues }
}

/** 缺版本号的旧数据按 v1 迁移；已是最新版本则只做规整 */
export function migrateDocument(raw: unknown): { document: SceneDocument; issues: string[] } {
  if (!isRecord(raw)) throw new Error('场景文件不是有效的 JSON 对象')
  const version = typeof raw.version === 'number' ? raw.version : 1
  if (version !== 1 && version !== SCENE_VERSION) {
    throw new Error(`不支持的场景版本：v${version}`)
  }

  const { objects, issues } = sanitizeObjects(raw.objects)
  if (version < SCENE_VERSION) issues.unshift(`已将 v${version} 场景迁移到 v${SCENE_VERSION}`)

  const document: SceneDocument = {
    version: SCENE_VERSION,
    name: asString(raw.name, '未命名场景'),
    objects,
    selectedId: typeof raw.selectedId === 'string' && objects.some((item) => item.id === raw.selectedId)
      ? raw.selectedId
      : objects[0]?.id ?? null,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date(0).toISOString(),
  }
  if (version === SCENE_VERSION && isRecord(raw.history)) {
    const history = sanitizeHistory(raw.history)
    if (history) document.history = history
  }
  return { document, issues }
}

function normalizeSnapshot(raw: unknown): SceneSnapshot | null {
  if (!isRecord(raw)) return null
  const { objects } = sanitizeObjects(raw.objects)
  return {
    name: asString(raw.name, '未命名场景'),
    objects,
    selectedId: typeof raw.selectedId === 'string' && objects.some((item) => item.id === raw.selectedId) ? raw.selectedId : null,
  }
}

/** 历史条目来自本机存储，任何一条损坏只丢该条，不影响其余历史 */
export function sanitizeHistory(raw: unknown): HistoryData | null {
  if (!isRecord(raw) || !Array.isArray(raw.past) || !Array.isArray(raw.future)) return null
  const toEntry = (item: unknown): HistoryEntry | null => {
    if (!isRecord(item) || !isRecord(item.snapshot)) return null
    const snapshot = normalizeSnapshot(item.snapshot)
    if (!snapshot) return null
    return {
      t: asNumber(item.t, Date.now()),
      label: asString(item.label, '编辑'),
      ...(typeof item.coalesceKey === 'string' ? { coalesceKey: item.coalesceKey } : {}),
      snapshot,
    }
  }
  const past = raw.past.map(toEntry).filter((item): item is HistoryEntry => item !== null)
  const future = raw.future.map(toEntry).filter((item): item is HistoryEntry => item !== null)
  return { t: asNumber(raw.t, Date.now()), past, future }
}

// ---------------------------------------------------------------------------
// 矩阵与层级
// ---------------------------------------------------------------------------

export function localMatrix(object: SceneObject, target = new THREE.Matrix4()) {
  const position = new THREE.Vector3(...object.position)
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(...object.rotation))
  const scale = new THREE.Vector3(...object.scale)
  return target.compose(position, quaternion, scale)
}

export function worldMatrix(
  id: string,
  objects: SceneObject[],
  cache = new Map<string, THREE.Matrix4>(),
): THREE.Matrix4 {
  const cached = cache.get(id)
  if (cached) return cached
  const object = objects.find((item) => item.id === id)
  if (!object) return new THREE.Matrix4()
  const parent = object.parentId ? worldMatrix(object.parentId, objects, cache) : new THREE.Matrix4()
  const result = parent.clone().multiply(localMatrix(object))
  cache.set(id, result)
  return result
}

/** 保持世界变换不变，把对象挂到新父级下（重算本地 TRS）。直接修改传入数组。 */
export function reparentPreserveWorld(objects: SceneObject[], id: string, nextParentId: string | null) {
  const object = objects.find((item) => item.id === id)
  if (!object || object.parentId === nextParentId) return
  const cache = new Map<string, THREE.Matrix4>()
  const world = worldMatrix(id, objects, cache).clone()
  object.parentId = nextParentId
  cache.delete(id)
  descendantsOf(id, objects).forEach((childId) => cache.delete(childId))
  const parentWorld = nextParentId ? worldMatrix(nextParentId, objects, cache) : new THREE.Matrix4()
  const local = parentWorld.clone().invert().multiply(world)
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  local.decompose(position, quaternion, scale)
  const rotation = new THREE.Euler().setFromQuaternion(quaternion)
  object.position = [position.x, position.y, position.z]
  object.rotation = [rotation.x, rotation.y, rotation.z]
  object.scale = [scale.x, scale.y, scale.z]
}

export function descendantsOf(id: string, objects: SceneObject[]) {
  const result = new Set<string>()
  const visit = (parentId: string) => {
    objects.filter((item) => item.parentId === parentId).forEach((item) => {
      result.add(item.id)
      visit(item.id)
    })
  }
  visit(id)
  return result
}

export function clonePosition(position: Vec3): Vec3 {
  return [position[0], position[1], position[2]]
}
