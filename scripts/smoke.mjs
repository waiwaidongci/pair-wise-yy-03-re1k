// Runtime smoke test for the recoverable-transaction store.
// Runs in Node with a localStorage shim.
import assert from 'node:assert'

// --- localStorage shim ---
const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => { memory.set(key, String(value)) },
  removeItem: (key) => { memory.delete(key) },
  clear: () => { memory.clear() },
}

const { useEditorStore } = await import('../src/stores/editor.ts')
const { migrateDocument, sanitizeRelations, loadFromStorage } = await import('../src/utils/persistence.ts')

const get = () => useEditorStore.getState()
let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// ---------- basic add + undo/redo ----------
test('add is one transaction; undo/redo restores', () => {
  const before = get().objects.length
  const pastBefore = get().past.length
  get().add('box')
  assert.equal(get().objects.length, before + 1, 'add increases object count')
  assert.equal(get().past.length, pastBefore + 1, 'add is one transaction')
  const addedId = get().selectedId
  get().undo()
  assert.equal(get().objects.length, before, 'undo removes added object')
  assert.equal(get().past.length, pastBefore, 'undo pops past')
  assert.equal(get().future.length, 1, 'undo pushes to future')
  assert.ok(!get().objects.some((o) => o.id === addedId), 'added object gone after undo')
  get().redo()
  assert.equal(get().objects.length, before + 1, 'redo restores object')
  assert.ok(get().objects.some((o) => o.id === addedId), 'object back after redo')
  assert.equal(get().future.length, 0, 'redo clears future')
})

// ---------- new edit invalidates redo ----------
test('new edit clears redo stack', () => {
  get().undo()
  assert.ok(get().future.length > 0, 'precondition: future non-empty')
  get().add('sphere')
  assert.equal(get().future.length, 0, 'new edit clears redo stack')
})

// ---------- reparent + undo restores parent-child ----------
test('reparent is one transaction; undo restores parent link', () => {
  const root = get().objects.find((o) => !o.parentId)
  const child = get().objects.find((o) => o.parentId === null && o.id !== root.id)
  assert.ok(root && child, 'need two root objects')
  const pastBefore = get().past.length
  get().reparent(child.id, root.id)
  assert.equal(get().objects.find((o) => o.id === child.id).parentId, root.id, 'reparent sets parent')
  assert.equal(get().past.length, pastBefore + 1, 'reparent is one transaction')
  get().undo()
  assert.equal(get().objects.find((o) => o.id === child.id).parentId, null, 'undo restores root parent')
})

// ---------- batch add counts as one transaction ----------
test('batch add counts as one transaction', () => {
  const before = get().objects.length
  const pastBefore = get().past.length
  get().addStressObjects(12)
  assert.equal(get().objects.length, before + 12, 'batch adds 12')
  assert.equal(get().past.length, pastBefore + 1, 'batch add is ONE transaction')
  get().undo()
  assert.equal(get().objects.length, before, 'undo removes whole batch')
})

// ---------- drag (setTransform) restores world transform ----------
test('drag restores position/rotation/scale', () => {
  const obj = get().objects[0]
  const before = { ...obj }
  get().setTransform(obj.id, { position: [9, 8, 7], rotation: [1, 2, 3], scale: [2, 2, 2] })
  get().undo()
  const restored = get().objects.find((o) => o.id === obj.id)
  assert.deepEqual(restored.position, before.position, 'position restored')
  assert.deepEqual(restored.rotation, before.rotation, 'rotation restored')
  assert.deepEqual(restored.scale, before.scale, 'scale restored')
})

// ---------- reset is undoable ----------
test('reset is undoable', () => {
  const before = get().objects.length
  get().reset()
  assert.equal(get().objects.length, 5, 'reset restores starter scene')
  get().undo()
  assert.equal(get().objects.length, before, 'undo restores pre-reset scene')
})

// ---------- persistence round-trip ----------
test('persist writes scene + history to localStorage', () => {
  memory.clear()
  const result = get().persistNow({ force: true })
  assert.equal(result.ok, true, 'persist succeeds')
  const raw = memory.get('scene-forge:v1')
  assert.ok(raw, 'localStorage written')
  const parsed = JSON.parse(raw)
  assert.ok(Array.isArray(parsed.history.past), 'history persisted')
  assert.ok(parsed.history.past.length > 0, 'past history non-empty')
})

