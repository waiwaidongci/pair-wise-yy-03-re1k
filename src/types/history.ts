import type { SceneDocument, SceneObject } from './scene'

/**
 * A point-in-time capture of the editable scene state.
 * Restoring a snapshot brings back objects, parent-child relationships,
 * local transforms (and therefore world transforms) and selection.
 */
export interface SceneSnapshot {
  name: string
  objects: SceneObject[]
  selectedId: string | null
}

/** Undo/redo stacks. `past` holds snapshots taken before each committed transaction. */
export interface HistoryState {
  past: SceneSnapshot[]
  future: SceneSnapshot[]
}

/** Envelope persisted to localStorage so a session (including history) can resume. */
export interface PersistedState {
  version: 1
  scene: SceneDocument
  history: HistoryState
  savedAt: string
}

export const HISTORY_VERSION = 1
