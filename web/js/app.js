import { createApi } from './api.js';
import { normalizeCatalog } from './catalog.js';
import { createEditorView } from './editor.js';
import { createShareView } from './share.js';
import {
  announce,
  confirmDialog,
  el,
  errorMeta,
  field,
  formatCount,
  formatDateTime,
  promptDialog,
  renderEmpty,
  renderError,
  renderLoading,
  setButtonBusy,
  showToast,
} from './ui.js';

const headerEl = document.getElementById('site-header');
const mainEl = document.getElementById('main');

let currentUser = null;
let activeView = null;
let activeRouteKey = '';
let renderedUrl = window.location.href;
let navigating = false;
let pendingNavigation = false;
let authMode = 'login';
let catalogCache = null;
let catalogPromise = null;
let unauthorizedNotice = '';

const api = createApi({
  onUnauthorized: () => handleUnauthorized(),
});

function catalogProvider() {
  if (catalogCache) return Promise.resolve(catalogCache);
  if (!catalogPromise) {
    catalogPromise = api.getCatalog()
      .then((raw) => {
        catalogCache = normalizeCatalog(raw);
        return catalogCache;
      })
      .finally(() => {
        catalogPromise = null;
      });
  }
  return catalogPromise;
}

function handleUnauthorized() {
  const route = parseRoute();
  if (route.name === 'share') return;
  currentUser = null;
  unauthorizedNotice = '登录状态已失效，请重新登录。';
  showToast({ message: unauthorizedNotice, tone: 'warning' });
  if (window.location.hash === '#/' || window.location.hash === '') navigate();
  else window.location.hash = '#/';
}

/* ------------------------------- 路由 ------------------------------- */

function parseRoute() {
  const hash = window.location.hash || '';
  const shareHash = /^#\/s\/([^/?#]+)\/?$/.exec(hash);
  if (shareHash) {
    return { name: 'share', token: decodeURIComponent(shareHash[1]) };
  }
  const planHash = /^#\/plans\/([0-9]+)\/?$/.exec(hash);
  if (planHash) {
    return { name: 'editor', id: planHash[1] };
  }
  if (hash && hash !== '#' && hash !== '#/') {
    return { name: 'home' };
  }

  const path = window.location.pathname || '/';
  const sharePath = /^\/share\/([^/]+)\/?$/.exec(path);
  if (sharePath) {
    return { name: 'share', token: decodeURIComponent(sharePath[1]) };
  }
  const planPath = /^\/plans\/([0-9]+)\/?$/.exec(path);
  if (planPath) {
    return { name: 'editor', id: planPath[1] };
  }
  return { name: 'home' };
}

function routeKey(route) {
  if (route.name === 'share') return `share:${route.token}`;
  if (route.name === 'editor') return `editor:${route.id}`;
  return 'home';
}

function goHome() {
  if (window.location.hash === '#/' || window.location.hash === '') navigate();
  else window.location.hash = '#/';
}

async function navigate(force = false) {
  if (navigating) {
    pendingNavigation = true;
    return;
  }
  const route = parseRoute();
  const key = routeKey(route);
  if (!force && key === activeRouteKey && activeView) return;

  navigating = true;
  try {
    if (activeView) {
      const dirty = typeof activeView.isDirty === 'function' && activeView.isDirty();
      if (dirty) {
        const canLeave = typeof activeView.confirmDiscard === 'function'
          ? await activeView.confirmDiscard()
          : false;
        if (!canLeave) {
          window.history.replaceState(null, '', renderedUrl);
          return;
        }
      }
      if (typeof activeView.dispose === 'function') activeView.dispose();
      activeView = null;
      activeRouteKey = '';
    }
    await renderRoute(route);
  } catch (error) {
    renderFatal(error);
  } finally {
    navigating = false;
    if (pendingNavigation) {
      pendingNavigation = false;
      navigate();
    }
  }
}

async function renderRoute(route) {
  if (route.name === 'share') {
    renderHeader({ user: null, share: true });
    mainEl.replaceChildren();
    renderLoading(mainEl, '正在准备只读分享…');
    const view = await createShareView({
      api,
      token: route.token,
      mount: mainEl,
      catalogProvider,
    });
    activeView = view || emptyView();
    activeRouteKey = routeKey(route);
    renderedUrl = window.location.href;
    return;
  }

  const user = await ensureUser();
  if (!user) return;

  renderHeader({ user });
  if (route.name === 'editor') {
    const view = await createEditorView({
      mount: mainEl,
      api,
      planId: route.id,
      catalogProvider,
    });
    activeView = view || emptyView();
    activeRouteKey = routeKey(route);
    renderedUrl = window.location.href;
    return;
  }

  activeView = renderPlanList(user);
  activeRouteKey = 'home';
  renderedUrl = window.location.href;
}

