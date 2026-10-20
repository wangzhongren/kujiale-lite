let idCounter = 0;

export function uniqueId(prefix = 'id') {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/**
 * 安全 DOM 构造：文本一律走 textContent，不使用 innerHTML。
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null) continue;
    if (key === 'class' || key === 'className') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'attrs') {
      for (const [name, attrValue] of Object.entries(value)) {
        if (attrValue === undefined || attrValue === null || attrValue === false) continue;
        node.setAttribute(name, attrValue === true ? '' : String(attrValue));
      }
    } else if (key === 'dataset') {
      for (const [name, dataValue] of Object.entries(value)) node.dataset[name] = String(dataValue);
    } else if (key === 'on') {
      for (const [eventName, handler] of Object.entries(value)) {
        if (typeof handler === 'function') node.addEventListener(eventName, handler);
      }
    } else if (key === 'props') {
      Object.assign(node, value);
    } else {
      node[key] = value;
    }
  }
  appendChildren(node, children);
  return node;
}

export function frag(...children) {
  const fragment = document.createDocumentFragment();
  appendChildren(fragment, children);
  return fragment;
}

function appendChildren(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  if (node) node.replaceChildren();
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function errorText(error) {
  if (!error) return '发生未知错误';
  if (typeof error === 'string') return error;
  return error.message || '请求失败';
}

export function errorMeta(error) {
  if (!error) return '';
  if (typeof error.describe === 'function') return error.describe();
  const parts = [];
  if (error.code) parts.push(`错误码 ${error.code}`);
  if (error.requestId) parts.push(`requestId ${error.requestId}`);
  return parts.join(' · ');
}

export function announce(message) {
  const live = document.getElementById('live-region');
  if (!live) return;
  live.textContent = '';
  window.setTimeout(() => {
    live.textContent = message;
  }, 30);
}

export function spinner(label = '加载中') {
  return el('span', {
    class: 'spinner',
    attrs: { 'aria-hidden': 'true' },
  }, []);
}
// 保留 label 供调用方在文本中使用，避免误导屏幕阅读器。
void spinner;

export function renderLoading(container, message = '加载中…') {
  container.replaceChildren(el('section', {
    class: 'state state-loading',
    attrs: { role: 'status', 'aria-live': 'polite' },
  }, [
    el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }),
    el('p', { class: 'state-text', text: message }),
  ]));
}

export function renderEmpty(container, { title = '暂无内容', message = '', actions = [] } = {}) {
  container.replaceChildren(el('section', { class: 'state state-empty' }, [
    el('h2', { class: 'state-title', text: title }),
    message ? el('p', { class: 'state-text', text: message }) : null,
    actions.length ? el('div', { class: 'state-actions' }, actions) : null,
  ]));
}

export function renderError(container, {
  title = '加载失败',
  message = '',
  error = null,
  onRetry = null,
  retryLabel = '重试',
  extraActions = [],
} = {}) {
  const detailText = message || errorText(error);
  const meta = errorMeta(error);
  const actions = [];
  if (onRetry) {
    actions.push(el('button', {
      class: 'button button-primary',
      attrs: { type: 'button' },
      text: retryLabel,
      on: { click: onRetry },
    }));
  }
  actions.push(...extraActions);

  const detail = error && error.details
    ? el('details', { class: 'error-details' }, [
      el('summary', { text: '校验详情' }),
      el('pre', { class: 'error-details-body', text: JSON.stringify(error.details, null, 2) }),
    ])
    : null;

  container.replaceChildren(el('section', {
    class: 'state state-error',
    attrs: { role: 'alert' },
  }, [
    el('h2', { class: 'state-title', text: title }),
    el('p', { class: 'state-text', text: detailText }),
    meta ? el('p', { class: 'error-meta', text: meta }) : null,
    detail,
    actions.length ? el('div', { class: 'state-actions' }, actions) : null,
  ]));
}

export function ensureToastRegion() {
  let region = document.getElementById('toast-region');
  if (!region) {
    region = el('div', {
      id: 'toast-region',
      class: 'toast-region',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    document.body.append(region);
  }
  return region;
}

export function showToast({
  message,
  tone = 'info',
  error = null,
  timeout = tone === 'error' ? 9000 : 5000,
} = {}) {
  const region = ensureToastRegion();
  while (region.children.length >= 3) region.firstElementChild?.remove();

  const text = message || errorText(error);
  const meta = error ? errorMeta(error) : '';
  const toast = el('div', {
    class: `toast toast-${tone}`,
    attrs: { role: tone === 'error' ? 'alert' : 'status' },
  }, [
    el('div', { class: 'toast-body' }, [
      el('p', { class: 'toast-message', text }),
      meta ? el('p', { class: 'toast-meta', text: meta }) : null,
    ]),
    el('button', {
      class: 'toast-close',
      attrs: { type: 'button', 'aria-label': '关闭提示' },
      text: '×',
      on: {
        click: () => {
          toast.remove();
        },
      },
    }),
  ]);
  region.append(toast);
  if (timeout > 0) {
    window.setTimeout(() => toast.remove(), timeout);
  }
  return toast;
}

let dialogSequence = 0;

/**
 * 原生 <dialog>：焦点陷阱、Esc 关闭、关闭后恢复焦点。
 * actions: [{label, value, variant, onClick(ctx) => false 可阻止关闭}]
 */
export function showDialog({
  title,
  description = '',
  content = null,
  actions = [],
  initialFocus = null,
  onClose = null,
  dismissible = true,
  size = 'md',
  labelledBy = null,
}) {
  dialogSequence += 1;
  const titleId = labelledBy || uniqueId('dialog-title');
  const root = document.getElementById('dialog-root') || document.body;
  const previousFocus = document.activeElement;

  const closeButton = dismissible ? el('button', {
    class: 'icon-button dialog-close',
    attrs: { type: 'button', 'aria-label': '关闭对话框' },
    text: '×',
    on: { click: () => close(null) },
  }) : null;

  const footer = actions.length ? el('div', { class: 'dialog-actions' }, actions.map((action) => {
    const button = el('button', {
      class: `button ${action.variant ? `button-${action.variant}` : 'button-secondary'}`,
      attrs: { type: action.type || 'button', ...(action.attrs || {}) },
      text: action.label,
    });
    button.addEventListener('click', () => {
      const context = { close, dialog };
      const result = action.onClick ? action.onClick(context) : undefined;
      if (result !== false) close(action.value ?? action.label);
    });
    return button;
  })) : null;

  const dialog = el('dialog', {
    class: `dialog dialog-${size}`,
    attrs: labelledBy ? { 'aria-labelledby': titleId } : { 'aria-labelledby': titleId },
  }, [
    el('div', { class: 'dialog-header' }, [
      el('h2', { id: titleId, class: 'dialog-title', text: title }),
      closeButton,
    ]),
    el('div', { class: 'dialog-body' }, [
      description ? el('p', { class: 'dialog-description', text: description }) : null,
      content,
    ]),
    footer,
  ]);

  let closed = false;
  function close(value) {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (previousFocus && typeof previousFocus.focus === 'function' && previousFocus.isConnected) {
      previousFocus.focus();
    }
    if (typeof onClose === 'function') onClose(value);
  }

  dialog.addEventListener('cancel', (event) => {
    if (!dismissible) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    close(null);
  });
  dialog.addEventListener('close', () => {
    if (!closed) {
      closed = true;
      dialog.remove();
      if (typeof onClose === 'function') onClose(null);
    }
  });

  root.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');

  const focusTarget = initialFocus
    || dialog.querySelector('[autofocus], input, select, textarea, button');
  if (focusTarget && typeof focusTarget.focus === 'function') {
    window.setTimeout(() => focusTarget.focus(), 0);
  }

  return { dialog, close, element: dialog };
}

export function confirmDialog({
  title = '请确认',
  message = '',
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      handle.close();
      resolve(value);
    };
    const handle = showDialog({
      title,
      content: el('p', { class: 'dialog-text', text: message }),
      actions: [
        { label: cancelLabel, value: false, variant: 'secondary', onClick: () => { finish(false); return false; } },
        {
          label: confirmLabel,
          value: true,
          variant: danger ? 'danger' : 'primary',
          onClick: () => { finish(true); return false; },
        },
      ],
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
  });
}

export function promptDialog({
  title = '输入',
  label = '名称',
  value = '',
  maxLength = 80,
  confirmLabel = '确定',
  cancelLabel = '取消',
  help = '',
}) {
  return new Promise((resolve) => {
    let settled = false;
    const inputId = uniqueId('prompt-input');
    const helpId = help ? uniqueId('prompt-help') : null;
    const error = el('p', { class: 'field-error', attrs: { role: 'alert' } });
    const input = el('input', {
      id: inputId,
      class: 'input',
      type: 'text',
      value,
      maxLength,
      autocomplete: 'off',
      attrs: {
        'aria-describedby': helpId || undefined,
        'aria-invalid': 'false',
      },
    });
    const form = el('form', {
      class: 'prompt-form',
      attrs: { novalidate: 'true' },
    }, [
      el('label', { class: 'field-label', attrs: { for: inputId }, text: label }),
      input,
      help ? el('p', { id: helpId, class: 'field-help', text: help }) : null,
      error,
    ]);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      handle.close();
      resolve(result);
    };

    function submit() {
      const raw = input.value;
      const trimmed = raw.trim();
      if (!trimmed) {
        error.textContent = `${label}不能为空`;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      if (Array.from(trimmed).length > maxLength) {
        error.textContent = `${label}不能超过 ${maxLength} 个字符`;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      finish(trimmed);
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    input.addEventListener('input', () => {
      error.textContent = '';
      input.setAttribute('aria-invalid', 'false');
    });

    const handle = showDialog({
      title,
      content: form,
      initialFocus: input,
      actions: [
        {
          label: cancelLabel,
          value: null,
          variant: 'secondary',
          onClick: () => { finish(null); return false; },
        },
        {
          label: confirmLabel,
          value: 'confirm',
          variant: 'primary',
          onClick: () => { submit(); return false; },
        },
      ],
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    });
  });
}

export function setButtonBusy(button, busy, busyLabel = '处理中…') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent || '';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = busyLabel;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.originalText) button.textContent = button.dataset.originalText;
  }
}

export function downloadBlob(blob, filename) {
  const safeName = String(filename || 'download.bin').replace(/[\\/:*?"<>|]/g, '_');
  const url = URL.createObjectURL(blob);
  const anchor = el('a', {
    href: url,
    download: safeName,
    attrs: { 'aria-hidden': 'true', tabindex: '-1' },
  });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function field({ label, control, help = '', id = null }) {
  const controlId = id || control.id || uniqueId('field');
  control.id = controlId;
  if (help) control.setAttribute('aria-describedby', `${controlId}-help`);
  return el('div', { class: 'field' }, [
    el('label', { class: 'field-label', attrs: { for: controlId }, text: label }),
    control,
    help ? el('p', { id: `${controlId}-help`, class: 'field-help', text: help }) : null,
  ]);
}

export function kbd(text) {
  return el('kbd', { class: 'kbd', text });
}

export function formatCount(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}
