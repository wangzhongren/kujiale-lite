export const API_BASE = '/api/v1';
export const CSRF_COOKIE_NAMES = ['kj_csrf', 'csrf_token', 'csrf', 'XSRF-TOKEN'];
export const CSRF_HEADER_NAMES = ['X-CSRF-Token', 'X-CSRFToken'];

const STATUS_MESSAGES = {
  400: '请求格式不正确',
  401: '登录状态已失效，请重新登录',
  403: '没有权限执行该操作',
  404: '请求的资源不存在',
  409: '资源与当前版本冲突',
  413: '提交内容超过大小上限',
  422: '提交内容未通过校验',
  429: '操作过于频繁，请稍后再试',
  500: '服务器内部错误',
  503: '服务暂时不可用',
};

export class ApiError extends Error {
  constructor({
    code = 'INTERNAL', message = '请求失败', status = 0, requestId = null, details = null, cause = null,
  } = {}) {
    super(message || STATUS_MESSAGES[status] || '请求失败');
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
    this.cause = cause;
  }

  get isNetworkError() {
    return this.status === 0;
  }

  get isAuthError() {
    return this.code === 'AUTH_REQUIRED' || this.status === 401;
  }

  get isConflict() {
    return this.code === 'CONFLICT_REVISION' || this.status === 409;
  }

  /** 错误态与提示统一展示「错误码 + requestId」。 */
  describe() {
    const parts = [];
    if (this.code) parts.push(`错误码 ${this.code}`);
    if (this.requestId) parts.push(`requestId ${this.requestId}`);
    else if (this.isNetworkError) parts.push('requestId 不可用（网络错误）');
    return parts.join(' · ');
  }
}

function readCookie(name) {
  if (typeof document === 'undefined' || !document.cookie) return null;
  const prefix = `${name}=`;
  for (const chunk of document.cookie.split(';')) {
    const trimmed = chunk.trim();
    if (trimmed.startsWith(prefix)) {
      const raw = trimmed.slice(prefix.length);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

export function getCsrfToken() {
  for (const name of CSRF_COOKIE_NAMES) {
    const value = readCookie(name);
    if (value) return value;
  }
  return null;
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function filenameFromDisposition(header, fallback) {
  if (typeof header === 'string') {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (star) {
      try {
        return decodeURIComponent(star[1].trim());
      } catch {
        // 继续尝试普通 filename
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(header);
    if (plain) return plain[1].trim();
  }
  return fallback;
}

/**
 * 统一 /api/v1 访问：错误码、requestId、CSRF 双提交、401 回调、网络错误可重试。
 * 后端约定的 CSRF cookie 名为 csrf_token（兼容 csrf/XSRF-TOKEN），
 * 请求头为 X-CSRF-Token（同时发送 X-CSRFToken 别名）。
 */
export function createApi({
  fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
  onUnauthorized = null,
  baseUrl = API_BASE,
  timeoutMs = 30000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('缺少 fetch 实现');
  }

  async function request(path, options = {}) {
    const {
      method = 'GET',
      body,
      headers: customHeaders,
      signal,
      authRedirect = true,
      raw = false,
      timeout = timeoutMs,
    } = options;

    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = new Headers(customHeaders || {});
    headers.set('Accept', raw ? '*/*' : 'application/json');
    const upperMethod = method.toUpperCase();
    let payload;
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      payload = JSON.stringify(body);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(upperMethod)) {
      const token = getCsrfToken();
      if (token) {
        for (const headerName of CSRF_HEADER_NAMES) headers.set(headerName, token);
      }
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = timeout > 0
      ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout)
      : null;
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method: upperMethod,
        headers,
        body: payload,
        credentials: 'same-origin',
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === 'AbortError' && !timedOut) throw error;
      throw new ApiError({
        code: timedOut ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR',
        message: timedOut
          ? '请求超时，编辑内容已保留，请重试'
          : '网络连接失败，编辑内容已保留，请检查服务并重试',
        status: 0,
        cause: error,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    const headerRequestId = response.headers.get('X-Request-Id')
      || response.headers.get('X-Request-ID')
      || response.headers.get('Request-Id');

    if (!response.ok) {
      let payloadError = null;
      try {
        const text = await response.text();
        if (text) {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && parsed.error) payloadError = parsed.error;
        }
      } catch {
        // 非 JSON 错误体：使用状态码兜底
      }
      const error = new ApiError({
        code: payloadError?.code || `HTTP_${response.status}`,
        message: payloadError?.message || STATUS_MESSAGES[response.status] || `请求失败（HTTP ${response.status}）`,
        status: response.status,
        requestId: payloadError?.requestId || headerRequestId,
        details: payloadError?.details ?? null,
      });
      if (response.status === 401 && authRedirect && typeof onUnauthorized === 'function') {
        onUnauthorized(error);
      }
      throw error;
    }

    if (raw) {
      const blob = await response.blob();
      return {
        blob,
        response,
        requestId: headerRequestId,
        filename: filenameFromDisposition(response.headers.get('Content-Disposition'), 'export.csv'),
      };
    }

    if (response.status === 204) return null;
    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  const api = {
    request,

    register(username, password) {
      return request('/auth/register', {
        method: 'POST',
        body: { username, password },
        authRedirect: false,
      });
    },

    login(username, password) {
      return request('/auth/login', {
        method: 'POST',
        body: { username, password },
        authRedirect: false,
      });
    },

    logout() {
      return request('/auth/logout', { method: 'POST', authRedirect: false });
    },

    me() {
      return request('/auth/me', { authRedirect: false });
    },

    listPlans({ page = 1, pageSize = 20, q = '' } = {}) {
      return request(`/plans${buildQuery({ page, pageSize, q })}`);
    },

    createPlan({ name, doc }) {
      return request('/plans', { method: 'POST', body: { name, doc } });
    },

    getPlan(id) {
      return request(`/plans/${encodeURIComponent(id)}`);
    },

    savePlan(id, { name, doc, expectedRevision }) {
      return request(`/plans/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: { name, doc, expectedRevision },
      });
    },

    deletePlan(id) {
      return request(`/plans/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    createShare(id) {
      return request(`/plans/${encodeURIComponent(id)}/share`, { method: 'POST' });
    },

    revokeShare(id) {
      return request(`/plans/${encodeURIComponent(id)}/share`, { method: 'DELETE' });
    },

    exportCsv(id) {
      return request(`/plans/${encodeURIComponent(id)}/export.csv`, {
        raw: true,
        timeout: 60000,
      });
    },

    getShared(token) {
      return request(`/share/${encodeURIComponent(token)}`);
    },

    exportSharedCsv(token) {
      return request(`/share/${encodeURIComponent(token)}/export.csv`, {
        raw: true,
        timeout: 60000,
      });
    },

    getCatalog() {
      return request('/catalog');
    },

    getSample() {
      return request('/sample');
    },
  };

  return api;
}

/** 从分享响应中提取只读文档。 */
export function extractSharePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const plan = payload.plan && typeof payload.plan === 'object' ? payload.plan : payload;
  const doc = payload.doc
    || (plan.doc && typeof plan.doc === 'object' ? plan.doc : null)
    || (Array.isArray(plan.walls) ? plan : null);
  if (!doc) return null;
  return {
    name: typeof plan.name === 'string' ? plan.name : (typeof payload.name === 'string' ? payload.name : '共享方案'),
    doc,
    revision: Number.isInteger(plan.revision) ? plan.revision : (Number.isInteger(payload.revision) ? payload.revision : null),
    updatedAt: plan.updatedAt || payload.updatedAt || null,
  };
}