function emptyView() {
  return {
    dispose() {},
    isDirty: () => false,
    confirmDiscard: async () => true,
  };
}

function renderFatal(error) {
  renderHeader({ user: currentUser });
  renderError(mainEl, {
    title: '应用启动失败',
    message: error && error.message ? error.message : '无法连接本地服务',
    error,
    onRetry: () => navigate(true),
    retryLabel: '重试',
  });
  activeView = emptyView();
  activeRouteKey = 'fatal';
  renderedUrl = window.location.href;
}

async function ensureUser() {
  if (currentUser) return currentUser;
  try {
    const payload = await api.me();
    currentUser = payload && payload.user ? payload.user : null;
    if (!currentUser) throw new Error('服务端未返回当前用户');
    return currentUser;
  } catch (error) {
    if (error && (error.status === 401 || error.isAuthError)) {
      renderAuthView({ message: unauthorizedNotice });
      unauthorizedNotice = '';
      return null;
    }
    renderFatal(error);
    return null;
  }
}

/* ------------------------------- 头部 ------------------------------- */

function renderHeader({ user = currentUser, share = false } = {}) {
  if (!headerEl) return;
  const brand = el('a', { class: 'brand', href: '/#/' }, [
    el('span', { class: 'brand-name', text: '酷家乐简易版' }),
    el('span', { class: 'brand-tagline', text: '本地 2D / 3D 户型工具' }),
  ]);
  const nav = el('div', { class: 'header-nav' });

  if (user) {
    nav.append(el('span', { class: 'user-chip' }, [
      el('span', { class: 'user-chip-name', text: user.username || '已登录' }),
      el('span', { class: 'user-chip-role', text: '账号' }),
    ]));
    const logoutButton = el('button', {
      class: 'button button-secondary button-small',
      attrs: { type: 'button' },
      text: '退出登录',
    });
    logoutButton.addEventListener('click', () => handleLogout(logoutButton));
    nav.append(logoutButton);
  } else if (share) {
    nav.append(el('a', {
      class: 'button button-secondary button-small',
      href: '/#/',
      text: '登录 / 注册',
    }));
  }

  headerEl.replaceChildren(brand, el('span', { class: 'header-spacer' }), nav);
}

async function handleLogout(button) {
  if (activeView && typeof activeView.isDirty === 'function' && activeView.isDirty()) {
    const canLeave = await activeView.confirmDiscard();
    if (!canLeave) return;
  }
  setButtonBusy(button, true, '退出中…');
  try {
    await api.logout();
  } catch (error) {
    if (!(error && (error.isAuthError || error.status === 401))) {
      showToast({ message: '退出登录请求失败，本地会话视图已清理', tone: 'warning', error });
    }
  }
  currentUser = null;
  if (activeView) {
    if (typeof activeView.dispose === 'function') activeView.dispose();
    activeView = null;
    activeRouteKey = '';
  }
  showToast({ message: '已退出登录', tone: 'success' });
  goHome();
}

/* ------------------------------- 登录 / 注册 ------------------------------- */

