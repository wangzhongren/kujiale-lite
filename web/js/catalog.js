import { el, showToast, uniqueId } from './ui.js';

const FALLBACK_COLORS = [
  '#c49a6c', '#d9d6cf', '#a9a7a1', '#8b5a3c', '#f3eee6', '#b9c6b3', '#a87b56', '#cfc6b8',
];

const MATERIAL_COLORS = {
  'floor-oak': '#c49a6c',
  'floor-walnut': '#8b5a3c',
  'floor-tile': '#d9d6cf',
  'floor-stone': '#a9a7a1',
  'paint-warm-white': '#f3eee6',
  'paint-sage': '#b9c6b3',
  'wall-wood': '#a87b56',
  'wall-terrazzo': '#cfc6b8',
};

const DIMENSION_FALLBACKS = {
  sofa: [1800, 850, 800],
  armchair: [850, 850, 900],
  'coffee-table': [1000, 600, 420],
  table: [1400, 800, 750],
  'dining-table': [1400, 800, 750],
  desk: [1200, 600, 750],
  chair: [480, 500, 900],
  bed: [1800, 2000, 600],
  wardrobe: [1600, 600, 2100],
  cabinet: [1000, 450, 800],
  shelf: [900, 350, 1800],
  'tv-stand': [1600, 400, 500],
  plant: [500, 500, 1200],
  rug: [2000, 1400, 20],
  lamp: [400, 400, 1500],
};

const COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\([^)]{1,80}\)|hsla?\([^)]{1,80}\)|[a-z]{3,24})$/i;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function hashColor(seed) {
  let hash = 0;
  const text = String(seed || '');
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

export function inferKind(id, declared) {
  const source = `${declared || ''} ${id || ''}`.toLowerCase();
  const kinds = [
    'tv-stand', 'coffee-table', 'dining-table', 'armchair', 'wardrobe', 'cabinet',
    'shelf', 'table', 'chair', 'sofa', 'bed', 'plant', 'rug', 'lamp', 'desk',
  ];
  for (const kind of kinds) {
    if (source.includes(kind)) return kind;
  }
  return 'generic';
}

function pickColor(item, id) {
  const candidate = item.color || item.hex || item.value || MATERIAL_COLORS[id];
  if (typeof candidate === 'string' && COLOR_PATTERN.test(candidate.trim())) return candidate.trim();
  return hashColor(id);
}

function normalizeMaterial(raw, kind) {
  if (!isObject(raw) || raw.id === undefined || raw.id === null) return null;
  const id = String(raw.id);
  return {
    ...raw,
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    kind,
    color: pickColor(raw, id),
  };
}

function normalizeFurniture(raw) {
  if (!isObject(raw) || raw.id === undefined || raw.id === null) return null;
  const id = String(raw.id);
  const kind = inferKind(id, raw.kind || raw.category || raw.type);
  const fallback = DIMENSION_FALLBACKS[kind] || [800, 800, 700];
  const size = isObject(raw.size) ? raw.size : {};
  const dims = Array.isArray(raw.dims) ? raw.dims : [];
  const width = numberOr(raw.width, numberOr(size.width, numberOr(dims[0], fallback[0])));
  const depth = numberOr(raw.depth, numberOr(size.depth, numberOr(dims[1], fallback[1])));
  const height = numberOr(raw.height, numberOr(size.height, numberOr(dims[2], fallback[2])));
  return {
    ...raw,
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    kind,
    color: pickColor(raw, id),
    width: Math.max(50, width),
    depth: Math.max(50, depth),
    height: Math.max(10, height),
  };
}

/**
 * 目录响应归一化（兼容 materials.floor/wall、floorMaterials/wallMaterials、扁平数组）。
 */
export function normalizeCatalog(raw) {
  const source = isObject(raw) ? raw : {};
  let furnitureSource = [];
  if (Array.isArray(source.furniture)) furnitureSource = source.furniture;
  else if (Array.isArray(source.furnitureItems)) furnitureSource = source.furnitureItems;
  else if (Array.isArray(source.items)) furnitureSource = source.items;

  let floorSource = [];
  let wallSource = [];

  if (Array.isArray(source.materials)) {
    for (const material of source.materials) {
      // 后端 /catalog 的材质数组使用 kind: "floor" | "wall"。
      const type = String(
        material?.kind || material?.type || material?.surface || material?.category || '',
      ).toLowerCase();
      if (type.includes('floor') || type.includes('地面')) floorSource.push(material);
      else if (type.includes('wall') || type.includes('墙')) wallSource.push(material);
    }
  } else if (isObject(source.materials)) {
    floorSource = [
      ...(Array.isArray(source.materials.floor) ? source.materials.floor : []),
      ...(Array.isArray(source.materials.floors) ? source.materials.floors : []),
    ];
    wallSource = [
      ...(Array.isArray(source.materials.wall) ? source.materials.wall : []),
      ...(Array.isArray(source.materials.walls) ? source.materials.walls : []),
    ];
  }
  if (!floorSource.length && Array.isArray(source.floorMaterials)) floorSource = source.floorMaterials;
  if (!wallSource.length && Array.isArray(source.wallMaterials)) wallSource = source.wallMaterials;

  const furniture = furnitureSource.map(normalizeFurniture).filter(Boolean);
  const floorMaterials = floorSource.map((item) => normalizeMaterial(item, 'floor')).filter(Boolean);
  const wallMaterials = wallSource.map((item) => normalizeMaterial(item, 'wall')).filter(Boolean);

  const byId = new Map();
  for (const item of furniture) byId.set(item.id, item);
  for (const item of floorMaterials) byId.set(item.id, item);
  for (const item of wallMaterials) byId.set(item.id, item);

  return {
    furniture,
    floorMaterials,
    wallMaterials,
    materials: [...floorMaterials, ...wallMaterials],
    byId,
    counts: {
      furniture: furniture.length,
      materials: floorMaterials.length + wallMaterials.length,
      floor: floorMaterials.length,
      wall: wallMaterials.length,
    },
  };
}

export function findFurniture(catalog, id) {
  return catalog?.byId?.get(id) || null;
}

export function findMaterial(catalog, id) {
  const item = catalog?.byId?.get(id) || null;
  return item && (item.kind === 'floor' || item.kind === 'wall') ? item : null;
}

export function materialColor(catalog, id, fallback = '#e7e2d8') {
  return findMaterial(catalog, id)?.color || fallback;
}

export function furnitureDims(item) {
  return {
    width: numberOr(item?.width, 800),
    depth: numberOr(item?.depth, 800),
    height: numberOr(item?.height, 700),
  };
}

/**
 * 家具/材质目录面板。
 * update({rooms, materials, selectedRoomId, activeFurnitureId})：就地更新状态，避免焦点丢失。
 */
export function createCatalogPanel({
  container,
  catalog = null,
  onSelectFurniture = null,
  onApplyMaterial = null,
  onClearMaterial = null,
  onRoomChange = null,
  onRetry = null,
}) {
  const titleId = uniqueId('catalog-title');
  let currentCatalog = catalog;
  let roomId = null;
  let rooms = [];
  let materials = { floor: {}, wall: {} };
  let activeFurnitureId = null;
  let furnitureButtons = new Map();
  let materialButtons = [];
  let roomSelect = null;
  let roomHint = null;
  let floorClear = null;
  let wallClear = null;
  let body = null;
  let statusLine = null;

  const panel = el('section', {
    class: 'panel',
    attrs: { 'aria-labelledby': titleId },
  });
  container.replaceChildren(panel);

  function renderShell() {
    const counts = currentCatalog?.counts;
    statusLine = el('p', {
      class: 'muted',
      text: counts
        ? `${counts.furniture} 件家具 · ${counts.materials} 种材质`
        : '目录加载中…',
    });
    body = el('div', { class: 'panel-body' });
    panel.replaceChildren(
      el('div', { class: 'panel-header' }, [
        el('h2', { id: titleId, class: 'panel-title', text: '家具与材质' }),
        statusLine,
      ]),
      body,
    );
    if (!currentCatalog) showLoading();
  }

  function showLoading() {
    if (!body) return;
    body.replaceChildren(el('div', { class: 'state state-loading', attrs: { role: 'status' } }, [
      el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }),
      el('p', { class: 'state-text', text: '正在加载家具与材质目录…' }),
    ]));
  }

  function renderCatalog() {
    if (!currentCatalog) {
      uiErrorState();
      return;
    }
    furnitureButtons = new Map();
    materialButtons = [];
    const furnitureSection = el('div', { class: 'panel-section' }, [
      el('div', { class: 'section-title' }, [
        el('span', { text: '家具' }),
        el('span', { class: 'muted', text: '点击后到画布放置' }),
      ]),
      currentCatalog.furniture.length
        ? el('div', { class: 'catalog-grid' }, currentCatalog.furniture.map((item) => {
          const button = el('button', {
            class: 'catalog-item',
            attrs: { type: 'button', 'aria-pressed': item.id === activeFurnitureId ? 'true' : 'false' },
          }, [
            el('span', { class: 'catalog-name', text: item.name }),
            el('span', {
              class: 'catalog-dims',
              text: `${Math.round(item.width)}×${Math.round(item.depth)} mm`,
            }),
            el('span', {
              class: 'swatch',
              attrs: { 'aria-hidden': 'true' },
              props: { style: null },
            }),
          ]);
          button.lastElementChild.style.backgroundColor = item.color;
          button.addEventListener('click', () => {
            if (typeof onSelectFurniture === 'function') onSelectFurniture(item);
          });
          furnitureButtons.set(item.id, button);
          return button;
        }))
        : el('p', { class: 'hint-text', text: '目录未提供家具。' }),
    ]);

    roomSelect = el('select', {
      class: 'select',
      attrs: { id: uniqueId('room-select'), 'aria-label': '材质应用的房间' },
    });
    const roomSelectId = roomSelect.id;
    roomSelect.addEventListener('change', () => {
      roomId = roomSelect.value || null;
      if (typeof onRoomChange === 'function') onRoomChange(roomId);
      refreshMaterialState();
    });
    roomHint = el('p', { class: 'hint-text' });
    const roomWrap = el('div', { class: 'room-select-wrap' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', attrs: { for: roomSelectId }, text: '材质应用房间' }),
        roomSelect,
        roomHint,
      ]),
    ]);

    const buildMaterials = (kind, label, items) => {
      const title = el('div', { class: 'section-title' }, [
        el('span', { text: label }),
        el('button', {
          class: 'button button-ghost button-small',
          attrs: { type: 'button' },
          text: '清除',
          on: {
            click: () => {
              if (!roomId) return;
              if (typeof onClearMaterial === 'function') onClearMaterial(kind, roomId);
            },
          },
        }),
      ]);
      const grid = el('div', { class: 'material-grid' });
      for (const item of items) {
        const button = el('button', {
          class: 'swatch-button',
          attrs: { type: 'button', 'aria-pressed': 'false', title: item.name },
        }, [
          el('span', { class: 'swatch', attrs: { 'aria-hidden': 'true' } }),
          el('span', { class: 'swatch-name', text: item.name }),
        ]);
        button.firstElementChild.style.backgroundColor = item.color;
        button.addEventListener('click', () => {
          if (!roomId) {
            showToast({ message: '请先选择一个房间，再应用材质', tone: 'warning' });
            return;
          }
          if (typeof onApplyMaterial === 'function') onApplyMaterial(kind, roomId, item.id);
        });
        materialButtons.push({ kind, id: item.id, button });
        grid.append(button);
      }
      if (!items.length) grid.append(el('p', { class: 'hint-text', text: '目录未提供该类材质。' }));
      const clear = title.querySelector('button');
      if (kind === 'floor') floorClear = clear;
      else wallClear = clear;
      return el('div', { class: 'panel-section' }, [title, grid]);
    };

    body.replaceChildren(
      furnitureSection,
      el('div', { class: 'panel-section' }, [
        el('div', { class: 'section-title' }, [el('span', { text: '地面与墙面材质' })]),
        roomWrap,
        buildMaterials('floor', '地面材质', currentCatalog.floorMaterials),
        buildMaterials('wall', '墙面材质', currentCatalog.wallMaterials),
      ]),
    );
    refreshRoomOptions();
    refreshMaterialState();
  }

  function uiErrorState() {
    body.replaceChildren(el('div', { class: 'state state-error', attrs: { role: 'alert' } }, [
      el('p', { class: 'state-text', text: '家具与材质目录加载失败。' }),
      el('button', {
        class: 'button button-primary',
        attrs: { type: 'button' },
        text: '重试',
        on: {
          click: () => {
            if (typeof onRetry === 'function') onRetry();
          },
        },
      }),
    ]));
  }

  function refreshRoomOptions() {
    if (!roomSelect) return;
    const signature = rooms.map((room) => `${room.id}:${room.name}`).join('|');
    if (signature !== (roomSelect.dataset.signature || '')) {
      roomSelect.replaceChildren();
      roomSelect.dataset.signature = signature;
      if (!rooms.length) {
        roomSelect.append(el('option', { value: '', text: '暂无房间' }));
      } else {
        for (const room of rooms) {
          roomSelect.append(el('option', {
            value: room.id,
            text: room.name || '未命名房间',
          }));
        }
      }
    }
    if (!rooms.length) {
      roomSelect.disabled = true;
      roomId = null;
      roomHint.textContent = '先用墙体围成闭合房间，或点击「同步房间」。';
      return;
    }
    roomSelect.disabled = false;
    if (!rooms.some((room) => room.id === roomId)) {
      roomId = rooms[0].id;
    }
    roomSelect.value = roomId;
    roomHint.textContent = '2D 中点击房间也可切换应用对象。';
  }

  function refreshMaterialState() {
    if (!roomSelect) return;
    for (const entry of materialButtons) {
      const bucket = entry.kind === 'floor' ? materials.floor : materials.wall;
      const active = Boolean(roomId) && bucket?.[roomId] === entry.id;
      entry.button.setAttribute('aria-pressed', active ? 'true' : 'false');
      entry.button.disabled = !roomId;
    }
    const floorValue = roomId ? materials.floor?.[roomId] : null;
    const wallValue = roomId ? materials.wall?.[roomId] : null;
    if (floorClear) floorClear.disabled = !roomId || !floorValue;
    if (wallClear) wallClear.disabled = !roomId || !wallValue;
    for (const [id, button] of furnitureButtons) {
      button.setAttribute('aria-pressed', id === activeFurnitureId ? 'true' : 'false');
    }
  }

  function update(nextState = {}) {
    if (nextState.rooms) {
      rooms = nextState.rooms;
      const ids = rooms.map((room) => room.id).join('|');
      const previousIds = roomSelect?.dataset.ids || '';
      if (ids !== previousIds && roomSelect) roomSelect.dataset.ids = ids;
    }
    if (nextState.materials) materials = nextState.materials;
    if (nextState.selectedRoomId && rooms.some((room) => room.id === nextState.selectedRoomId)) {
      roomId = nextState.selectedRoomId;
    }
    if ('activeFurnitureId' in nextState) activeFurnitureId = nextState.activeFurnitureId;
    refreshRoomOptions();
    refreshMaterialState();
  }

  function setCatalog(nextCatalog) {
    currentCatalog = nextCatalog;
    renderShell();
    renderCatalog();
  }

  renderShell();
  if (currentCatalog) renderCatalog();

  return {
    element: panel,
    update,
    setCatalog,
    showError() {
      uiErrorState();
    },
    showLoading,
    getRoomId() {
      return roomId;
    },
  };
}
