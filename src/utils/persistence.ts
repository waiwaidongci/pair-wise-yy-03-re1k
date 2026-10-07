import type { ObjectType, SceneDocument, SceneObject, Vec3 } from '../types/scene'
import type { HistoryState, PersistedState, SceneSnapshot } from '../types/history'
import { createSceneObject, uid } from './scene'

const STORAGE_KEY = 'scene-forge:v1'
export const MAX_HISTORY = 60

const VALID_TYPES: ReadonlySet<string> = new Set([
  'box', 'sphere', 'cylinder', 'cone', 'torus', 'plane',
  'directionalLight', 'pointLight', 'spotLight', 'camera',
])

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')
}

function normalizeObject(raw: unknown): SceneObject {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const type: ObjectType = VALID_TYPES.has(source.type as string) ? (source.type as ObjectType) : 'box'
  const base = createSceneObject(type)
  const materialSource = (source.material && typeof source.material === 'object')
    ? source.material as Record<string, unknown>
    : {}
  const material = {
    ...base.material,
    ...Object.fromEntries(Object.entries(materialSource).filter(([, value]) => value !== undefined)),
  }
  return {
    ...base,
    id: typeof source.id === 'string' && source.id ? source.id : uid('obj'),
    name: typeof source.name === 'string' && source.name ? source.name : base.name,
    type,
    parentId: typeof source.parentId === 'string' ? source.parentId : null,
    visible: typeof source.visible === 'boolean' ? source.visible : true,
    position: isVec3(source.position) ? source.position : base.position,
    rotation: isVec3(source.rotation) ? source.rotation : base.rotation,
    scale: isVec3(source.scale) ? source.scale : base.scale,
    castShadow: typeof source.castShadow === 'boolean' ? source.castShadow : base.castShadow,
    receiveShadow: typeof source.receiveShadow === 'boolean' ? source.receiveShadow : base.receiveShadow,
    material,
    intensity: typeof source.intensity === 'number' ? source.intensity : base.intensity,
    distance: typeof source.distance === 'number' ? source.distance : base.distance,
    fov: typeof source.fov === 'number' ? source.fov : base.fov,
    activeCamera: typeof source.activeCamera === 'boolean' ? source.activeCamera : base.activeCamera,
  }
}

/**
 * Quarantine invalid parent-child relationships:
 *  - parent points to a missing object,
 *  - parent is the object itself,
 *  - parent chain contains a cycle.
 * Bad links are detached to the scene root instead of crashing the editor.
 */
export function sanitizeRelations(objects: SceneObject[]): { objects: SceneObject[]; quarantined: number } {
  const byId = new Map<string, SceneObject>()
  objects.forEach((object) => byId.set(object.id, { ...object }))
  let quarantined = 0

  for (const object of byId.values()) {
    if (object.parentId && (!byId.has(object.parentId) || object.parentId === object.id)) {
      object.parentId = null
      quarantined += 1
    }
  }

  for (const start of byId.values()) {
    const seen = new Set<string>()
    let current: SceneObject | undefined = start
    while (current) {
      if (seen.has(current.id)) {
        current.parentId = null
        quarantined += 1
        break
      }
      seen.add(current.id)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
  }

  return { objects: [...byId.values()], quarantined }
}

export interface MigratedDocument {
  document: SceneDocument
  quarantined: number
}

/**
 * Migrate a raw document (possibly from an older version or hand-edited JSON)
 * to the current schema, then quarantine any broken relationships.
 */
export function migrateDocument(raw: unknown): MigratedDocument {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawObjects = Array.isArray(source.objects) ? source.objects : []
  const normalized = rawObjects.map(normalizeObject)
  const { objects, quarantined } = sanitizeRelations(normalized)
  const document: SceneDocument = {
    version: 1,
    name: typeof source.name === 'string' && source.name ? source.name : '未命名场景',
    objects,
    savedAt: typeof source.savedAt === 'string' ? source.savedAt : new Date().toISOString(),
  }
  return { document, quarantined }
}

export function snapshotOf(state: { name: string; objects: SceneObject[]; selectedId: string | null }): SceneSnapshot {
  return structuredClone({ name: state.name, objects: state.objects, selectedId: state.selectedId })
}

function capHistory(history: HistoryState): HistoryState {
  return {
    past: history.past.slice(-MAX_HISTORY),
    future: history.future.slice(-MAX_HISTORY),
  }
}

export function buildPersistedState(
  scene: { name: string; objects: SceneObject[] },
  history: HistoryState,
): PersistedState {
  return {
    version: 1,
    scene: { version: 1, name: scene.name, objects: scene.objects, savedAt: new Date().toISOString() },
    history: capHistory(history),
    savedAt: new Date().toISOString(),
  }
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/** Persist to localStorage. Atomic: either the whole document lands or nothing does. */
export function saveToStorage(data: PersistedState): SaveResult {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface LoadedState {
  document: SceneDocument
  history: HistoryState
  quarantined: number
}

/** Read, migrate and sanitize the persisted state. Returns null when nothing usable is stored. */
export function loadFromStorage(): LoadedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    const { document, quarantined } = migrateDocument(parsed.scene ?? parsed)
    const history: HistoryState = { past: [], future: [] }
    if (parsed.history && Array.isArray(parsed.history.past) && Array.isArray(parsed.history.future)) {
      for (const entry of [...parsed.history.past, ...parsed.history.future]) {
        if (!entry || !Array.isArray(entry.objects)) continue
        const { objects } = sanitizeRelations(entry.objects)
        const snapshot: SceneSnapshot = {
          name: typeof entry.name === 'string' ? entry.name : document.name,
          objects,
          selectedId: typeof entry.selectedId === 'string' ? entry.selectedId : null,
        }
        if (parsed.history.past.includes(entry)) history.past.push(snapshot)
        else history.future.push(snapshot)
      }
    }
    return { document, history: capHistory(history), quarantined }
  } catch {
    return null
  }
}

export function clearStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