function renderAuthView({ message = '', mode = authMode } = {}) {
  authMode = mode === 'register' ? 'register' : 'login';
  renderHeader({ user: null });
  document.title = '登录 · 酷家乐简易版';

  const loginTab = el('button', {
    class: 'tab',
    attrs: { type: 'button', role: 'tab', 'aria-selected': authMode === 'login' ? 'true' : 'false' },
    text: '登录',
  });
  const registerTab = el('button', {
    class: 'tab',
    attrs: { type: 'button', role: 'tab', 'aria-selected': authMode === 'register' ? 'true' : 'false' },
    text: '注册',
  });
  const tabs = el('div', {
    class: 'view-tabs',
    attrs: { role: 'tablist', 'aria-label': '登录或注册' },
  }, [loginTab, registerTab]);
  const formHost = el('div', { attrs: { role: 'tabpanel' } });
  const note = message
    ? el('p', { class: 'badge badge-error', attrs: { role: 'status' }, text: message })
    : null;

  const card = el('section', { class: 'auth-card', attrs: { 'aria-label': '账号登录与注册' } }, [
    el('h1', { class: 'auth-title', text: authMode === 'login' ? '登录酷家乐简易版' : '创建本地账号' }),
    el('p', {
      class: 'auth-subtitle',
      text: '登录后可创建、保存与分享自己的户型方案。',
    }),
    note,
    tabs,
    formHost,
    el('p', {
      class: 'auth-note',
      text: '本地单机应用：账号与方案仅保存在本机 SQLite；方案接口按账号隔离。',
    }),
  ]);

  const wrap = el('div', { class: 'auth-wrap' }, [card]);
  mainEl.replaceChildren(wrap);

  function setMode(nextMode) {
    authMode = nextMode;
    loginTab.setAttribute('aria-selected', authMode === 'login' ? 'true' : 'false');
    registerTab.setAttribute('aria-selected', authMode === 'register' ? 'true' : 'false');
    card.querySelector('.auth-title').textContent = authMode === 'login'
      ? '登录酷家乐简易版'
      : '创建本地账号';
    renderForm();
  }

  function renderForm() {
    const isRegister = authMode === 'register';
    formHost.replaceChildren();
    const username = el('input', {
      class: 'input',
      type: 'text',
      maxLength: 32,
      autocomplete: 'username',
      attrs: { required: 'true', spellcheck: 'false' },
    });
    const password = el('input', {
      class: 'input',
      type: 'password',
      maxLength: 128,
      autocomplete: isRegister ? 'new-password' : 'current-password',
      attrs: { required: 'true' },
    });
    const error = el('p', { class: 'field-error', attrs: { role: 'alert' } });
    const meta = el('p', { class: 'error-meta', attrs: { role: 'status' } });
    meta.hidden = true;
    const submit = el('button', {
      class: 'button button-primary auth-submit',
      attrs: { type: 'submit' },
      text: isRegister ? '注册并登录' : '登录',
    });

    const form = el('form', {
      class: 'auth-form',
      attrs: { novalidate: 'true' },
    }, [
      field({
        label: '用户名',
        control: username,
        help: '3–32 位字母、数字、下划线、点、连字符或汉字',
      }),
      field({
        label: '密码',
        control: password,
        help: isRegister ? '至少 8 位；不能是常见弱口令或重复字符' : '请输入注册时的密码',
      }),
      error,
      meta,
      submit,
    ]);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      meta.hidden = true;
      const usernameValue = username.value.trim();
      const passwordValue = password.value;

      if (!usernameValue) {
        error.textContent = '请输入用户名';
        username.focus();
        return;
      }
      if (Array.from(usernameValue).length < 3 || Array.from(usernameValue).length > 32) {
        error.textContent = '用户名需为 3–32 位';
        username.focus();
        return;
      }
      if (!passwordValue) {
        error.textContent = '请输入密码';
        password.focus();
        return;
      }
      if (isRegister && passwordValue.length < 8) {
        error.textContent = '注册密码至少需要 8 个字符';
        password.focus();
        return;
      }

      setButtonBusy(submit, true, isRegister ? '正在注册…' : '正在登录…');
      try {
        if (isRegister) {
          await api.register(usernameValue, passwordValue);
        }
        await api.login(usernameValue, passwordValue);
        const payload = await api.me();
        currentUser = payload && payload.user ? payload.user : null;
        if (!currentUser) throw new Error('登录成功但未返回用户信息');
        unauthorizedNotice = '';
        showToast({
          message: isRegister ? '注册并登录成功' : '登录成功',
          tone: 'success',
        });
        announce('登录成功，正在打开方案列表');
        goHome();
      } catch (requestError) {
        error.textContent = requestError && requestError.message
          ? requestError.message
          : '登录失败，请重试';
        const metaText = errorMeta(requestError);
        if (metaText) {
          meta.textContent = metaText;
          meta.hidden = false;
        }
        const fieldName = requestError && requestError.details
          ? requestError.details.field
          : null;
        if (fieldName === 'username') username.focus();
        else if (fieldName === 'password') password.focus();
        announce(error.textContent);
      } finally {
        setButtonBusy(submit, false);
      }
    });

    formHost.append(form);
    window.setTimeout(() => username.focus(), 0);
  }

  loginTab.addEventListener('click', () => setMode('login'));
  registerTab.addEventListener('click', () => setMode('register'));
  renderForm();

  activeView = emptyView();
  activeRouteKey = 'auth';
  renderedUrl = window.location.href;
}

/* ------------------------------- 方案列表 ------------------------------- */