// ---------- rehydration: history survives a refresh ----------
test('persisted state rehydrates with history intact', async () => {
  memory.clear()
  get().add('torus')
  get().add('camera')
  get().persistNow({ force: true })
  // Simulate a fresh page load: read the persisted state back.
  const loaded = loadFromStorage()
  assert.ok(loaded, 'loadFromStorage returns state')
  assert.ok(loaded.history.past.length >= 2, 'history restored from storage')
  assert.ok(loaded.document.objects.some((o) => o.type === 'torus'), 'scene restored')
  // The restored history entries are valid snapshots that can drive undo.
  const before = loaded.document.objects.length
  const last = loaded.history.past[loaded.history.past.length - 1]
  assert.ok(Array.isArray(last.objects), 'past entry has objects')
  assert.ok(typeof last.name === 'string', 'past entry has name')
  // Apply the last past entry (one undo step) -> object count drops by the last add.
  const restored = last.objects.length
  assert.ok(restored < before, 'undo snapshot reduces object count')
})

// ---------- save failure rolls back and offers retry ----------
test('save failure restores scene and sets retryable error', () => {
  // Ensure a known-good baseline is persisted.
  memory.clear()
  get().persistNow({ force: true })
  const goodCount = get().objects.length
  const goodPast = get().past.length
  // Make an edit that has NOT been persisted.
  get().add('cone')
  assert.equal(get().objects.length, goodCount + 1, 'edit in memory')
  assert.equal(get().past.length, goodPast + 1, 'edit advanced history')
  // Force localStorage.setItem to fail (quota exceeded).
  const storage = globalThis.localStorage
  const originalSet = storage.setItem
  storage.setItem = () => { throw new Error('QuotaExceededError') }
  const result = get().persistNow({ force: true })
  storage.setItem = originalSet
  assert.equal(result.ok, false, 'persist reports failure')
  assert.ok(get().saveError, 'saveError set for retry UI')
  assert.equal(get().objects.length, goodCount, 'scene rolled back to last good')
  assert.equal(get().past.length, goodPast, 'history rolled back in lockstep')
  // Retry succeeds once storage is healthy.
  const retry = get().persistNow({ force: true })
  assert.equal(retry.ok, true, 'retry succeeds')
  assert.equal(get().saveError, null, 'saveError cleared')
})

// ---------- migration: missing version + bad relations ----------
test('migration adds version and quarantines bad relations', () => {
  const legacy = {
    name: '旧场景',
    objects: [
      { id: 'a', name: 'A', type: 'box', parentId: 'missing-parent', position: [1, 2, 3] },
      { id: 'b', name: 'B', type: 'sphere', parentId: 'b' },
      { id: 'c', name: 'C', type: 'cylinder', parentId: 'd' },
      { id: 'd', name: 'D', type: 'cone', parentId: 'c' },
      { id: 'e', name: 'E' },
    ],
  }
  const { document, quarantined } = migrateDocument(legacy)
  assert.equal(document.version, 1, 'version migrated to 1')
  assert.ok(quarantined >= 3, `quarantined bad relations (got ${quarantined})`)
  const byId = Object.fromEntries(document.objects.map((o) => [o.id, o]))
  assert.equal(byId.a.parentId, null, 'missing parent detached')
  assert.equal(byId.b.parentId, null, 'self parent detached')
  assert.equal(byId.c.parentId, null, 'cycle broken')
  assert.equal(byId.e.type, 'box', 'missing type defaults to box')
  assert.deepEqual(byId.a.position, [1, 2, 3], 'valid position kept')
})

// ---------- sanitizeRelations direct ----------
test('sanitizeRelations breaks cycles', () => {
  const base = { name: 'x', visible: true, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], castShadow: true, receiveShadow: true, material: { color: '#fff', roughness: 0.5, metalness: 0, opacity: 1, wireframe: false } }
  const objs = [
    { ...base, id: 'x', type: 'box', parentId: 'y' },
    { ...base, id: 'y', type: 'box', parentId: 'x' },
  ]
  const { objects, quarantined } = sanitizeRelations(objs)
  assert.ok(quarantined >= 1, 'cycle quarantined')
  const ids = Object.fromEntries(objects.map((o) => [o.id, o]))
  assert.ok(ids.x.parentId === null || ids.y.parentId === null, 'cycle broken')
})

console.log(`\n${passed} checks passed`)
