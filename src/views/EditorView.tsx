import {
  AppBar,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Slider,
  Snackbar,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  OpenWithOutlined,
  RedoOutlined,
  RotateRightOutlined,
  SaveOutlined,
  ScaleOutlined,
  SpeedOutlined,
  UndoOutlined,
} from '@mui/icons-material'
import { useEffect } from 'react'
import HierarchyPanel from '../components/HierarchyPanel'
import InspectorPanel from '../components/InspectorPanel'
import SceneViewport from '../components/SceneViewport'
import { useEditorStore } from '../stores/editor'
import { SCENE_VERSION } from '../types/scene'
import type { SceneDocument, TransformMode } from '../types/scene'

export default function EditorView() {
  const store = useEditorStore()
  const selectedObject = store.objects.find((item) => item.id === store.selectedId)
  const canUndo = store.past.length > 0
  const canRedo = store.future.length > 0
  const undoLabel = store.past[store.past.length - 1]?.label

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.matches('input, textarea')) return
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) useEditorStore.getState().redo()
        else useEditorStore.getState().undo()
        return
      }
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        useEditorStore.getState().redo()
        return
      }
      if (event.key.toLowerCase() === 'g') store.setTransformMode('translate')
      if (event.key.toLowerCase() === 'r') store.setTransformMode('rotate')
      if (event.key.toLowerCase() === 's' && !meta) store.setTransformMode('scale')
      if ((event.key === 'Delete' || event.key === 'Backspace') && store.selectedId) store.remove(store.selectedId)
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault()
        store.saveScene()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  function buildExportDocument(): SceneDocument {
    return {
      version: SCENE_VERSION,
      name: store.name,
      objects: store.objects,
      selectedId: store.selectedId,
      savedAt: new Date().toISOString(),
      history: {
        t: Date.now(),
        past: store.past,
        future: store.future,
      },
    }
  }

  function exportScene() {
    const document = buildExportDocument()
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `${store.name}.scene.json`
    anchor.click()
    URL.revokeObjectURL(url)
    store.noticeMessage('场景 JSON 已导出')
  }

  async function importScene(file: File) {
    try {
      const raw = JSON.parse(await file.text())
      store.importScene(raw)
    } catch (error) {
      store.noticeMessage(error instanceof Error ? error.message : '场景文件无效，当前场景未改动')
    }
  }

  function handleReset() {
    if (window.confirm('重置为示例场景？该操作本身也可以撤销，不会丢失当前编辑。')) {
      store.reset()
    }
  }

  const modes: Array<{ value: TransformMode; label: string; icon: React.ReactNode }> = [
    { value: 'translate', label: '移动', icon: <OpenWithOutlined /> },
    { value: 'rotate', label: '旋转', icon: <RotateRightOutlined /> },
    { value: 'scale', label: '缩放', icon: <ScaleOutlined /> },
  ]

  const saveText = store.saveStatus === 'saving'
    ? '保存中…'
    : store.saveStatus === 'saved'
      ? `已存本机${store.lastSavedAt ? ` · ${new Date(store.lastSavedAt).toLocaleTimeString()}` : ''}`
      : store.saveStatus === 'error'
        ? '保存失败'
        : '未保存'

  return (
    <Box className="app-shell">
      <AppBar position="static" color="inherit" elevation={0} className="topbar">
        <Toolbar variant="dense" sx={{ gap: 1.5 }}>
          <Box className="brand-mark">SF</Box>
          <Box sx={{ minWidth: 170 }}>
            <Typography variant="subtitle1" fontWeight={800}>SceneForge</Typography>
            <Typography variant="caption" color="text.secondary">三维场景编辑器</Typography>
          </Box>
          <Button variant="outlined" size="small" onClick={() => store.setPerformance({ instanceMode: !store.performance.instanceMode })}>
            {store.performance.instanceMode ? '实例模式：开' : '实例模式：关'}
          </Button>
          <Button variant="outlined" size="small" startIcon={<SpeedOutlined />} onClick={() => store.addStressObjects(240)}>添加 240 个物体</Button>
          <Stack direction="row" spacing={0.5}>
            {modes.map((mode) => (
              <Tooltip key={mode.value} title={mode.label}>
                <Button
                  size="small"
                  variant={store.transformMode === mode.value ? 'contained' : 'outlined'}
                  startIcon={mode.icon}
                  onClick={() => store.setTransformMode(mode.value)}
                >
                  {mode.label}
                </Button>
              </Tooltip>
            ))}
          </Stack>
          <FormControlLabel
            control={<Checkbox size="small" checked={store.snapEnabled} onChange={(event) => store.setSnapEnabled(event.target.checked)} />}
            label="吸附"
          />
          <Box sx={{ width: 110 }}>
            <Typography variant="caption">步长 {store.snapSize}</Typography>
            <Slider size="small" min={0.1} max={1} step={0.05} value={store.snapSize} onChange={(_, value) => store.setSnapSize(value as number)} />
          </Box>
          <Box sx={{ flex: 1 }} />
          <Tooltip title={canUndo ? `撤销：${undoLabel}（Ctrl+Z）` : '没有可撤销的操作'}>
            <span>
              <Button size="small" startIcon={<UndoOutlined />} disabled={!canUndo} onClick={store.undo}>撤销</Button>
            </span>
          </Tooltip>
          <Tooltip title={canRedo ? '重做（Ctrl+Shift+Z）' : '没有可重做的操作'}>
            <span>
              <Button size="small" startIcon={<RedoOutlined />} disabled={!canRedo} onClick={store.redo}>重做</Button>
            </span>
          </Tooltip>
          <Button size="small" onClick={handleReset}>重置</Button>
          <Button size="small" component="label" startIcon={<CloudUploadOutlined />}>
            导入
            <input hidden type="file" accept=".json" onChange={(event) => event.target.files?.[0] && importScene(event.target.files[0])} />
          </Button>
          <Button size="small" startIcon={<CloudDownloadOutlined />} onClick={exportScene}>导出</Button>
          <Button size="small" variant="contained" startIcon={<SaveOutlined />} onClick={store.saveScene}>保存场景</Button>
        </Toolbar>
      </AppBar>
      <main className="editor-grid">
        <HierarchyPanel />
        <SceneViewport />
        <InspectorPanel />
      </main>
      <div className="statusbar">
        <span>{selectedObject ? `已选择：${selectedObject.name}` : '未选择对象'}</span>
        <span>对象 {store.objects.length} · 位置 {selectedObject?.position.map((item) => item.toFixed(2)).join(' / ') ?? '--'}</span>
        <span>{store.performance.instanceMode ? 'InstancedMesh 批量渲染' : '独立对象渲染'}</span>
        <span>历史 {store.past.length} 步可撤销 / {store.future.length} 步可重做</span>
        <span title={store.saveError ?? undefined}>
          {saveText}
          {store.saveStatus === 'error' && (
            <Button size="small" color="error" onClick={store.saveScene} sx={{ ml: 0.5, minWidth: 0, py: 0 }}>重试保存</Button>
          )}
        </span>
      </div>
      <Snackbar open={Boolean(store.notice)} autoHideDuration={2600} onClose={() => store.noticeMessage('')} message={store.notice} />
    </Box>
  )
}