function makeNewPlanButton() {
  const button = el('button', {
    class: 'button button-primary',
    attrs: { type: 'button' },
    text: '新建方案',
  });
  button.addEventListener('click', createPlanFlow);
  return button;
}

function makeSampleButton() {
  const button = el('button', {
    class: 'button button-secondary',
    attrs: { type: 'button' },
    text: '从样板间新建',
  });
  button.addEventListener('click', createSampleFlow);
  return button;
}

async function createPlanFlow() {
  const name = await promptDialog({
    title: '新建方案',
    label: '方案名称',
    value: '未命名方案',
    maxLength: 80,
    confirmLabel: '创建',
    help: '服务端会创建一个 4000×3000 mm（12.00 m²）的默认房间，可继续编辑。',
  });
  if (!name) return;
  try {
    const plan = await api.createPlan({ name });
    if (!plan || !plan.id) throw new Error('服务端未返回方案 id');
    showToast({ message: '方案已创建', tone: 'success' });
    window.location.hash = `#/plans/${plan.id}`;
  } catch (error) {
    showToast({ message: '新建方案失败', tone: 'error', error });
  }
}

async function createSampleFlow() {
  try {
    const sample = await api.getSample();
    if (!sample || !sample.doc) throw new Error('样板间数据不完整');
    const plan = await api.createPlan({
      name: sample.name || '样板间',
      doc: sample.doc,
    });
    if (!plan || !plan.id) throw new Error('服务端未返回方案 id');
    showToast({ message: '已从样板间创建方案', tone: 'success' });
    window.location.hash = `#/plans/${plan.id}`;
  } catch (error) {
    showToast({ message: '从样板间新建失败', tone: 'error', error });
  }
}

