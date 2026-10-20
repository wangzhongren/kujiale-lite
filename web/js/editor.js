import { Canvas2D } from './canvas2d.js';
import { createCatalogPanel, findFurniture } from './catalog.js';
import { wallLength } from './geometry.js';
import {
  createEmptyDoc,
  createStore,
  normalizePlanPayload,
  validatePlanName,
} from './store.js';
import {
  announce,
  confirmDialog,
  downloadBlob,
  el,
  errorMeta,
  errorText,
  field,
  formatCount,
  formatDateTime,
  kbd,
  renderError,
  renderLoading,
  setButtonBusy,
  showDialog,
  showToast,
} from './ui.js';

const TOOL_DEFS = [
  { id: 'select', label: '选择', key: 'V' },
  { id: 'wall', label: '墙', key: 'W' },
  { id: 'door', label: '门', key: 'D' },
  { id: 'window', label: '窗', key: 'N' },
];

function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function formatNumber(value) {
  const rounded = Math.round(Number(value) * 10) / 10;
  return String(Number.isFinite(rounded) ? rounded : 0);
}

function safeFilename(name) {
  const value = String(name || 'plan').trim() || 'plan';
  return value.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
}

function buildShareUrl(token) {
  const url = new URL(window.location.href);
  url.hash = `#/s/${encodeURIComponent(token)}`;
  url.search = '';
  return url.toString();
}

function normalizeShareResponse(payload) {
  if (!payload || typeof payload !== 'object') return { token: null, url: null };
  const share = payload.share && typeof payload.share === 'object' ? payload.share : null;
  const rawToken = payload.token ?? payload.shareToken ?? share?.token ?? share?.shareToken ?? null;
  const token = rawToken === null || rawToken === undefined ? null : String(rawToken);
  const rawUrl = payload.url ?? payload.shareUrl ?? share?.url ?? null;
  const url = rawUrl ? String(rawUrl) : (token ? buildShareUrl(token) : null);
  return { token, url };
}

/**
 * 编辑器视图：2D/3D 同源渲染同一份 store 文档；所有写操作经 store 命令栈。
 * 返回 { dispose, isDirty, confirmDiscard, store } 供路由层做脏检查。
 */
