import { extractSharePayload } from './api.js';
import { Canvas2D } from './canvas2d.js';
import { normalizeDoc } from './store.js';
import {
  downloadBlob,
  el,
  errorMeta,
  formatDateTime,
  renderError,
  renderLoading,
  setButtonBusy,
  showToast,
} from './ui.js';

function hasContent(doc) {
  return Boolean(doc && (doc.walls?.length || doc.furniture?.length));
}

/**
 * 只读分享视图：GET /api/v1/share/{token} 与 CSV 下载，无任何编辑入口。
 */
export async function createShareView({ api, token, mount, catalogProvider = null }) {
  let disposed = false;
  let canvas = null;
  let three = null;
  let catalog = null;
  let doc = null;
  let view = '2d';
  let threeHost = null;
  let canvasHost = null;
  let stage = null;
  let controls = null;
  let hint = null;
  let threeModulePromise = null;
  const cleanups = [];

  function disposeThree() {
    if (three) {
      three.destroy();
      three = null;
    }
    if (threeHost) threeHost.replaceChildren();
  }

  function dispose() {
    disposed = true;
    disposeThree();
    if (canvas) {
      canvas.destroy();
      canvas = null;
    }
    for (const cleanup of cleanups.splice(0)) cleanup();
  }

  mount.replaceChildren();
  renderLoading(mount, '正在读取只读分享方案…');

  let payload;
  try {
    payload = await api.getShared(token);
  } catch (error) {
    if (disposed) return { dispose };
    if (error.status === 404 || error.code === 'NOT_FOUND') {
      renderError(mount, {
        title: '分享链接无效',
        message: '该分享链接无效或已被撤销。',
        error,
        extraActions: [el('a', { class: 'button button-secondary', href: '#/', text: '打开酷家乐简易版' })],
      });
    } else {
      const retry = () => {
        createShareView({ api, token, mount, catalogProvider });
      };
      renderError(mount, {
        title: '分享方案加载失败',
        message: error.message,
        error,
        onRetry: retry,
        extraActions: [el('a', { class: 'button button-secondary', href: '#/', text: '打开酷家乐简易版' })],
      });
    }
    return { dispose };
  }

  if (disposed) return { dispose };

  const extracted = extractSharePayload(payload);
  if (!extracted) {
    renderError(mount, {
      title: '分享方案数据不完整',
      message: '服务端未返回可查看的方案文档。',
      error: { code: 'VALIDATION_FAILED', requestId: null },
      extraActions: [el('a', { class: 'button button-secondary', href: '#/', text: '打开酷家乐简易版' })],
    });
    return { dispose };
  }

  doc = normalizeDoc(extracted.doc);
  if (doc.schemaVersion > 1) {
    renderError(mount, {
      title: '方案版本不受支持',
      message: `方案 schemaVersion 为 ${doc.schemaVersion}，当前前端仅支持版本 1。`,
      error: { code: 'UNSUPPORTED_SCHEMA_VERSION', requestId: null },
      extraActions: [el('a', { class: 'button button-secondary', href: '#/', text: '打开酷家乐简易版' })],
    });
    return { dispose };
  }

  document.title = `${extracted.name || '共享方案'} · 只读分享 · 酷家乐简易版`;

  const titleId = 'share-title';
  const downloadButton = el('button', {
    class: 'button button-primary',
    attrs: { type: 'button' },
    text: '下载 CSV 清单',
  });
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

  canvasHost = el('div', { class: 'view-host' });
  const canvasElement = el('canvas', {
    class: 'canvas-2d',
    attrs: {
      tabindex: '0',
      'aria-describedby': 'share-canvas-help',
    },
  });
  canvasHost.append(canvasElement);
  threeHost = el('div', { class: 'three-host', attrs: { hidden: 'hidden' } });
  stage = el('div', { class: 'stage share-stage' }, [canvasHost, threeHost]);
  hint = el('div', { class: 'stage-hint', text: '拖动平移 · 滚轮缩放 · 方向键平移（只读）' });
  stage.append(hint);

  controls = el('div', { class: 'view-controls' });
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
  const fitButton = el('button', {
    class: 'tool-button',
    attrs: { type: 'button' },
    text: '适配视图',
  });
  controls.append(orbitButton, walkButton, fitButton);
  controls.hidden = true;

  const stageBadge = el('div', { class: 'view-badge', text: '只读 · 同一份方案文档' });
  stage.append(stageBadge);
  stage.append(controls);

  const emptyOverlay = hasContent(doc)
    ? null
    : el('div', { class: 'stage-empty' }, [
      el('p', { class: 'stage-empty-title', text: '此方案暂无户型' }),
      el('p', { class: 'stage-empty-text', text: '分享者尚未绘制墙体或放置家具。' }),
    ]);
  if (emptyOverlay) stage.append(emptyOverlay);

  const header = el('header', { class: 'share-header' }, [
    el('div', {}, [
      el('div', { class: 'toolbar' }, [
        el('span', { class: 'badge badge-readonly', text: '只读分享' }),
        el('span', { class: 'muted', text: extracted.updatedAt ? `更新于 ${formatDateTime(extracted.updatedAt)}` : '' }),
      ]),
      el('h1', { id: titleId, class: 'share-title', text: extracted.name || '共享方案' }),
    ]),
    el('div', { class: 'share-actions' }, [downloadButton]),
  ]);

  const tabs = el('div', { class: 'toolbar', attrs: { 'aria-label': '视图切换' } }, [
    el('div', { class: 'view-tabs' }, [tab2d, tab3d]),
  ]);

  const help = el('p', {
    id: 'share-canvas-help',
    class: 'visually-hidden',
    text: '只读 2D 画布。拖动可平移，滚轮或加减号缩放，方向键平移，0 键适配视图。只读模式不提供任何编辑操作。',
  });

  const shell = el('div', { class: 'share-shell' }, [
    header,
    el('div', { class: 'share-stage-panel' }, [
      el('div', { class: 'stage-toolbar' }, [tabs, el('span', { class: 'toolbar-spacer' }), el('span', { class: 'muted', text: '只读' })]),
      stage,
    ]),
    el('p', { class: 'share-note', text: '这是只读分享：可以查看 2D/3D 与下载 CSV，不能修改方案。分享令牌撤销后，此链接立即失效。' }),
    help,
  ]);
  mount.replaceChildren(shell);

  function setModeButtons(mode) {
    orbitButton.setAttribute('aria-pressed', mode === 'orbit' ? 'true' : 'false');
    walkButton.setAttribute('aria-pressed', mode === 'walk' ? 'true' : 'false');
    hint.textContent = mode === 'walk'
      ? 'WASD 移动 · 鼠标观察 · Esc 释放鼠标 · 切回轨道视角'
      : '拖拽旋转 · 滚轮缩放 · Shift 或右键拖拽平移';
  }

  async function ensureThree() {
    if (three) return three;
    if (!threeModulePromise) threeModulePromise = import('./three-view.js');
    const module = await threeModulePromise;
    if (disposed) return null;
    const ThreeView = module.ThreeView || module.default;
    three = new ThreeView({
      container: threeHost,
      getDoc: () => doc,
      getCatalog: () => catalog,
      readonly: true,
      onModeChange: (mode) => setModeButtons(mode),
    });
    return three;
  }

  async function showView(nextView) {
    view = nextView;
    tab2d.setAttribute('aria-pressed', view === '2d' ? 'true' : 'false');
    tab3d.setAttribute('aria-pressed', view === '3d' ? 'true' : 'false');
    controls.hidden = view !== '3d';
    if (view === '2d') {
      disposeThree();
      canvasHost.hidden = false;
      threeHost.hidden = true;
      hint.textContent = '拖动平移 · 滚轮缩放 · 方向键平移（只读）';
      canvas?.refresh();
      return;
    }
    canvasHost.hidden = true;
    threeHost.hidden = false;
    const instance = await ensureThree();
    if (instance) {
      instance.resize();
      instance.rebuild();
    }
  }

  tab2d.addEventListener('click', () => {
    showView('2d').catch((error) => showToast({ message: '切换视图失败', tone: 'error', error }));
  });
  tab3d.addEventListener('click', () => {
    showView('3d').catch((error) => showToast({ message: '3D 初始化失败', tone: 'error', error }));
  });
  orbitButton.addEventListener('click', () => three?.setMode('orbit'));
  walkButton.addEventListener('click', () => three?.setMode('walk'));
  fitButton.addEventListener('click', () => three?.fitView());

  downloadButton.addEventListener('click', async () => {
    setButtonBusy(downloadButton, true, '正在导出…');
    try {
      const result = await api.exportSharedCsv(token);
      downloadBlob(result.blob, result.filename || 'share.csv');
      showToast({ message: 'CSV 已开始下载', tone: 'success' });
    } catch (error) {
      showToast({ message: 'CSV 导出失败', tone: 'error', error });
    } finally {
      setButtonBusy(downloadButton, false);
    }
  });

  canvas = new Canvas2D({
    canvas: canvasElement,
    getDoc: () => doc,
    getCatalog: () => catalog,
    readonly: true,
  });

  if (catalogProvider) {
    Promise.resolve()
      .then(() => catalogProvider())
      .then((nextCatalog) => {
        if (disposed || !nextCatalog) return;
        catalog = nextCatalog;
        canvas?.refresh();
        three?.rebuild();
      })
      .catch(() => {
        // 目录不可用时 3D 使用内置的渲染兜底色，不影响只读查看。
      });
  }

  return { dispose };
}