function renderPlanList(user) {
  let disposed = false;
  let page = 1;
  let pageSize = 20;
  let query = '';
  let requestSeq = 0;
  let currentItems = [];

  document.title = '我的方案 · 酷家乐简易版';

  const searchInput = el('input', {
    class: 'input',
    type: 'search',
    placeholder: '搜索方案名称',
    maxLength: 80,
    attrs: { 'aria-label': '搜索方案名称' },
  });
  const searchButton = el('button', {
    class: 'button button-secondary',
    attrs: { type: 'submit' },
    text: '搜索',
  });
  const searchForm = el('form', {
    class: 'search-form',
    attrs: { role: 'search' },
  }, [searchInput, searchButton]);
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    query = searchInput.value.trim();
    page = 1;
    load();
  });

  const status = el('div', {
    class: 'list-status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  const content = el('div', { class: 'list-content' });

  const shell = el('div', { class: 'list-shell' }, [
    el('div', { class: 'list-header' }, [
      el('div', {}, [
        el('h1', { class: 'list-heading', text: '我的方案' }),
        el('p', {
          class: 'list-subheading',
          text: `${user.username || '当前账号'} · 方案按账号隔离，列表默认每页 20 条`,
        }),
      ]),
      el('div', { class: 'list-toolbar' }, [
        searchForm,
        makeNewPlanButton(),
        makeSampleButton(),
      ]),
    ]),
    status,
    content,
  ]);
  mainEl.replaceChildren(shell);

  function renderItems(items, total, totalPages) {
    currentItems = items;
    if (!items.length) {
      renderEmpty(content, {
        title: query ? '没有匹配的方案' : '还没有方案',
        message: query
          ? '换个关键词试试，或清空搜索查看全部方案。'
          : '新建一个空白方案，或从内置样板间开始体验两间房间。',
        actions: [makeNewPlanButton(), makeSampleButton()],
      });
      return;
    }

    const grid = el('div', { class: 'plan-grid' }, items.map((item) => {
      const deleteButton = el('button', {
        class: 'button button-danger button-small',
        attrs: { type: 'button', 'aria-label': `删除方案 ${item.name || ''}` },
        text: '删除',
      });
      deleteButton.addEventListener('click', () => deletePlan(item, deleteButton));
      return el('article', { class: 'plan-card' }, [
        el('div', { class: 'plan-card-top' }, [
          el('h2', { class: 'plan-card-name', text: item.name || '未命名方案' }),
          el('span', {
            class: 'badge',
            text: Number.isInteger(item.revision) ? `revision ${item.revision}` : 'revision —',
          }),
        ]),
        el('div', { class: 'plan-card-meta' }, [
          el('span', { text: `更新 ${formatDateTime(item.updatedAt)}` }),
          el('span', { text: `${formatCount(item.roomCount)} 个房间` }),
          el('span', { text: `${Number(item.totalAreaM2 || 0).toFixed(2)} m²` }),
          el('span', { text: `${formatCount(item.furnitureCount)} 件家具` }),
        ]),
        el('div', { class: 'plan-card-actions' }, [
          el('a', {
            class: 'button button-primary',
            href: `/#/plans/${item.id}`,
            text: '打开编辑',
          }),
          deleteButton,
        ]),
      ]);
    }));

    const pageInfo = el('span', {
      class: 'pagination-info',
      text: `共 ${formatCount(total)} 个方案 · 第 ${page} / ${Math.max(1, totalPages)} 页`,
    });
    const prev = el('button', {
      class: 'button button-secondary button-small',
      attrs: { type: 'button' },
      text: '上一页',
    });
    prev.disabled = page <= 1;
    prev.addEventListener('click', () => {
      if (page <= 1) return;
      page -= 1;
      load();
    });
    const next = el('button', {
      class: 'button button-secondary button-small',
      attrs: { type: 'button' },
      text: '下一页',
    });
    next.disabled = page >= totalPages;
    next.addEventListener('click', () => {
      if (page >= totalPages) return;
      page += 1;
      load();
    });

    content.replaceChildren(
      grid,
      totalPages > 1
        ? el('nav', { class: 'pagination', attrs: { 'aria-label': '方案分页' } }, [prev, pageInfo, next])
        : el('div', { class: 'pagination' }, [pageInfo]),
    );
  }

  async function load({ silent = false } = {}) {
    if (disposed) return;
    const seq = ++requestSeq;
    if (silent) {
      status.textContent = '正在刷新方案列表…';
    } else {
      status.textContent = '';
      renderLoading(content, '正在加载方案列表…');
    }
    try {
      const payload = await api.listPlans({ page, pageSize, q: query });
      if (disposed || seq !== requestSeq) return;
      const itemsSource = Array.isArray(payload?.items)
        ? payload.items
        : (Array.isArray(payload?.plans) ? payload.plans : []);
      const items = itemsSource.map((item) => ({
        id: item.id ?? item.planId ?? null,
        name: typeof item.name === 'string' ? item.name : '',
        revision: Number.isInteger(item.revision) ? item.revision : null,
        updatedAt: item.updatedAt ?? item.updated_at ?? null,
        roomCount: Number.isFinite(item.roomCount) ? item.roomCount : null,
        totalAreaM2: Number.isFinite(item.totalAreaM2) ? item.totalAreaM2 : 0,
        furnitureCount: Number.isFinite(item.furnitureCount) ? item.furnitureCount : 0,
      }));
      const total = Number.isInteger(payload?.total) ? payload.total : items.length;
      const totalPages = Number.isInteger(payload?.totalPages)
        ? payload.totalPages
        : Math.ceil(total / pageSize);

      if (!items.length && total > 0 && page > 1) {
        page = Math.max(1, page - 1);
        await load({ silent });
        return;
      }
      renderItems(items, total, totalPages);
      status.textContent = total
        ? `共 ${formatCount(total)} 个方案`
        : '暂无方案';
    } catch (error) {
      if (disposed || seq !== requestSeq) return;
      status.textContent = '';
      renderError(content, {
        title: '方案列表加载失败',
        message: error && error.message ? error.message : '请求失败',
        error,
        onRetry: () => load(),
        retryLabel: '重新加载',
      });
    }
  }

  async function deletePlan(item, button) {
    const confirmed = await confirmDialog({
      title: '删除方案？',
      message: `将永久删除「${item.name || '未命名方案'}」（revision ${item.revision ?? '—'}）。此操作不可撤销。`,
      confirmLabel: '删除方案',
      danger: true,
    });
    if (!confirmed) return;
    setButtonBusy(button, true, '删除中…');
    try {
      await api.deletePlan(item.id);
      showToast({ message: '方案已删除', tone: 'success' });
      if (currentItems.length === 1 && page > 1) page -= 1;
      await load({ silent: true });
    } catch (error) {
      showToast({ message: '删除方案失败', tone: 'error', error });
    } finally {
      setButtonBusy(button, false);
    }
  }

  load();

  return {
    dispose() {
      disposed = true;
      requestSeq += 1;
    },
    isDirty: () => false,
    confirmDiscard: async () => true,
  };
}

/* ------------------------------- 启动 ------------------------------- */

window.addEventListener('hashchange', () => {
  navigate();
});

window.addEventListener('popstate', () => {
  navigate();
});

navigate();