export async function createEditorView({
  mount,
  api,
  planId,
  catalog: initialCatalog = null,
  catalogProvider = null,
}) {
  if (!mount) throw new TypeError('缺少挂载点');
  const id = String(planId);
  renderLoading(mount, '正在打开方案…');

  let payload;
  try {
    payload = await api.getPlan(id);
  } catch (error) {
    const missing = error?.status === 404 || error?.code === 'NOT_FOUND';
    renderError(mount, {
      title: missing ? '方案不存在' : '方案加载失败',
      message: missing
        ? '方案不存在，或当前账号无权访问。'
        : errorText(error),
      error,
      onRetry: missing ? null : () => window.location.reload(),
      retryLabel: '重试打开',
      extraActions: [el('a', {
        class: 'button button-secondary',
        href: '#/',
        text: '返回方案列表',
      })],
    });
    return {
      dispose() {},
      isDirty: () => false,
      confirmDiscard: async () => true,
      store: null,
    };
  }

  const normalized = normalizePlanPayload(payload);
  if (!normalized) {
    renderError(mount, {
      title: '方案数据不完整',
      message: '服务端未返回可用的方案文档。',
      error: { code: 'VALIDATION_FAILED', requestId: null },
      onRetry: () => window.location.reload(),
      extraActions: [el('a', { class: 'button button-secondary', href: '#/', text: '返回方案列表' })],
    });
    return {
      dispose() {},
      isDirty: () => false,
      confirmDiscard: async () => true,
      store: null,
    };
  }

  const doc = normalized.doc || createEmptyDoc();
  if (doc.schemaVersion > 1) {
    renderError(mount, {
      title: '方案版本不受支持',
      message: `方案 schemaVersion 为 ${doc.schemaVersion}，当前前端仅支持版本 1。`,
      error: { code: 'UNSUPPORTED_SCHEMA_VERSION', requestId: null },
      extraActions: [el('a', { class: 'button button-secondary', href: '#/', text: '返回方案列表' })],
    });
    return {
      dispose() {},
      isDirty: () => false,
      confirmDiscard: async () => true,
      store: null,
    };
  }

  const plan = {
    ...normalized.plan,
    id: normalized.plan.id ?? id,
    name: normalized.plan.name || '',
    revision: normalized.plan.revision,
    updatedAt: normalized.plan.updatedAt,
  };
  const store = createStore({ doc, plan });
  let catalogData = initialCatalog || null;
  let catalogPanel = null;
  let canvas = null;
  let three = null;
  let threeModulePromise = null;
  let selection = null;
  let currentView = '2d';
  let activeFurnitureId = null;
  let disposed = false;
  let saveInFlight = false;
  let pendingFrame = 0;
  let pendingData = false;
  let pendingThree = false;
  let objectSignature = '';
  let shortcutsDialog = null;
  let shareDialog = null;
  let sidebarCollapsed = false;
  let unsubscribe = null;

  document.title = `${plan.name || '未命名方案'} · 编辑 · 酷家乐简易版`;

  /* ---------- 应用壳与头部 ---------- */
  const backLink = el('a', {
    class: 'button button-ghost editor-back',
    href: '#/',
    text: '← 方案列表',
  });
  const titleInput = el('input', {
    id: 'editor-title',
    class: 'plan-title-input',
    type: 'text',
    value: plan.name,
    maxLength: 80,
    autocomplete: 'off',
    attrs: { 'aria-required': 'true' },
  });
  const revisionBadge = el('span', { class: 'badge' });
  const dirtyBadge = el('span', { class: 'badge' });
  const updatedText = el('span', { class: 'muted' });

  const undoButton = el('button', {
    class: 'button button-secondary',
    attrs: { type: 'button', 'aria-keyshortcuts': 'Control+Z' },
    text: '撤销',
  });
  const redoButton = el('button', {
    class: 'button button-secondary',
    attrs: { type: 'button', 'aria-keyshortcuts': 'Control+Shift+Z' },
    text: '重做',
  });
  const saveButton = el('button', {
    class: 'button button-primary',
    attrs: { type: 'button', 'aria-keyshortcuts': 'Control+S' },
    text: '保存',
  });
  const exportButton = el('button', {
    class: 'button button-secondary',
    attrs: { type: 'button' },
    text: '导出 CSV',
  });
  const shareButton = el('button', {
    class: 'button button-secondary',
    attrs: { type: 'button' },
    text: '分享',
  });
  const shortcutsButton = el('button', {
    class: 'icon-button',
    attrs: { type: 'button', 'aria-label': '查看键盘快捷键', title: '键盘快捷键 (?)' },
    text: '?',
  });
  const sidebarToggle = el('button', {
    class: 'button button-secondary sidebar-toggle',
    attrs: { type: 'button', 'aria-expanded': 'true', 'aria-controls': 'editor-sidebar' },
    text: '目录/属性',
  });

  const header = el('header', { class: 'editor-header' }, [
    el('div', { class: 'editor-header-main' }, [
      backLink,
      el('div', { class: 'plan-title-block' }, [
        el('label', {
          class: 'visually-hidden',
          attrs: { for: 'editor-title' },
          text: '方案名称',
        }),
        titleInput,
        el('div', { class: 'editor-meta' }, [revisionBadge, dirtyBadge, updatedText]),
      ]),
    ]),
    el('div', { class: 'editor-actions' }, [
      undoButton,
      redoButton,
      saveButton,
      exportButton,
      shareButton,
      shortcutsButton,
      sidebarToggle,
    ]),
  ]);

  const statusLine = el('div', {
    class: 'editor-status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });

  const saveBannerText = el('p', { class: 'save-banner-text' });
  const saveBannerMeta = el('p', { class: 'save-banner-meta' });
  const retrySaveButton = el('button', {
    class: 'button button-primary button-small',
    attrs: { type: 'button' },
    text: '重试保存',
  });
  const dismissSaveButton = el('button', {
    class: 'button button-secondary button-small',
    attrs: { type: 'button' },
    text: '关闭提示',
  });
  const saveBanner = el('section', {
    class: 'save-banner',
    attrs: { role: 'alert' },
  }, [
    el('div', {}, [saveBannerText, saveBannerMeta]),
    el('div', { class: 'save-banner-actions' }, [retrySaveButton, dismissSaveButton]),
  ]);
  saveBanner.hidden = true;

  /* ---------- 工具体与视图切换 ---------- */
  const toolButtons = new Map();
  const toolGroup = el('div', {
    class: 'segmented',
    attrs: { role: 'toolbar', 'aria-label': '编辑工具' },
  });
  for (const definition of TOOL_DEFS) {
    const button = el('button', {
      class: 'tool-button',
      attrs: {
        type: 'button',
        'aria-pressed': definition.id === 'select' ? 'true' : 'false',
        title: `${definition.label} (${definition.key})`,
      },
    }, [
      el('span', { text: definition.label }),
      el('kbd', { class: 'kbd', text: definition.key }),
    ]);
    button.addEventListener('click', () => chooseTool(definition.id));
    toolButtons.set(definition.id, button);
    toolGroup.append(button);
  }

  const tab2d = el('button', {
    class: 'tool-button',
    attrs: { type: 'button', 'aria-pressed': 'true' },
    text: '2D 户型',
  });
  const tab3d = el('button', {
    class: 'tool-button',
    attrs: { type: 'button', 'aria-pressed': 'false' },
    text: '3D 漫游',
  });
  const fitButton = el('button', {
    class: 'tool-button',
    attrs: { type: 'button', title: '适配视图 (0)' },
    text: '适配',
  });
  const syncRoomsButton = el('button', {
    class: 'button button-secondary button-small',
    attrs: { type: 'button' },
    text: '同步房间',
  });
  const deleteButton = el('button', {
    class: 'button button-secondary button-small',
    attrs: { type: 'button', 'aria-keyshortcuts': 'Delete' },
    text: '删除',
  });

  const stageToolbar = el('div', { class: 'stage-toolbar' }, [
    toolGroup,
    el('span', { class: 'toolbar-spacer' }),
    el('div', { class: 'view-tabs', attrs: { 'aria-label': '视图切换' } }, [tab2d, tab3d]),
    fitButton,
    syncRoomsButton,
    deleteButton,
  ]);

  /* ---------- 画布舞台 ---------- */
  const canvasElement = el('canvas', {
    class: 'canvas-2d',
    attrs: {
      tabindex: '0',
      role: 'application',
      'aria-describedby': 'editor-canvas-help',
    },
  });
  const threeHost = el('div', { class: 'three-host' });
  threeHost.hidden = true;

  const emptyOverlay = el('div', { class: 'stage-empty' }, [
    el('p', { class: 'stage-empty-title', text: '空方案' }),
    el('p', {
      class: 'stage-empty-text',
      text: '选择「墙」工具，在画布上依次点击起点与终点；闭合后会自动识别房间。',
    }),
  ]);
  const stageHint = el('div', { class: 'stage-hint' });
  const stageBadge = el('div', { class: 'view-badge', text: '同一份文档 · 2D' });

  const orbitButton = el('button', {
    class: 'tool-button',
    attrs: { type: 'button', 'aria-pressed': 'true' },
    text: '轨道视角',
  });
  const walkButton = el('button', {
    class: 'tool-button',
    attrs: { type: 'button', 'aria-pressed': 'false' },
    text: '第一人称',
  });
  const fit3dButton = el('button', {
    class: 'tool-button',
    attrs: { type: 'button' },
    text: '适配视图',
  });
  const threeControls = el('div', { class: 'view-controls' }, [
    orbitButton,
    walkButton,
    fit3dButton,
  ]);
  threeControls.hidden = true;

  const stage = el('div', { class: 'stage editor-stage' }, [
    canvasElement,
    threeHost,
    emptyOverlay,
    stageHint,
    stageBadge,
    threeControls,
  ]);
  const stagePanel = el('section', { class: 'stage-panel' }, [stageToolbar, stage]);

  /* ---------- 侧栏：目录 / 对象 / 属性 ---------- */
  const catalogMount = el('div', { class: 'sidebar-section' });
  const objectList = el('div', { class: 'object-list' });
  const objectCount = el('span', { class: 'muted' });
  const objectPanel = el('section', {
    class: 'panel',
    attrs: { 'aria-labelledby': 'editor-objects-title' },
  }, [
    el('div', { class: 'panel-header' }, [
      el('h2', { id: 'editor-objects-title', class: 'panel-title', text: '对象' }),
      objectCount,
    ]),
    el('div', { class: 'panel-body' }, [objectList]),
  ]);
  const propertiesBody = el('div', { class: 'panel-body properties' });
  const propertiesPanel = el('section', {
    class: 'panel',
    attrs: { 'aria-labelledby': 'editor-properties-title' },
  }, [
    el('div', { class: 'panel-header' }, [
      el('h2', { id: 'editor-properties-title', class: 'panel-title', text: '属性' }),
    ]),
    propertiesBody,
  ]);
  const sidebar = el('aside', {
    id: 'editor-sidebar',
    class: 'editor-sidebar',
    attrs: { 'aria-label': '目录与属性' },
  }, [catalogMount, objectPanel, propertiesPanel]);

  const workspace = el('div', { class: 'editor-workspace' }, [stagePanel, sidebar]);
  const canvasHelp = el('p', {
    id: 'editor-canvas-help',
    class: 'visually-hidden',
    text: '2D 编辑画布：方向键微调 100 毫米，Shift 加方向键微调 500 毫米；Delete 删除选中；R 旋转家具；加减号缩放；0 适配视图；Esc 取消工具。',
  });
  const shell = el('div', { class: 'editor-shell' }, [
    header,
    statusLine,
    saveBanner,
    workspace,
    canvasHelp,
  ]);
  mount.replaceChildren(shell);

  canvas = new Canvas2D({
    canvas: canvasElement,
    getDoc: () => store.getDoc(),
    getCatalog: () => catalogData,
    readonly: false,
    handlers: {
      onSelect: (next) => handleSelection(next),
      onAddWall: (wall) => store.addWall(wall),
      onAddOpening: (opening) => store.addOpening(opening),
      onMoveWall: (wallId, a, b) => store.moveWall(wallId, a, b),
      onMoveOpening: (openingId, offset) => store.updateOpening(openingId, { offset }),
      onMoveFurniture: (furnitureId, patch) => store.updateFurniture(furnitureId, patch),
      onPlaceFurniture: (item) => store.addFurniture(item),
      onDelete: (target) => deleteSelection(target),
      onNudge: (target, dx, dy) => nudgeSelection(target, dx, dy),
      onRotate: (target, delta) => {
        if (target?.type === 'furniture') run(() => store.rotateFurniture(target.id, delta));
      },
      onError: (error) => toastError(error),
      onNotice: (message) => showToast({ message, tone: 'warning' }),
      onToolChange: () => {
        if (canvas.getTool() !== 'furniture') activeFurnitureId = null;
        updateToolbar();
        updateCatalogState();
        updateHint();
        refreshChrome();
      },
    },
  });

  catalogPanel = createCatalogPanel({
    container: catalogMount,
    catalog: catalogData,
    onSelectFurniture: (item) => {
      chooseTool('furniture', item.id);
      if (window.matchMedia('(max-width: 960px)').matches) setSidebarCollapsed(true);
    },
    onApplyMaterial: (kind, roomId, materialId) => {
      run(() => {
        store.setMaterial(kind, roomId, materialId);
        announce('已应用材质');
      });
    },
    onClearMaterial: (kind, roomId) => {
      run(() => {
        store.setMaterial(kind, roomId, null);
        announce('已清除材质');
      });
    },
    onRoomChange: (roomId) => {
      if (!canvas) return;
      if (roomId) canvas.select({ type: 'room', id: roomId });
      else canvas.select(null);
    },
    onRetry: () => {
      loadCatalog();
    },
  });

  /* ---------- 通用工具 ---------- */
  let exportInFlight = false;

  function run(action) {
    try {
      return action();
    } catch (error) {
      toastError(error);
      return null;
    }
  }

  function toastError(error) {
    showToast({ message: errorText(error), tone: 'error', error });
  }

  function hasContent() {
    const currentDoc = store.getDoc();
    return Boolean((currentDoc.walls || []).length || (currentDoc.furniture || []).length);
  }

  /* ---------- 目录 ---------- */
  async function loadCatalog() {
    if (!catalogProvider) {
      catalogPanel?.showError();
      return;
    }
    catalogPanel?.showLoading();
    try {
      const next = await catalogProvider();
      if (disposed) return;
      if (!next) throw new Error('目录数据为空');
      catalogData = next;
      catalogPanel?.setCatalog(next);
      updateCatalogState();
      canvas?.refresh();
      if (three) three.rebuild();
    } catch (error) {
      if (disposed) return;
      catalogPanel?.showError();
      showToast({ message: '家具与材质目录加载失败', tone: 'error', error });
    }
  }

  function updateCatalogState() {
    if (!catalogPanel) return;
    const currentDoc = store.getDoc();
    catalogPanel.update({
      rooms: currentDoc.rooms,
      materials: currentDoc.materials,
      selectedRoomId: selection?.type === 'room' ? selection.id : null,
      activeFurnitureId: canvas?.getTool() === 'furniture' ? activeFurnitureId : null,
    });
  }

  /* ---------- 工具与视图 ---------- */
  function chooseTool(tool, furnitureId = null) {
    if (disposed) return;
    if (currentView !== '2d') {
      setView('2d').catch((error) => toastError(error));
    }
    setTool(tool, furnitureId);
  }

  function setTool(tool, furnitureId = null) {
    if (!canvas) return;
    activeFurnitureId = tool === 'furniture' ? furnitureId : null;
    canvas.setTool(tool, furnitureId);
    updateToolbar();
    updateCatalogState();
    updateHint();
    refreshChrome();
  }

  function updateToolbar() {
    if (!canvas) return;
    const activeTool = canvas.getTool();
    for (const [tool, button] of toolButtons) {
      button.setAttribute('aria-pressed', tool === activeTool ? 'true' : 'false');
    }
    const deletable = Boolean(selection) && selection.type !== 'room';
    deleteButton.disabled = !deletable;
    deleteButton.title = deletable
      ? `删除选中的${selection.type === 'opening' ? '门窗' : selection.type === 'furniture' ? '家具' : '墙体'}`
      : '未选中可删除对象 (Delete)';
  }

  async function ensureThree() {
    if (three) return three;
    if (disposed || currentView !== '3d') return null;
    if (!threeModulePromise) threeModulePromise = import('./three-view.js');
    let module;
    try {
      module = await threeModulePromise;
    } catch (error) {
      threeModulePromise = null;
      throw error;
    }
    if (disposed || currentView !== '3d') return null;
    const ThreeView = module.ThreeView || module.default;
    if (typeof ThreeView !== 'function') throw new Error('3D 模块未导出 ThreeView');
    try {
      three = new ThreeView({
        container: threeHost,
        getDoc: () => store.getDoc(),
        getCatalog: () => catalogData,
        readonly: false,
        onModeChange: () => {
          updateViewChrome();
          updateHint();
        },
      });
    } catch (error) {
      three = null;
      threeHost.replaceChildren();
      throw error;
    }
    return three;
  }

  function disposeThree() {
    if (three) {
      try {
        three.destroy();
      } catch {
        // 释放失败不阻塞切回 2D
      }
      three = null;
    }
    if (threeHost) threeHost.replaceChildren();
  }

  async function setView(nextView) {
    if (disposed || (nextView !== '2d' && nextView !== '3d')) return;
    if (nextView === currentView) return;
    if (nextView === '2d') {
      currentView = '2d';
      disposeThree();
      canvasElement.hidden = false;
      threeHost.hidden = true;
      updateViewChrome();
      canvas.resize();
      canvas.refresh();
      return;
    }

    currentView = '3d';
    canvasElement.hidden = true;
    threeHost.hidden = false;
    updateViewChrome();
    try {
      const instance = await ensureThree();
      if (disposed) return;
      if (currentView !== '3d') return;
      if (!instance) throw new Error('3D 视图不可用');
      instance.resize();
      instance.rebuild();
    } catch (error) {
      if (disposed) return;
      currentView = '2d';
      disposeThree();
      canvasElement.hidden = false;
      threeHost.hidden = true;
      updateViewChrome();
      canvas.resize();
      canvas.refresh();
      showToast({ message: '3D 视图初始化失败，已切回 2D 编辑', tone: 'error', error });
    }
  }

  function updateViewChrome() {
    tab2d.setAttribute('aria-pressed', currentView === '2d' ? 'true' : 'false');
    tab3d.setAttribute('aria-pressed', currentView === '3d' ? 'true' : 'false');
    threeControls.hidden = currentView !== '3d';
    stageBadge.textContent = `同一份文档 · ${currentView === '2d' ? '2D' : '3D'}`;
    const mode = three?.getMode?.() || 'orbit';
    orbitButton.setAttribute('aria-pressed', mode === 'orbit' ? 'true' : 'false');
    walkButton.setAttribute('aria-pressed', mode === 'walk' ? 'true' : 'false');
    emptyOverlay.hidden = !hasContent() ? currentView === '3d' : true;
    updateHint();
  }

  function updateHint() {
    if (currentView === '3d') {
      const mode = three?.getMode?.() || 'orbit';
      stageHint.textContent = mode === 'walk'
        ? '第一人称：点击画面锁定鼠标 · WASD 移动 · 鼠标观察 · Esc 释放鼠标 · 3D 与 2D 共用同一份文档'
        : '轨道：拖拽旋转 · 滚轮缩放 · Shift 或右键拖拽平移 · 3D 与 2D 共用同一份文档';
      return;
    }
    const tool = canvas?.getTool() || 'select';
    if (tool === 'wall') {
      stageHint.textContent = '墙体：点击起点与终点连续绘制 · Shift 锁定 90° · 吸附端点/网格 · Esc 结束';
    } else if (tool === 'door' || tool === 'window') {
      stageHint.textContent = `点击墙体放置${tool === 'door' ? '门' : '窗'} · Esc 取消 · 选中后可拖动或方向键微调`;
    } else if (tool === 'furniture') {
      const item = findFurniture(catalogData, activeFurnitureId);
      stageHint.textContent = `点击画布放置「${item?.name || activeFurnitureId || '家具'}」 · Esc 取消 · 已放置家具可拖拽移动`;
    } else {
      stageHint.textContent = '选择：点击对象 · 拖拽移动 · 方向键微调 100mm（Shift 500mm）· Delete 删除 · 0 适配';
    }
  }

  /* ---------- 选择与对象列表 ---------- */
  function describeSelection(target) {
    if (!target) return '未选中对象';
    const currentDoc = store.getDoc();
    if (target.type === 'wall' || target.type === 'vertex') {
      const wall = (currentDoc.walls || []).find((entry) => entry.id === target.id);
      if (!wall) return `已选墙体 ${target.id}（已不存在）`;
      const endpoint = target.type === 'vertex'
        ? `，端点 ${target.endpoint === 0 ? 'A' : 'B'}`
        : '';
      return `已选墙体 ${wall.id}，${Math.round(wallLength(wall))} mm${endpoint}`;
    }
    if (target.type === 'opening') {
      const opening = (currentDoc.openings || []).find((entry) => entry.id === target.id);
      if (!opening) return `已选门窗 ${target.id}（已不存在）`;
      return `已选${opening.type === 'window' ? '窗' : '门'} ${opening.id}，${Math.round(opening.width)}×${Math.round(opening.height)} mm`;
    }
    if (target.type === 'furniture') {
      const item = (currentDoc.furniture || []).find((entry) => entry.id === target.id);
      if (!item) return `已选家具 ${target.id}（已不存在）`;
      const catalogItem = findFurniture(catalogData, item.catalogId);
      return `已选${catalogItem?.name || item.catalogId}，旋转 ${Math.round(item.rotation || 0)}°`;
    }
    if (target.type === 'room') {
      const room = (currentDoc.rooms || []).find((entry) => entry.id === target.id);
      if (!room) return `已选房间 ${target.id}（已不存在）`;
      return `已选房间 ${room.name || '未命名房间'}`;
    }
    return '已选对象';
  }

  function handleSelection(next) {
    selection = next ? { ...next } : null;
    updateToolbar();
    updateObjectSelection();
    refreshProperties();
    updateCatalogState();
    refreshChrome();
    if (selection) announce(describeSelection(selection));
  }

  function updateObjectSelection() {
    for (const button of objectList.querySelectorAll('button[data-object-type]')) {
      const type = button.dataset.objectType;
      const objectId = button.dataset.objectId;
      let active = false;
      if (selection) {
        if (type === 'wall') {
          active = (selection.type === 'wall' || selection.type === 'vertex') && selection.id === objectId;
        } else {
          active = selection.type === type && selection.id === objectId;
        }
      }
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function refreshObjects() {
    const currentDoc = store.getDoc();
    const groups = [
      {
        label: '墙体',
        items: (currentDoc.walls || []).filter((wall) => wall.id).map((wall) => ({
          type: 'wall',
          id: wall.id,
          label: `墙体 ${wall.id} · ${Math.round(wallLength(wall))} mm`,
        })),
      },
      {
        label: '门窗',
        items: (currentDoc.openings || []).filter((opening) => opening.id).map((opening) => {
          const wall = (currentDoc.walls || []).find((entry) => entry.id === opening.wallId);
          return {
            type: 'opening',
            id: opening.id,
            label: `${opening.type === 'window' ? '窗' : '门'} ${opening.id} · ${Math.round(opening.width)} mm${wall ? ` · 墙 ${wall.id}` : ''}`,
          };
        }),
      },
      {
        label: '家具',
        items: (currentDoc.furniture || []).filter((item) => item.id).map((item) => {
          const catalogItem = findFurniture(catalogData, item.catalogId);
          return {
            type: 'furniture',
            id: item.id,
            label: `${catalogItem?.name || item.catalogId} ${item.id} · ${Math.round(item.rotation || 0)}°`,
          };
        }),
      },
      {
        label: '房间',
        items: (currentDoc.rooms || []).filter((room) => room.id).map((room) => {
          const wallCount = String(room.loopKey || '').split('|').filter(Boolean).length;
          return {
            type: 'room',
            id: room.id,
            label: `${room.name || '未命名房间'} · ${wallCount} 面墙`,
          };
        }),
      },
    ].filter((group) => group.items.length);

    const total = groups.reduce((sum, group) => sum + group.items.length, 0);
    objectCount.textContent = `${formatCount(total)} 个`;
    const signature = JSON.stringify(groups.map((group) => ({
      label: group.label,
      items: group.items.map((item) => [item.type, item.id, item.label]),
    })));
    if (signature === objectSignature) {
      updateObjectSelection();
      return;
    }

    const activeElement = document.activeElement;
    const activeKey = activeElement && objectList.contains(activeElement)
      ? `${activeElement.dataset.objectType}:${activeElement.dataset.objectId}`
      : null;

    if (!groups.length) {
      objectList.replaceChildren(el('p', {
        class: 'hint-text',
        text: '暂无对象。用墙体工具绘制，或从家具目录放置。',
      }));
    } else {
      const container = el('div', { class: 'object-groups' });
      for (const group of groups) {
        const buttons = group.items.map((item) => {
          const button = el('button', {
            class: 'object-item',
            attrs: {
              type: 'button',
              'aria-pressed': 'false',
              title: `选择 ${item.label}`,
            },
            dataset: { objectType: item.type, objectId: item.id },
            text: item.label,
          });
          button.addEventListener('click', () => {
            canvas.select({ type: item.type, id: item.id });
          });
          return button;
        });
        container.append(el('div', { class: 'object-group' }, [
          el('h3', {
            class: 'object-group-title',
            text: `${group.label}（${group.items.length}）`,
          }),
          el('div', { class: 'object-buttons' }, buttons),
        ]));
      }
      objectList.replaceChildren(container);
    }
    objectSignature = signature;
    updateObjectSelection();

    if (activeKey) {
      const target = Array.from(objectList.querySelectorAll('button[data-object-type]'))
        .find((button) => `${button.dataset.objectType}:${button.dataset.objectId}` === activeKey);
      target?.focus({ preventScroll: true });
    }
  }

  function updateEmptyState() {
    const content = hasContent();
    emptyOverlay.hidden = content || currentView === '3d';
  }

  /* ---------- 界面刷新 ---------- */
  function scheduleRefresh({ data = false, rebuild3d = false } = {}) {
    pendingData = pendingData || data;
    pendingThree = pendingThree || rebuild3d;
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      if (disposed) return;
      refreshChrome();
      if (pendingData) {
        pendingData = false;
        refreshObjects();
        refreshProperties();
        updateCatalogState();
        updateEmptyState();
      }
      if (pendingThree) {
        pendingThree = false;
        if (three) three.rebuild();
      }
    });
  }

  function updateBanner(state) {
    if (state.saveError && !state.saving) {
      saveBanner.hidden = false;
      saveBannerText.textContent = errorText(state.saveError);
      const meta = errorMeta(state.saveError);
      saveBannerMeta.textContent = meta;
      saveBannerMeta.hidden = !meta;
      retrySaveButton.disabled = false;
    } else {
      saveBanner.hidden = true;
      saveBannerMeta.hidden = true;
    }
  }

  function updateStatus() {
    const state = store.getState();
    const currentDoc = store.getDoc();
    const counts = [
      `${formatCount((currentDoc.walls || []).length)} 面墙`,
      `${formatCount((currentDoc.openings || []).length)} 个门窗`,
      `${formatCount((currentDoc.furniture || []).length)} 件家具`,
      `${formatCount((currentDoc.rooms || []).length)} 个房间`,
    ].join(' · ');
    const saveText = state.saving ? '正在保存' : (state.dirty ? '有未保存修改' : '已保存');
    statusLine.textContent = `${counts} · ${describeSelection(selection)} · ${saveText}`;
  }

  function refreshChrome() {
    if (disposed) return;
    const state = store.getState();
    const currentPlan = store.getPlan();

    if (document.activeElement !== titleInput) {
      titleInput.value = currentPlan.name;
    }
    revisionBadge.textContent = Number.isInteger(currentPlan.revision)
      ? `revision ${currentPlan.revision}`
      : 'revision 未确认';
    dirtyBadge.textContent = state.dirty ? '未保存' : '已保存';
    dirtyBadge.className = `badge ${state.dirty ? 'badge-dirty' : 'badge-saved'}`;
    dirtyBadge.title = state.dirty ? '存在尚未写入服务端的修改' : '与服务端保存版本一致';
    updatedText.textContent = state.lastSavedAt
      ? `本次保存 ${formatDateTime(state.lastSavedAt)}`
      : (currentPlan.updatedAt ? `服务端更新 ${formatDateTime(currentPlan.updatedAt)}` : '尚未保存');

    undoButton.disabled = !state.canUndo;
    undoButton.title = state.canUndo ? `撤销：${store.undoLabel}` : '没有可撤销的操作';
    undoButton.setAttribute('aria-label', state.canUndo ? `撤销：${store.undoLabel}` : '撤销（无可用操作）');
    redoButton.disabled = !state.canRedo;
    redoButton.title = state.canRedo ? `重做：${store.redoLabel}` : '没有可重做的操作';
    redoButton.setAttribute('aria-label', state.canRedo ? `重做：${store.redoLabel}` : '重做（无可用操作）');

    saveButton.disabled = state.saving || !state.dirty || saveInFlight;
    saveButton.textContent = state.saving ? '保存中…' : '保存';
    saveButton.setAttribute('aria-busy', state.saving ? 'true' : 'false');
    exportButton.disabled = state.saving || exportInFlight;

    updateToolbar();
    updateStatus();
    updateBanner(state);
    document.title = `${state.dirty ? '* ' : ''}${currentPlan.name || '未命名方案'} · 编辑 · 酷家乐简易版`;
  }

  /* ---------- 删除与微调 ---------- */
  function deleteSelection(target) {
    if (!target) return;
    const snapshot = { ...target };
    if (snapshot.type === 'room') {
      showToast({
        message: '房间由墙体闭环自动识别；请删除墙体，或保留闭环后使用「同步房间」。',
        tone: 'warning',
      });
      return;
    }
    run(() => {
      if (snapshot.type === 'wall' || snapshot.type === 'vertex') {
        store.deleteWall(snapshot.id);
      } else if (snapshot.type === 'opening') {
        store.deleteOpening(snapshot.id);
      } else if (snapshot.type === 'furniture') {
        store.deleteFurniture(snapshot.id);
      } else {
        return;
      }
      selection = null;
      canvas.select(null);
      announce('已删除选中对象');
    });
  }

  function nudgeSelection(target, dx, dy) {
    if (!target) return;
    const currentDoc = store.getDoc();
    if (target.type === 'furniture') {
      const item = (currentDoc.furniture || []).find((entry) => entry.id === target.id);
      if (!item) return;
      run(() => store.updateFurniture(target.id, {
        x: item.x + dx,
        y: item.y + dy,
      }));
      return;
    }
    if (target.type === 'opening') {
      const opening = (currentDoc.openings || []).find((entry) => entry.id === target.id);
      if (!opening) return;
      run(() => store.updateOpening(target.id, {
        offset: opening.offset + dx,
        sill: opening.sill + dy,
      }));
      return;
    }
    if (target.type === 'wall' || target.type === 'vertex') {
      const wall = (currentDoc.walls || []).find((entry) => entry.id === target.id);
      if (!wall) return;
      let a = [wall.a[0], wall.a[1]];
      let b = [wall.b[0], wall.b[1]];
      if (target.type === 'vertex' && target.endpoint === 0) {
        a = [a[0] + dx, a[1] + dy];
      } else if (target.type === 'vertex' && target.endpoint === 1) {
        b = [b[0] + dx, b[1] + dy];
      } else if (target.type === 'wall') {
        a = [a[0] + dx, a[1] + dy];
        b = [b[0] + dx, b[1] + dy];
      }
      run(() => store.moveWall(target.id, a, b));
    }
  }

  /* ---------- 属性面板 ---------- */
  function applyEdit(action) {
    try {
      action();
      return true;
    } catch (error) {
      toastError(error);
      return false;
    }
  }

  function numberField({
    label, value, min, max, step = 1, help = '', commit,
  }) {
    const fallback = String(value);
    const input = el('input', {
      class: 'input',
      type: 'number',
      value: fallback,
      attrs: {
        min: String(min),
        max: String(max),
        step: String(step),
        inputmode: 'decimal',
      },
    });
    input.addEventListener('change', () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) {
        input.value = fallback;
        toastError(new Error(`${label}必须是数字`));
        return;
      }
      if (!applyEdit(() => commit(parsed))) input.value = fallback;
    });
    return field({ label, control: input, help });
  }

  function textField({
    label, value, maxLength = 80, help = '', commit,
  }) {
    const fallback = String(value);
    const input = el('input', {
      class: 'input',
      type: 'text',
      value: fallback,
      maxLength,
      autocomplete: 'off',
    });
    input.addEventListener('change', () => {
      if (!applyEdit(() => commit(input.value))) input.value = fallback;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
    });
    return field({ label, control: input, help });
  }

  function actionRow(...buttons) {
    return el('div', { class: 'prop-actions' }, buttons);
  }

  function actionButton(label, onClick, variant = 'secondary') {
    return el('button', {
      class: `button button-${variant} button-small`,
      attrs: { type: 'button' },
      text: label,
      on: { click: onClick },
    });
  }

  function metaLine(...parts) {
    return el('p', { class: 'prop-meta' }, parts.map((part) => el('span', { text: part })));
  }

  function materialSelect(kind, room) {
    const currentDoc = store.getDoc();
    const current = currentDoc.materials?.[kind]?.[room.id] || '';
    const items = kind === 'floor'
      ? (catalogData?.floorMaterials || [])
      : (catalogData?.wallMaterials || []);
    const select = el('select', {
      class: 'select',
      attrs: {
        'aria-label': kind === 'floor' ? '房间地面材质' : '房间墙面材质',
      },
    }, [
      el('option', { value: '', text: '未设置（预览默认色）' }),
      ...items.map((item) => el('option', { value: item.id, text: item.name })),
    ]);
    select.value = current;
    select.disabled = !items.length;
    select.addEventListener('change', () => {
      applyEdit(() => store.setMaterial(kind, room.id, select.value || null));
    });
    return field({
      label: kind === 'floor' ? '地面材质' : '墙面材质',
      control: select,
      help: items.length ? '材质用量与 CSV 由服务端计算' : '目录尚未加载或为空',
    });
  }

  function refreshProperties() {
    if (disposed) return;
    const doc = store.getDoc();
    if (!selection) {
      propertiesBody.replaceChildren(el('p', {
        class: 'properties-empty',
        text: '未选中对象。点击画布中的墙体、门窗、家具或房间查看属性；也可在「对象」列表中切换。',
      }));
      return;
    }

    if (selection.type === 'wall' || selection.type === 'vertex') {
      const wall = (doc.walls || []).find((entry) => entry.id === selection.id);
      if (!wall) {
        propertiesBody.replaceChildren(el('p', { class: 'properties-empty', text: '墙体已不存在。' }));
        return;
      }
      const endpointText = selection.type === 'vertex'
        ? `，端点 ${selection.endpoint === 0 ? 'A' : 'B'}`
        : '';
      propertiesBody.replaceChildren(
        metaLine(`墙体 ${wall.id}`, `长度 ${Math.round(wallLength(wall))} mm${endpointText}`),
        el('div', { class: 'prop-grid' }, [
          numberField({
            label: '厚度 (mm)',
            value: wall.thickness,
            min: 10,
            max: 1000,
            help: '10–1000 mm',
            commit: (value) => store.updateWall(wall.id, { thickness: value }),
          }),
          numberField({
            label: '高度 (mm)',
            value: wall.height,
            min: 100,
            max: 10000,
            help: '100–10000 mm',
            commit: (value) => store.updateWall(wall.id, { height: value }),
          }),
        ]),
        actionRow(actionButton('删除墙体', () => deleteSelection(selection), 'danger')),
      );
      return;
    }

    if (selection.type === 'opening') {
      const opening = (doc.openings || []).find((entry) => entry.id === selection.id);
      if (!opening) {
        propertiesBody.replaceChildren(el('p', { class: 'properties-empty', text: '门窗已不存在。' }));
        return;
      }
      propertiesBody.replaceChildren(
        metaLine(
          `${opening.type === 'window' ? '窗' : '门'} ${opening.id}`,
          `所在墙 ${opening.wallId}`,
        ),
        el('div', { class: 'prop-grid' }, [
          numberField({
            label: '距墙起点 (mm)',
            value: opening.offset,
            min: 0,
            max: 100000,
            step: 10,
            commit: (value) => store.updateOpening(opening.id, { offset: value }),
          }),
          numberField({
            label: '宽度 (mm)',
            value: opening.width,
            min: 100,
            max: 100000,
            step: 10,
            commit: (value) => store.updateOpening(opening.id, { width: value }),
          }),
          numberField({
            label: '高度 (mm)',
            value: opening.height,
            min: 100,
            max: 10000,
            step: 10,
            commit: (value) => store.updateOpening(opening.id, { height: value }),
          }),
          opening.type === 'window'
            ? numberField({
              label: '窗台高 (mm)',
              value: opening.sill,
              min: 0,
              max: 10000,
              step: 10,
              commit: (value) => store.updateOpening(opening.id, { sill: value }),
            })
            : el('p', { class: 'hint-text', text: '门洞窗台高固定为 0；3D 中门洞上方自动生成过梁。' }),
        ]),
        actionRow(actionButton('删除门窗', () => deleteSelection(selection), 'danger')),
      );
      return;
    }

    if (selection.type === 'furniture') {
      const item = (doc.furniture || []).find((entry) => entry.id === selection.id);
      if (!item) {
        propertiesBody.replaceChildren(el('p', { class: 'properties-empty', text: '家具已不存在。' }));
        return;
      }
      const catalogItem = findFurniture(catalogData, item.catalogId);
      propertiesBody.replaceChildren(
        metaLine(
          catalogItem?.name || item.catalogId,
          `家具 ${item.id}`,
          `${Math.round(catalogItem?.width || 0)}×${Math.round(catalogItem?.depth || 0)} mm`,
        ),
        el('div', { class: 'prop-grid' }, [
          numberField({
            label: 'X (mm)',
            value: item.x,
            min: -100000,
            max: 100000,
            step: 50,
            commit: (value) => store.updateFurniture(item.id, { x: value }),
          }),
          numberField({
            label: 'Y (mm)',
            value: item.y,
            min: -100000,
            max: 100000,
            step: 50,
            commit: (value) => store.updateFurniture(item.id, { y: value }),
          }),
          numberField({
            label: '旋转 (°)',
            value: item.rotation,
            min: 0,
            max: 359,
            step: 15,
            commit: (value) => store.updateFurniture(item.id, { rotation: value }),
          }),
        ]),
        actionRow(
          actionButton('左转 15°', () => applyEdit(() => store.rotateFurniture(item.id, -15))),
          actionButton('右转 15°', () => applyEdit(() => store.rotateFurniture(item.id, 15))),
          actionButton('删除家具', () => deleteSelection(selection), 'danger'),
        ),
      );
      return;
    }

    if (selection.type === 'room') {
      const room = (doc.rooms || []).find((entry) => entry.id === selection.id);
      if (!room) {
        propertiesBody.replaceChildren(el('p', { class: 'properties-empty', text: '房间已不存在。' }));
        return;
      }
      const wallCount = String(room.loopKey || '').split('|').filter(Boolean).length;
      propertiesBody.replaceChildren(
        metaLine(`房间 ${room.id}`, `${wallCount} 面墙`, '面积/周长由服务端权威计算'),
        textField({
          label: '房间名称',
          value: room.name,
          help: '修改后墙体编辑仍会保留该房间名称（loopKey 稳定）',
          commit: (value) => store.setRoomName(room.id, value),
        }),
        el('div', { class: 'prop-grid' }, [
          materialSelect('floor', room),
          materialSelect('wall', room),
        ]),
        el('p', {
          class: 'hint-text',
          text: '房间由墙体闭环自动识别；删除墙体会同时清理失效的房间与材质。',
        }),
      );
      return;
    }

    propertiesBody.replaceChildren(el('p', { class: 'properties-empty', text: '该对象没有可编辑属性。' }));
  }

  /* ---------- 保存与冲突 ---------- */
  async function reloadPlan() {
    try {
      const fresh = normalizePlanPayload(await api.getPlan(store.getPlan().id ?? id));
      if (!fresh || !fresh.doc) throw new Error('服务端未返回可用的方案文档');
      store.replaceDoc(fresh.doc, { ...store.getPlan(), ...fresh.plan });
      selection = null;
      canvas.select(null);
      titleInput.value = store.getPlan().name;
      refreshObjects();
      refreshProperties();
      refreshChrome();
      updateEmptyState();
      if (three) three.rebuild();
      announce('已重新加载服务端版本');
      showToast({ message: '已重新加载服务端最新版本', tone: 'success' });
      return true;
    } catch (error) {
      store.setSaveError(error);
      toastError(error);
      return false;
    }
  }

  function showConflictDialog(error) {
    const detail = el('p', {
      class: 'dialog-text',
      text: '该方案已在其他地方被更新，当前编辑内容仍保留在本地。请选择重新加载服务端版本（放弃本地修改），或用本地内容覆盖保存。',
    });
    const meta = errorMeta(error)
      ? el('p', { class: 'error-meta', text: errorMeta(error) })
      : null;
    showDialog({
      title: '保存冲突（409 CONFLICT_REVISION）',
      content: el('div', {}, [detail, meta]),
      size: 'md',
      actions: [
        {
          label: '重新加载服务端版本',
          variant: 'secondary',
          onClick: (context) => {
            context.close();
            reloadPlan();
            return false;
          },
        },
        {
          label: '用本地内容覆盖保存',
          variant: 'danger',
          onClick: (context) => {
            context.close();
            overwriteSave();
            return false;
          },
        },
        { label: '稍后处理', variant: 'ghost' },
      ],
    });
  }

  async function performSave({ expectedRevision = null } = {}) {
    if (saveInFlight || disposed) return false;
    const planId = store.getPlan().id ?? id;
    let name;
    try {
      name = validatePlanName(titleInput.value);
    } catch (error) {
      toastError(error);
      titleInput.focus();
      return false;
    }
    const revision = expectedRevision ?? store.getPlan().revision;
    if (!Number.isInteger(revision) || revision < 1) {
      showToast({
        message: '服务端未返回可用的 revision，请重新打开方案后再保存',
        tone: 'error',
      });
      return false;
    }
    if (name !== store.getPlan().name) {
      try {
        store.setName(name);
      } catch (error) {
        toastError(error);
        return false;
      }
    }

    const versionAtStart = store.getState().version;
    saveInFlight = true;
    store.setSaving(true);
    refreshChrome();
    try {
      const result = await api.savePlan(planId, {
        name,
        doc: store.getDoc(),
        expectedRevision: revision,
      });
      const normalized = normalizePlanPayload(result);
      const nextRevision = normalized?.plan?.revision ?? result?.revision;
      const savedName = normalized?.plan?.name ?? result?.name ?? name;
      if (!Number.isInteger(nextRevision) || nextRevision < 1) {
        throw new Error('保存响应缺少有效的 revision');
      }
      store.markSaved({
        revision: nextRevision,
        name: savedName,
        savedVersion: versionAtStart,
      });
      announce(`已保存 revision ${nextRevision}`);
      showToast({ message: `已保存 revision ${nextRevision}`, tone: 'success' });
      return true;
    } catch (error) {
      if (error && error.isConflict) {
        store.setSaveError(error);
        showConflictDialog(error);
      } else {
        store.setSaveError(error);
        toastError(error);
      }
      return false;
    } finally {
      saveInFlight = false;
      if (store.getState().saving) store.setSaving(false);
      refreshChrome();
    }
  }

  async function overwriteSave() {
    if (saveInFlight || disposed) return;
    try {
      const latest = normalizePlanPayload(await api.getPlan(store.getPlan().id ?? id));
      const revision = latest?.plan?.revision;
      if (!Number.isInteger(revision) || revision < 1) {
        throw new Error('服务端未返回可用的 revision，无法覆盖保存');
      }
      await performSave({ expectedRevision: revision });
    } catch (error) {
      store.setSaveError(error);
      toastError(error);
    }
  }

  /* ---------- CSV / 分享 ---------- */
  async function exportCsv() {
    if (exportInFlight) return;
    if (store.getState().dirty) {
      showToast({
        message: '有未保存修改：CSV 由服务端按已保存版本生成，请先保存后再导出',
        tone: 'warning',
      });
      return;
    }
    exportInFlight = true;
    refreshChrome();
    try {
      const result = await api.exportCsv(store.getPlan().id ?? id);
      downloadBlob(
        result.blob,
        result.filename || `${safeFilename(store.getPlan().name)}.csv`,
      );
      showToast({ message: 'CSV 已开始下载（服务端权威统计）', tone: 'success' });
    } catch (error) {
      toastError(error);
    } finally {
      exportInFlight = false;
      refreshChrome();
    }
  }

  function absoluteShareUrl(token, rawUrl) {
    if (rawUrl) {
      try {
        return new URL(rawUrl, window.location.origin).href;
      } catch {
        // 回落到 hash 路由
      }
    }
    return buildShareUrl(token);
  }

  function openShareDialog() {
    if (store.getState().dirty) {
      showToast({
        message: '请先保存方案，再生成只读分享链接（分享内容为服务端已保存版本）',
        tone: 'warning',
      });
      return;
    }
    const planId = store.getPlan().id ?? id;
    const linkInput = el('input', {
      class: 'input',
      type: 'text',
      readonly: true,
      value: '',
      attrs: {
        'aria-label': '只读分享链接',
        spellcheck: 'false',
        placeholder: '点击「生成分享链接」后显示',
      },
    });
    const status = el('p', {
      class: 'hint-text',
      attrs: { role: 'status', 'aria-live': 'polite' },
      text: '分享内容来自服务端已保存版本；任何获得链接的人都能查看 2D/3D 并下载 CSV。',
    });
    const openLink = el('a', {
      class: 'button button-secondary',
      href: '#',
      target: '_blank',
      rel: 'noopener',
      text: '在新窗口打开',
    });
    openLink.hidden = true;
    const copyButton = el('button', {
      class: 'button button-secondary',
      attrs: { type: 'button' },
      text: '复制链接',
    });
    copyButton.disabled = true;
    const generateButton = el('button', {
      class: 'button button-primary',
      attrs: { type: 'button' },
      text: '生成分享链接',
    });
    const revokeButton = el('button', {
      class: 'button button-danger',
      attrs: { type: 'button' },
      text: '撤销分享',
    });
    revokeButton.disabled = true;

    generateButton.addEventListener('click', async () => {
      setButtonBusy(generateButton, true, '正在生成…');
      try {
        const payload = await api.createShare(planId);
        const share = normalizeShareResponse(payload);
        if (!share.token) throw new Error('服务端未返回分享令牌');
        const url = absoluteShareUrl(share.token, share.url);
        linkInput.value = url;
        openLink.href = url;
        openLink.hidden = false;
        copyButton.disabled = false;
        revokeButton.disabled = false;
        status.textContent = '链接已生成。再次生成会撤销旧链接；撤销后旧链接立即失效。';
        linkInput.focus();
        linkInput.select();
        showToast({ message: '只读分享链接已生成', tone: 'success' });
      } catch (error) {
        toastError(error);
      } finally {
        setButtonBusy(generateButton, false);
      }
    });

    copyButton.addEventListener('click', async () => {
      if (!linkInput.value) return;
      try {
        await navigator.clipboard.writeText(linkInput.value);
        showToast({ message: '分享链接已复制', tone: 'success' });
      } catch {
        linkInput.focus();
        linkInput.select();
        let copied = false;
        try {
          copied = document.execCommand('copy');
        } catch {
          copied = false;
        }
        showToast({
          message: copied ? '分享链接已复制' : '复制失败，请手动选择并复制链接',
          tone: copied ? 'success' : 'warning',
        });
      }
    });

    revokeButton.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: '撤销分享链接？',
        message: '撤销后，已发出的链接会立即失效，且无法恢复。',
        confirmLabel: '撤销分享',
        danger: true,
      });
      if (!confirmed) return;
      revokeButton.disabled = true;
      try {
        await api.revokeShare(planId);
        linkInput.value = '';
        openLink.hidden = true;
        copyButton.disabled = true;
        status.textContent = '分享已撤销，旧链接已立即失效。';
        showToast({ message: '分享已撤销', tone: 'success' });
      } catch (error) {
        revokeButton.disabled = false;
        toastError(error);
      }
    });

    shareDialog = showDialog({
      title: '只读分享',
      description: '生成只读链接，未登录访客也能查看同一份方案文档。',
      content: el('div', { class: 'share-link-box' }, [
        status,
        linkInput,
        el('div', { class: 'prop-actions' }, [generateButton, copyButton, revokeButton, openLink]),
      ]),
      actions: [{ label: '关闭', variant: 'secondary' }],
      onClose: () => {
        shareDialog = null;
      },
    });
  }

  /* ---------- 快捷键说明与全局键盘 ---------- */
  const SHORTCUTS = [
    ['V / W / D / N', '选择 / 墙 / 门 / 窗工具'],
    ['点击两次画墙', '连续画墙，闭合后自动识别房间'],
    ['Ctrl + Z', '撤销（上限 50 步）'],
    ['Ctrl + Shift + Z / Ctrl + Y', '重做'],
    ['Ctrl + S', '保存（409 时选择覆盖或重载）'],
    ['Delete / Backspace', '删除选中的墙体、门窗或家具'],
    ['方向键 / Shift + 方向键', '微调 100 mm / 500 mm'],
    ['R / Shift + R', '旋转选中家具 ±15°'],
    ['0', '适配视图（2D）'],
    ['Esc', '取消当前工具或选择'],
    ['?', '打开本快捷键说明'],
  ];

  function showShortcutsDialog() {
    const content = el('div', { class: 'shortcut-list' }, SHORTCUTS.map(([keys, description]) => (
      el('div', { class: 'shortcut-row' }, [
        el('span', { class: 'kbd', text: keys }),
        el('span', { text: description }),
      ])
    )));
    shortcutsDialog = showDialog({
      title: '键盘快捷键',
      content,
      size: 'lg',
      actions: [{ label: '关闭', variant: 'secondary' }],
      onClose: () => {
        shortcutsDialog = null;
      },
    });
  }

  function toggleSidebar() {
    setSidebarCollapsed(!sidebarCollapsed);
  }

  function setSidebarCollapsed(value) {
    sidebarCollapsed = Boolean(value);
    sidebar.dataset.collapsed = sidebarCollapsed ? 'true' : 'false';
    sidebarToggle.setAttribute('aria-expanded', sidebarCollapsed ? 'false' : 'true');
    sidebarToggle.textContent = sidebarCollapsed ? '展开目录/属性' : '目录/属性';
    if (currentView === '3d' && three) three.resize();
    else canvas?.resize();
  }

  function undo() {
    if (store.undo()) {
      announce('已撤销');
    } else {
      showToast({ message: '没有可撤销的操作', tone: 'info', timeout: 2500 });
    }
  }

  function redo() {
    if (store.redo()) {
      announce('已重做');
    } else {
      showToast({ message: '没有可重做的操作', tone: 'info', timeout: 2500 });
    }
  }

  function commitTitle() {
    try {
      store.setName(titleInput.value);
    } catch (error) {
      toastError(error);
    } finally {
      titleInput.value = store.getPlan().name;
    }
  }

  function hasOpenDialog() {
    return Boolean(document.querySelector('dialog[open]'));
  }

  const globalKeyHandler = (event) => {
    if (disposed || hasOpenDialog() || isTypingTarget(event.target)) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = String(event.key || '').toLowerCase();
    if (modifier && key === 's') {
      event.preventDefault();
      performSave();
      return;
    }
    if (modifier && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (modifier && key === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (event.key === '?') {
      event.preventDefault();
      showShortcutsDialog();
      return;
    }
    if (event.target === canvasElement) return; // 画布内部已处理
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selection) {
        event.preventDefault();
        deleteSelection(selection);
      }
      return;
    }
    if (event.key === 'Escape') {
      selection = null;
      canvas.select(null);
      return;
    }
    const toolKeys = {
      v: 'select', w: 'wall', d: 'door', n: 'window',
    };
    if (toolKeys[key]) {
      event.preventDefault();
      chooseTool(toolKeys[key]);
    }
  };

  /* ---------- 事件绑定 ---------- */
  titleInput.addEventListener('change', commitTitle);
  titleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      titleInput.blur();
    } else if (event.key === 'Escape') {
      titleInput.value = store.getPlan().name;
      titleInput.blur();
    }
  });

  undoButton.addEventListener('click', undo);
  redoButton.addEventListener('click', redo);
  saveButton.addEventListener('click', () => performSave());
  exportButton.addEventListener('click', exportCsv);
  shareButton.addEventListener('click', openShareDialog);
  shortcutsButton.addEventListener('click', showShortcutsDialog);
  retrySaveButton.addEventListener('click', () => {
    const error = store.getState().saveError;
    if (error && error.isConflict) showConflictDialog(error);
    else performSave();
  });
  dismissSaveButton.addEventListener('click', () => {
    store.setSaveError(null);
    refreshChrome();
  });
  deleteButton.addEventListener('click', () => {
    if (selection) deleteSelection(selection);
  });
  syncRoomsButton.addEventListener('click', () => {
    const changed = applyEdit(() => {
      const synced = store.syncRooms();
      showToast({
        message: synced ? '已按墙体闭环同步房间' : '房间已是最新，无需同步',
        tone: synced ? 'success' : 'info',
      });
      return synced;
    });
    if (changed === false) return;
  });
  fitButton.addEventListener('click', () => {
    if (currentView === '2d') canvas.fit();
  });
  tab2d.addEventListener('click', () => setView('2d'));
  tab3d.addEventListener('click', () => setView('3d'));
  orbitButton.addEventListener('click', () => three?.setMode('orbit'));
  walkButton.addEventListener('click', () => three?.setMode('walk'));
  fit3dButton.addEventListener('click', () => three?.fitView());
  sidebarToggle.addEventListener('click', toggleSidebar);
  document.addEventListener('keydown', globalKeyHandler);

  const beforeUnloadHandler = (event) => {
    if (!store.getState().dirty && !saveInFlight) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnloadHandler);

  unsubscribe = store.subscribe((type) => {
    if (disposed) return;
    if (type === 'history' || type === 'replace') {
      scheduleRefresh({ data: true, rebuild3d: currentView === '3d' });
    } else {
      scheduleRefresh({});
    }
  });

  sidebar.dataset.collapsed = 'false';
  setSidebarCollapsed(false);
  refreshChrome();
  refreshObjects();
  refreshProperties();
  updateEmptyState();
  updateViewChrome();
  if (catalogData) {
    catalogPanel.setCatalog(catalogData);
    updateCatalogState();
  } else {
    loadCatalog();
  }

  async function confirmDiscard() {
    if (!store.getState().dirty) return true;
    return confirmDialog({
      title: '放弃未保存修改？',
      message: '当前方案有尚未保存的修改，离开后这些修改会丢失。',
      confirmLabel: '放弃修改并离开',
      danger: true,
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (pendingFrame) cancelAnimationFrame(pendingFrame);
    pendingFrame = 0;
    if (typeof unsubscribe === 'function') unsubscribe();
    document.removeEventListener('keydown', globalKeyHandler);
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    if (shareDialog) {
      try {
        shareDialog.close();
      } catch {
        // 对话框已关闭
      }
      shareDialog = null;
    }
    if (shortcutsDialog) {
      try {
        shortcutsDialog.close();
      } catch {
        // 对话框已关闭
      }
      shortcutsDialog = null;
    }
    disposeThree();
    if (canvas) {
      canvas.destroy();
      canvas = null;
    }
  }

  return {
    store,
    dispose,
    isDirty: () => store.getState().dirty,
    confirmDiscard,
    saveNow: () => performSave(),
  };
}


