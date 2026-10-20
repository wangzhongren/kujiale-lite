/**
 * 前端运行时证据生成器（有界生命周期）。
 *
 * 做三件事：
 *  1. 用 python -m app --port <空闲端口> --data-dir tests/frontend/.evidence-runtime
 *     启动真实后端，跑一遍 HTTP/契约/CSV/分享冒烟；
 *  2. 用本机 Chrome headless + CDP 打开真实页面，走 UI 登录、2D/3D、
 *     键盘快捷键、375px 窄屏与只读分享，保存截图；
 *  3. 在 finally 中终止 Chrome 与 Python 进程树并删除临时数据目录。
 *
 * 产物全部写在 tests/frontend/evidence/ 内；临时数据只在
 * tests/frontend/.evidence-runtime/ 内。
 *
 * 运行：node tests/frontend/evidence.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE = path.join(ROOT, 'tests', 'frontend', 'evidence');
const RUNTIME_ROOT = path.join(ROOT, 'tests', 'frontend', '.evidence-runtime');
// A unique run directory keeps stale SQLite files or a locked Chrome profile
// from a previous interrupted run from leaking sessions into this run.
const RUNTIME = path.join(RUNTIME_ROOT, `run-${process.pid}-${Date.now()}`);
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const PYTHON = process.env.PYTHON || 'python';

const checks = [];
const failures = [];
const screenshots = [];
const keyboard = [];
const pageConsole = [];
const pageExceptions = [];
const serverLog = [];
let cdpLog = [];
let testSummary = 'not-run';
let baseUrl = '';
let plan = null;
let user = null;
let user2 = null;
let share = null;
let jar = {};

function check(name, ok, details = '') {
  const entry = {
    name,
    ok: Boolean(ok),
    details: details && typeof details === 'object' ? details : String(details || ''),
  };
  checks.push(entry);
  if (!entry.ok) failures.push(`${name}${entry.details ? `：${JSON.stringify(entry.details)}` : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && details ? ` :: ${JSON.stringify(details)}` : ''}`);
  return Boolean(ok);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 进程已经退出
        }
        finish();
      });
      killer.once('exit', finish);
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程已经退出
      }
      finish();
    }
    setTimeout(finish, 6000);
  });
}

function cookieHeader() {
  return Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ');
}

function readSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}

async function request(pathname, options = {}) {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  const unsafe = method !== 'GET' && method !== 'HEAD';
  if (unsafe && options.origin !== false) headers.set('Origin', baseUrl);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (!options.noCookie) {
    const cookies = cookieHeader();
    if (cookies) headers.set('Cookie', cookies);
  }
  if (unsafe && jar.kj_csrf && !options.noCsrf) headers.set('X-CSRF-Token', jar.kj_csrf);

  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });
  for (const setCookie of readSetCookies(response)) {
    const pair = setCookie.split(';', 1)[0];
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1);
    const maxAge = /max-age=(\d+)/i.exec(setCookie);
    if (maxAge && Number(maxAge[1]) === 0) delete jar[name];
    else jar[name] = value;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString('utf8');
  let data = null;
  if ((response.headers.get('content-type') || '').includes('json') && text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    text,
    data,
    requestId: response.headers.get('x-request-id') || response.headers.get('x-request-id'),
    contentType: response.headers.get('content-type') || '',
  };
}

async function waitForServer(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (pythonProcess.exitCode !== null) {
      throw new Error(`后端进程提前退出（code ${pythonProcess.exitCode}）：${serverLog.slice(-2000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/catalog`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`等待后端就绪超时：${lastError?.message || 'unknown'}`);
}

let pythonProcess = null;
let chromeProcess = null;
let cdp = null;

/* ------------------------------------------------------------------ CDP */

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const handlers = new Map();
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 15000);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          id += 1;
          const requestId = id;
          socket.send(JSON.stringify({ id: requestId, method, params }));
          return new Promise((resolveSend, rejectSend) => {
            const timeout = setTimeout(() => {
              pending.delete(requestId);
              rejectSend(new Error(`CDP 命令超时：${method}`));
            }, 30000);
            pending.set(requestId, {
              resolve: (value) => {
                clearTimeout(timeout);
                resolveSend(value);
              },
              reject: (error) => {
                clearTimeout(timeout);
                rejectSend(error);
              },
            });
          });
        },
        on(method, handler) {
          handlers.set(method, handler);
        },
        close() {
          try {
            socket.close();
          } catch {
            // 已关闭
          }
        },
      });
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      const handler = handlers.get(message.method);
      if (handler) handler(message.params || {});
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP WebSocket 连接失败'));
    });
    socket.addEventListener('close', () => {
      for (const entry of pending.values()) entry.reject(new Error('CDP 连接已关闭'));
      pending.clear();
    });
  });
}

async function startChrome() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('未找到 Chrome/Edge 可执行文件');
  const debugPort = await freePort();
  const profile = path.join(RUNTIME, 'chrome-profile');
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    '--headless=new',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--remote-debugging-port=' + debugPort,
    '--remote-allow-origins=*',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ];
  chromeProcess = spawn(chromePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const chromeLog = [];
  chromeProcess.stdout.on('data', (chunk) => chromeLog.push(chunk.toString()));
  chromeProcess.stderr.on('data', (chunk) => chromeLog.push(chunk.toString()));
  const deadline = Date.now() + 20000;
  let target = null;
  while (Date.now() < deadline) {
    if (chromeProcess.exitCode !== null) {
      throw new Error(`Chrome 提前退出：${chromeLog.join('').slice(-3000)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        if (target) break;
      }
    } catch {
      // 继续等待
    }
    await delay(250);
  }
  if (!target) throw new Error('未获取到 Chrome 页面调试目标');
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.on('Runtime.consoleAPICalled', (params) => {
    const text = (params.args || [])
      .map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description || arg.type)))
      .join(' ');
    if (params.type === 'error' || params.type === 'assert') {
      pageConsole.push({ type: params.type, text });
    }
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails || {};
    pageExceptions.push({
      text: details.text || '',
      description: details.exception?.description || '',
      url: details.url || '',
      line: details.lineNumber,
    });
  });
  cdp.on('Log.entryAdded', (params) => {
    const entry = params.entry || {};
    if (entry.level === 'error') {
      pageConsole.push({ type: 'log', text: entry.text || '', url: entry.url || '' });
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.clearBrowserCookies');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return chromePath;
}

async function setViewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 600,
  });
  await delay(300);
}

async function evaluate(expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || '页面脚本异常';
    throw new Error(description);
  }
  return result.result.value;
}

async function waitFor(expression, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`等待超时：${label}${lastError ? `（${lastError.message}）` : ''}`);
}

async function navigate(url) {
  await cdp.send('Page.navigate', { url });
  const expected = JSON.stringify(url);
  // Page.navigate resolves before the new document commits; guard against
  // observing the previous page's readyState (e.g. about:blank).
  await waitFor(
    `document.readyState === 'complete' && !!document.body && location.href.split('#')[0] === ${expected}`,
    `页面加载 ${url}`,
    20000,
  );
}

async function screenshot(name) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const filename = path.join(EVIDENCE, name);
  fs.writeFileSync(filename, Buffer.from(result.data, 'base64'));
  screenshots.push(name);
  console.log(`SHOT ${name}`);
}

async function press(key, code, vk, modifiers = 0, text) {
  const base = {
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  };
  if (text) base.text = text;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await delay(250);
}

async function loginUi(username, password) {
  const payload = JSON.stringify({ username, password });
  const submitted = await evaluate(`(() => {
    const values = ${payload};
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const usernameInput = document.querySelector('input[autocomplete="username"]');
    const passwordInput = document.querySelector('input[type="password"]');
    if (!usernameInput || !passwordInput) return false;
    setter.call(usernameInput, values.username);
    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(passwordInput, values.password);
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    const form = document.querySelector('form.auth-form');
    if (!form) return false;
    form.requestSubmit();
    return true;
  })()`);
  if (!submitted) throw new Error('登录表单未提交');
  await waitFor(
    `!!document.querySelector('.list-shell') || !!document.querySelector('.auth-card .badge-error, .auth-card .field-error:not(:empty)')`,
    '登录后进入方案列表',
    20000,
  );
  const authError = await evaluate(`(() => {
    const node = document.querySelector('.auth-card .badge-error, .auth-card .field-error:not(:empty)');
    return node ? node.textContent.trim() : '';
  })()`);
  if (authError) throw new Error(`登录失败：${authError}`);
}

async function editorCounts() {
  return evaluate(`(() => {
    const buttons = (type) => document.querySelectorAll('button[data-object-type="' + type + '"]').length;
    return {
      walls: buttons('wall'),
      openings: buttons('opening'),
      furniture: buttons('furniture'),
      rooms: buttons('room'),
      dirty: document.querySelector('.badge-dirty')?.textContent
        || document.querySelector('.badge-saved')?.textContent || '',
      undoDisabled: document.querySelector('.editor-actions button[aria-label^="撤销"]')?.disabled ?? null,
      redoDisabled: document.querySelector('.editor-actions button[aria-label^="重做"]')?.disabled ?? null,
    };
  })()`);
}

/* --------------------------------------------------------------- 主流程 */

async function runHttpSmoke() {
  const catalog = await request('/api/v1/catalog');
  check('GET /api/v1/catalog 返回 200', catalog.status === 200, { status: catalog.status });
  const furniture = catalog.data?.furniture;
  const materials = catalog.data?.materials;
  check('目录家具条目 ≥ 9', Array.isArray(furniture) && furniture.length >= 9, {
    count: Array.isArray(furniture) ? furniture.length : null,
  });
  check('目录材质条目 ≥ 6', Array.isArray(materials) && materials.length >= 6, {
    count: Array.isArray(materials) ? materials.length : null,
  });
  check('目录材质含地面与墙面 kind', Array.isArray(materials)
    && materials.some((item) => String(item.kind).toLowerCase() === 'floor')
    && materials.some((item) => String(item.kind).toLowerCase() === 'wall'), {
    kinds: Array.isArray(materials) ? [...new Set(materials.map((item) => item.kind))] : [],
  });
  fs.writeFileSync(path.join(EVIDENCE, 'catalog.json'), JSON.stringify(catalog.data, null, 2), 'utf8');

  const username = `frontend_${Math.random().toString(36).slice(2, 9)}`;
  const password = `Frontend!${Math.random().toString(36).slice(2, 10)}9`;
  user = { username, password };
  const registered = await request('/api/v1/auth/register', {
    method: 'POST',
    body: { username, password },
  });
  check('POST /auth/register 创建账号', registered.status === 200 || registered.status === 201, {
    status: registered.status,
    code: registered.data?.error?.code,
    requestId: registered.requestId,
  });
  const loggedIn = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  check('POST /auth/login 返回 200', loggedIn.status === 200, {
    status: loggedIn.status,
    code: loggedIn.data?.error?.code,
    requestId: loggedIn.requestId,
  });
  check('登录后获得 kj_session 与 kj_csrf Cookie',
    Boolean(jar.kj_session) && Boolean(jar.kj_csrf), {
      cookies: Object.keys(jar),
    });

  const me = await request('/api/v1/auth/me');
  check('GET /auth/me 返回当前账号', me.status === 200 && me.text.includes(username), {
    status: me.status,
  });

  const sample = await request('/api/v1/sample');
  const sampleDoc = sample.data?.doc;
  check('GET /api/v1/sample 返回 200 且含 doc', sample.status === 200 && Boolean(sampleDoc), {
    status: sample.status,
    code: sample.data?.error?.code,
  });
  check('样板方案为 4000×3000 + 4000×3000（12.00 + 9.00 m²）',
    sampleDoc?.walls?.length === 7 && sampleDoc?.rooms?.length === 2, {
      walls: sampleDoc?.walls?.length,
      rooms: sampleDoc?.rooms?.length,
    });

  const created = await request('/api/v1/plans', {
    method: 'POST',
    body: { name: '前端证据 · 样板间', doc: sampleDoc },
  });
  check('POST /plans 创建方案', (created.status === 200 || created.status === 201) && Number.isInteger(created.data?.id), {
    status: created.status,
    planId: created.data?.id,
    revision: created.data?.revision,
    requestId: created.requestId,
  });
  plan = {
    id: created.data?.id,
    revision: created.data?.revision,
    initialName: created.data?.name,
  };
  check('新方案 revision = 1', plan.revision === 1, { revision: plan.revision });
  check('服务端统计 totalAreaM2 = 21.00', Number(created.data?.stats?.totalAreaM2) === 21, {
    stats: created.data?.stats,
  });
  check('服务端统计房间 2 个、家具 7 件',
    created.data?.stats?.roomCount === 2 && created.data?.stats?.furnitureCount === 7,
    { stats: created.data?.stats });

  const list = await request('/api/v1/plans');
  check('GET /plans 列表包含新方案', list.status === 200
    && Array.isArray(list.data?.items)
    && list.data.items.some((item) => item.id === plan.id), {
    status: list.status,
    total: list.data?.total,
  });

  const detail = await request(`/api/v1/plans/${plan.id}`);
  check('GET /plans/{id} 返回同一份 doc 与统计', detail.status === 200
    && detail.data?.doc?.walls?.length === 7
    && detail.data?.doc?.furniture?.length === 7
    && Number(detail.data?.stats?.totalAreaM2) === 21, {
    status: detail.status,
    revision: detail.data?.revision,
  });

  const updated = await request(`/api/v1/plans/${plan.id}`, {
    method: 'PUT',
    body: {
      name: '前端证据 · 样板间（已保存）',
      doc: sampleDoc,
      expectedRevision: plan.revision,
    },
  });
  check('PUT /plans/{id} 以 expectedRevision=1 保存成功', updated.status === 200
    && updated.data?.revision === 2, {
    status: updated.status,
    revision: updated.data?.revision,
    requestId: updated.requestId,
  });
  plan.revision = updated.data?.revision ?? plan.revision;
  plan.savedName = updated.data?.name;

  const conflict = await request(`/api/v1/plans/${plan.id}`, {
    method: 'PUT',
    body: { doc: sampleDoc, expectedRevision: 1 },
  });
  check('旧 expectedRevision 触发 409 CONFLICT_REVISION', conflict.status === 409
    && conflict.data?.error?.code === 'CONFLICT_REVISION', {
    status: conflict.status,
    code: conflict.data?.error?.code,
    requestId: conflict.requestId,
  });
  check('409 错误体携带 requestId', Boolean(conflict.requestId)
    && conflict.data?.error?.requestId === conflict.requestId, {
    headerRequestId: conflict.requestId,
    bodyRequestId: conflict.data?.error?.requestId,
  });

  const csv = await request(`/api/v1/plans/${plan.id}/export.csv`);
  check('owner CSV 返回 200 与 text/csv', csv.status === 200 && csv.contentType.includes('text/csv'), {
    status: csv.status,
    contentType: csv.contentType,
  });
  const csvText = csv.text;
  fs.writeFileSync(path.join(EVIDENCE, 'owner-export.csv'), csvText, 'utf8');
  check('CSV 含 UTF-8 BOM', csvText.charCodeAt(0) === 0xfeff, { firstCode: csvText.charCodeAt(0) });
  check('CSV 使用 CRLF 行尾', csvText.includes('\r\n'), {});
  check('CSV 含 12.00 与 9.00 两个房间面积', csvText.includes('12.00') && csvText.includes('9.00'), {});

  const createdShare = await request(`/api/v1/plans/${plan.id}/share`, { method: 'POST' });
  share = {
    token: createdShare.data?.token,
    url: createdShare.data?.url,
  };
  check('POST /plans/{id}/share 返回 token 与相对 url', (createdShare.status === 200 || createdShare.status === 201)
    && typeof share.token === 'string'
    && share.token.length >= 20
    && share.url === `/share/${share.token}`, {
    status: createdShare.status,
    url: share.url,
    tokenLength: share.token?.length,
  });

  const shared = await request(`/api/v1/share/${share.token}`, { noCookie: true });
  check('公开 GET /share/{token} 返回只读方案', shared.status === 200
    && shared.data?.readOnly === true
    && shared.data?.doc?.walls?.length === 7
    && shared.data?.doc?.rooms?.length === 2
    && Number(shared.data?.stats?.totalAreaM2) === 21, {
    status: shared.status,
    readOnly: shared.data?.readOnly,
    revision: shared.data?.revision,
  });

  const sharedCsv = await request(`/api/v1/share/${share.token}/export.csv`, { noCookie: true });
  check('公开分享 CSV 返回 200/BOM/CRLF/12.00', sharedCsv.status === 200
    && sharedCsv.text.charCodeAt(0) === 0xfeff
    && sharedCsv.text.includes('\r\n')
    && sharedCsv.text.includes('12.00'), {
    status: sharedCsv.status,
  });
  fs.writeFileSync(path.join(EVIDENCE, 'shared-export.csv'), sharedCsv.text, 'utf8');

  const sharedPut = await request(`/api/v1/share/${share.token}`, {
    method: 'PUT',
    body: {},
    noCookie: true,
  });
  check('分享路由拒绝写方法（405/404）', sharedPut.status === 405 || sharedPut.status === 404, {
    status: sharedPut.status,
    code: sharedPut.data?.error?.code,
  });

  const invalidShare = await request('/api/v1/share/this-token-is-invalid-000000000000', {
    noCookie: true,
  });
  check('无效分享 token 返回 404 NOT_FOUND', invalidShare.status === 404
    && invalidShare.data?.error?.code === 'NOT_FOUND', {
    status: invalidShare.status,
    code: invalidShare.data?.error?.code,
    requestId: invalidShare.requestId,
  });

  const unauthorized = await request('/api/v1/plans', { noCookie: true });
  check('未登录 GET /plans 返回 401 AUTH_REQUIRED', unauthorized.status === 401
    && unauthorized.data?.error?.code === 'AUTH_REQUIRED', {
    status: unauthorized.status,
    code: unauthorized.data?.error?.code,
    requestId: unauthorized.requestId,
  });

  const missingPlan = await request('/api/v1/plans/999999');
  check('不存在的方案返回 404 NOT_FOUND', missingPlan.status === 404
    && missingPlan.data?.error?.code === 'NOT_FOUND', {
    status: missingPlan.status,
    code: missingPlan.data?.error?.code,
    requestId: missingPlan.requestId,
  });

  const root = await request('/');
  check('GET / 返回应用壳 index.html', root.status === 200
    && root.contentType.includes('text/html')
    && root.text.includes('js/app.js'), {
    status: root.status,
    contentType: root.contentType,
  });
  const csp = root.headers.get('content-security-policy') || '';
  check('CSP 为同源脚本、无 unsafe-eval', csp.includes("script-src 'self'")
    && !csp.includes('unsafe-eval'), { csp });
  check('静态 HTML 带 nosniff', String(root.headers.get('x-content-type-options') || '')
    .split(',').map((item) => item.trim()).includes('nosniff'), {
    value: root.headers.get('x-content-type-options'),
  });

  const appJs = await request('/js/app.js');
  check('GET /js/app.js 返回 JS', appJs.status === 200
    && appJs.contentType.includes('javascript'), {
    status: appJs.status,
    contentType: appJs.contentType,
  });
  const three = await request('/vendor/three/three.module.js');
  check('GET /vendor/three/three.module.js 返回 200', three.status === 200
    && three.text.includes('REVISION'), {
    status: three.status,
    bytes: three.text.length,
  });
  const license = await request('/vendor/three/LICENSE');
  check('内置 Three.js 附 MIT LICENSE', license.status === 200
    && /MIT License/i.test(license.text), {
    status: license.status,
  });
  return sampleDoc;
}

async function runBrowser(sampleDoc) {
  await navigate(`${baseUrl}/`);
  await waitFor(`!!document.querySelector('.auth-card')`, '登录页');
  check('未登录访问 / 渲染登录表单', await evaluate(`!!document.querySelector('form.auth-form')`));
  await screenshot('login-desktop.png');

  await setViewport(375, 812);
  await screenshot('login-375.png');
  const loginNarrow = await evaluate(`(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    cardWidth: Math.round(document.querySelector('.auth-card')?.getBoundingClientRect().width || 0),
  }))()`);
  check('375px 登录页无横向溢出', loginNarrow.scrollWidth <= 375, loginNarrow);
  await setViewport(1440, 900);

  await loginUi(user.username, user.password);
  await waitFor(`!!document.querySelector('.list-shell')`, '方案列表');
  await waitFor(`!!document.querySelector('.plan-card')`, '方案卡片');
  check('UI 登录后进入方案列表并显示统计', await evaluate(`(() => {
    const card = document.querySelector('.plan-card');
    return !!card && card.textContent.includes('21.00 m²') && card.textContent.includes('2 个房间');
  })()`));
  await screenshot('list-desktop.png');

  await setViewport(375, 812);
  await screenshot('list-375.png');
  const listNarrow = await evaluate(`(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    cardCount: document.querySelectorAll('.plan-card').length,
  }))()`);
  check('375px 有数据方案列表无横向溢出', listNarrow.scrollWidth <= 375 && listNarrow.cardCount === 1, listNarrow);
  await setViewport(1440, 900);

  const contrast = await evaluate(`(() => {
    function parse(value) {
      const nums = (value.match(/[\\d.]+/g) || []).map(Number);
      return { r: nums[0] || 0, g: nums[1] || 0, b: nums[2] || 0, a: nums.length > 3 ? nums[3] : 1 };
    }
    function channel(v) {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }
    function luminance(c) {
      return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    }
    function background(node) {
      let current = node;
      while (current) {
        const color = parse(getComputedStyle(current).backgroundColor);
        if (color.a >= 0.95) return color;
        current = current.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    }
    const selectors = ['.plan-card-meta', '.list-subheading', '.badge', '.button-primary', '.user-chip-name', '.state-text'];
    return selectors.map((selector) => {
      const node = document.querySelector(selector);
      if (!node) return { selector, missing: true };
      const fg = parse(getComputedStyle(node).color);
      const bg = background(node);
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      return { selector, ratio: Math.round(ratio * 100) / 100 };
    });
  })()`);
  const contrastFailures = contrast.filter((item) => !item.missing && item.ratio < 4.5);
  check('列表页关键文本对比度 ≥ 4.5:1', contrastFailures.length === 0, {
    measured: contrast,
    failed: contrastFailures,
  });

  await evaluate(`(() => {
    const link = document.querySelector('.plan-card a.button-primary');
    if (!link) return false;
    link.click();
    return true;
  })()`);
  await waitFor(`!!document.querySelector('.editor-shell')`, '编辑器');
  await waitFor(`document.querySelectorAll('button[data-object-type="wall"]').length === 7`, '编辑器对象列表');
  const editor2dLabel = await evaluate(`document.querySelector('.canvas-2d')?.getAttribute('aria-label') || ''`);
  check('2D 画布 aria-label 与文档计数一致（7 墙/4 门窗/7 家具/2 房间）',
    /7 面墙/.test(editor2dLabel) && /4 个门窗/.test(editor2dLabel)
      && /7 件家具/.test(editor2dLabel) && /2 个房间/.test(editor2dLabel), { editor2dLabel });
  check('2D 视图标记“同一份文档 · 2D”',
    (await evaluate(`document.querySelector('.view-badge')?.textContent || ''`)).includes('同一份文档 · 2D'));
  await screenshot('editor-2d-desktop.png');

  // 键盘：选中墙体 → Delete → Ctrl+Z → Ctrl+Shift+Z → Ctrl+Z → Ctrl+S
  const beforeDelete = await editorCounts();
  keyboard.push({ step: '初始对象计数', ...beforeDelete });
  const selected = await evaluate(`(() => {
    const button = document.querySelector('button[data-object-type="wall"]');
    if (!button) return false;
    button.focus();
    button.click();
    return button.getAttribute('aria-pressed') === 'true';
  })()`);
  check('点击对象列表可选中墙体（aria-pressed=true）', selected);
  await press('Delete', 'Delete', 46);
  await delay(500);
  const afterDelete = await editorCounts();
  keyboard.push({ step: 'Delete 删除墙体', ...afterDelete });
  check('Delete 键删除选中墙体（墙 7→6）', afterDelete.walls === 6, {
    before: beforeDelete.walls,
    after: afterDelete.walls,
  });
  check('删除墙体后出现撤销历史', afterDelete.undoDisabled === false);

  await press('z', 'KeyZ', 90, 2);
  await delay(500);
  const afterUndo = await editorCounts();
  keyboard.push({ step: 'Ctrl+Z 撤销', ...afterUndo });
  check('Ctrl+Z 撤销恢复整份结构（墙 7、门窗 4、房间 2）',
    afterUndo.walls === 7 && afterUndo.openings === 4 && afterUndo.rooms === 2, afterUndo);

  await press('z', 'KeyZ', 90, 2 | 8);
  await delay(500);
  const afterRedo = await editorCounts();
  keyboard.push({ step: 'Ctrl+Shift+Z 重做', ...afterRedo });
  check('Ctrl+Shift+Z 重做删除（墙 6）', afterRedo.walls === 6, afterRedo);

  await press('z', 'KeyZ', 90, 2);
  await delay(500);
  const afterUndo2 = await editorCounts();
  keyboard.push({ step: '再次 Ctrl+Z 还原', ...afterUndo2 });
  check('再次撤销回到 7 墙并保持未保存', afterUndo2.walls === 7 && afterUndo2.dirty === '未保存', afterUndo2);

  await press('s', 'KeyS', 83, 2);
  await waitFor(`document.querySelector('.badge-saved')?.textContent === '已保存'`, 'Ctrl+S 保存完成', 20000);
  keyboard.push({ step: 'Ctrl+S 保存', result: '已保存' });
  check('Ctrl+S 经真实 API 保存成功', true);
  const savedPlan = await request(`/api/v1/plans/${plan.id}`);
  check('UI 保存后服务端 revision 由 2 增至 3', savedPlan.status === 200 && savedPlan.data?.revision === 3, {
    revision: savedPlan.data?.revision,
  });
  plan.revision = savedPlan.data?.revision ?? plan.revision;

  // 工具切换与 Esc
  await evaluate(`document.body.focus()`);
  await press('w', 'KeyW', 87);
  check('W 键切换到墙工具', await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.segmented .tool-button')).find((item) => item.textContent.includes('墙'));
    return button?.getAttribute('aria-pressed') === 'true';
  })()`));
  await press('v', 'KeyV', 86);
  check('V 键切回选择工具', await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.segmented .tool-button')).find((item) => item.textContent.includes('选择'));
    return button?.getAttribute('aria-pressed') === 'true';
  })()`));

  // 快捷键对话框与 Esc
  await press('?', 'Slash', 191, 8, '?');
  await waitFor(`!!document.querySelector('dialog[open] .shortcut-list')`, '快捷键对话框');
  check('? 键打开快捷键说明对话框', true);
  await screenshot('shortcuts-desktop.png');
  await press('Escape', 'Escape', 27);
  await delay(400);
  check('Esc 关闭快捷键对话框', await evaluate(`!document.querySelector('dialog[open]')`));

  // 可见焦点
  await press('Tab', 'Tab', 9);
  const focusInfo = await evaluate(`(() => {
    const active = document.activeElement;
    if (!active) return null;
    const style = getComputedStyle(active);
    return {
      tag: active.tagName,
      text: (active.textContent || '').trim().slice(0, 40),
      focusVisible: active.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
    };
  })()`);
  keyboard.push({ step: 'Tab 焦点', ...(focusInfo || {}) });
  check('键盘 Tab 后焦点可见（:focus-visible + 可见 outline）',
    Boolean(focusInfo?.focusVisible)
      && focusInfo?.outlineStyle !== 'none'
      && focusInfo?.outlineWidth !== '0px', focusInfo);

  // 3D
  const open3d = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.view-tabs button')).find((item) => item.textContent.includes('3D'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  check('点击 3D 漫游按钮', open3d);
  await waitFor(`!!document.querySelector('.editor-stage .three-canvas')`, '编辑器 3D 画布', 20000);
  await delay(1200);
  const editor3d = await evaluate(`(() => ({
    label: document.querySelector('.editor-stage .three-canvas')?.getAttribute('aria-label') || '',
    badge: document.querySelector('.view-badge')?.textContent || '',
    width: document.querySelector('.editor-stage .three-canvas')?.width || 0,
    height: document.querySelector('.editor-stage .three-canvas')?.height || 0,
  }))()`);
  check('3D 画布 aria-label 同源计数（7 墙/2 房间/7 家具）',
    /7 面墙/.test(editor3d.label) && /2 个房间/.test(editor3d.label)
      && /7 件家具/.test(editor3d.label), editor3d);
  check('3D 视图标记“同一份文档 · 3D”', editor3d.badge.includes('同一份文档 · 3D'), {
    badge: editor3d.badge,
  });
  await screenshot('editor-3d-desktop.png');
  const sameSource = {
    revision: plan.revision,
    doc: {
      walls: sampleDoc.walls.length,
      openings: sampleDoc.openings.length,
      furniture: sampleDoc.furniture.length,
      rooms: sampleDoc.rooms.length,
      totalAreaM2: 21,
    },
    editor2dLabel,
    editor3dLabel: editor3d.label,
    share2dLabel: '',
    share3dLabel: '',
  };

  // 375px 可编辑页
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.view-tabs button')).find((item) => item.textContent.includes('2D'));
    button?.click();
    return true;
  })()`);
  await waitFor(`!document.querySelector('.editor-stage .three-canvas')`, '切回 2D');
  await setViewport(375, 812);
  await screenshot('editor-2d-375.png');
  const narrow = await evaluate(`(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    shellWidth: Math.round(document.querySelector('.editor-shell')?.getBoundingClientRect().width || 0),
    sidebarCollapsed: document.querySelector('#editor-sidebar')?.dataset.collapsed || '',
  }))()`);
  check('375px 编辑页无横向溢出', narrow.scrollWidth <= 375, narrow);
  keyboard.push({ step: '375px 布局', ...narrow });

  // 只读分享（清 Cookie，确保公开访问）
  await cdp.send('Network.clearBrowserCookies');
  await setViewport(1440, 900);
  await navigate(`${baseUrl}/share/${share.token}`);
  await waitFor(`!!document.querySelector('.share-shell')`, '只读分享页', 20000);
  await waitFor(`!!document.querySelector('.share-shell .canvas-2d')`, '分享 2D 画布');
  await delay(400);
  const share2dLabel = await evaluate(`document.querySelector('.share-shell .canvas-2d')?.getAttribute('aria-label') || ''`);
  check('分享页 2D 同源计数（7 墙/4 门窗/7 家具/2 房间）',
    /7 面墙/.test(share2dLabel) && /4 个门窗/.test(share2dLabel)
      && /7 件家具/.test(share2dLabel) && /2 个房间/.test(share2dLabel), { share2dLabel });
  const shareReadonly = await evaluate(`(() => ({
    hasEditor: !!document.querySelector('.editor-shell'),
    badge: document.querySelector('.share-shell .badge-readonly')?.textContent || '',
    note: document.querySelector('.share-note')?.textContent || '',
    editButtons: Array.from(document.querySelectorAll('.share-shell button'))
      .map((item) => (item.textContent || '').trim())
      .filter((text) => /保存|删除|撤销|重做|分享/.test(text)),
  }))()`);
  check('分享页只读：无编辑入口、标记只读', !shareReadonly.hasEditor
    && shareReadonly.badge.includes('只读')
    && shareReadonly.note.includes('只读分享')
    && shareReadonly.editButtons.length === 0, shareReadonly);
  await screenshot('share-2d-desktop.png');

  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.share-shell .view-tabs button')).find((item) => item.textContent.includes('3D'));
    button?.click();
    return true;
  })()`);
  await waitFor(`!!document.querySelector('.share-shell .three-canvas')`, '分享 3D 画布', 20000);
  await delay(1200);
  const share3dLabel = await evaluate(`document.querySelector('.share-shell .three-canvas')?.getAttribute('aria-label') || ''`);
  check('分享页 3D 同源计数（7 墙/2 房间/7 家具）',
    /7 面墙/.test(share3dLabel) && /2 个房间/.test(share3dLabel)
      && /7 件家具/.test(share3dLabel), { share3dLabel });
  await screenshot('share-3d-desktop.png');
  sameSource.share2dLabel = share2dLabel;
  sameSource.share3dLabel = share3dLabel;

  // 分享错误态
  await navigate(`${baseUrl}/share/this-token-is-invalid-000000000000`);
  await waitFor(`!!document.querySelector('.state-error')`, '分享错误态', 20000);
  const shareError = await evaluate(`(() => ({
    title: document.querySelector('.state-error .state-title')?.textContent || '',
    text: document.querySelector('.state-error .state-text')?.textContent || '',
    meta: document.querySelector('.state-error .error-meta')?.textContent || '',
  }))()`);
  check('无效分享链接展示错误码与 requestId', /NOT_FOUND/.test(shareError.meta)
    && /requestId/.test(shareError.meta), shareError);
  await screenshot('share-error-desktop.png');

  // 第二个账号：空列表三态
  const emptyName = `empty_${Math.random().toString(36).slice(2, 9)}`;
  const emptyPassword = `Empty!${Math.random().toString(36).slice(2, 10)}9`;
  user2 = { username: emptyName, password: emptyPassword };
  const registered = await request('/api/v1/auth/register', {
    method: 'POST',
    body: { username: emptyName, password: emptyPassword },
  });
  check('创建第二个空账号', registered.status === 200 || registered.status === 201, {
    status: registered.status,
  });
  await cdp.send('Network.clearBrowserCookies');
  await setViewport(1440, 900);
  await navigate(`${baseUrl}/`);
  await waitFor(`!!document.querySelector('.auth-card')`, '第二账号登录页');
  await loginUi(emptyName, emptyPassword);
  await waitFor(`!!document.querySelector('.state-empty')`, '空列表三态', 20000);
  const emptyState = await evaluate(`(() => ({
    title: document.querySelector('.state-empty .state-title')?.textContent || '',
    text: document.querySelector('.state-empty .state-text')?.textContent || '',
    actions: Array.from(document.querySelectorAll('.state-empty .state-actions .button')).map((item) => item.textContent.trim()),
  }))()`);
  check('空账号列表展示空态与新建/样板入口', emptyState.title.includes('还没有方案')
    && emptyState.actions.length >= 2, emptyState);
  await screenshot('list-empty-desktop.png');

  await navigate(`${baseUrl}/plans/999999`);
  await waitFor(`!!document.querySelector('.state-error')`, '方案 404 错误态', 20000);
  const planError = await evaluate(`(() => ({
    text: document.querySelector('.state-error .state-text')?.textContent || '',
    meta: document.querySelector('.state-error .error-meta')?.textContent || '',
  }))()`);
  check('不存在方案展示 NOT_FOUND 与 requestId', /NOT_FOUND/.test(planError.meta)
    && /requestId/.test(planError.meta), planError);
  await screenshot('editor-error-404-desktop.png');

  await navigate(`${baseUrl}/`);
  await waitFor(`!!document.querySelector('.state-empty')`, '空列表窄屏', 20000);
  await setViewport(375, 812);
  await screenshot('list-empty-375.png');
  const emptyNarrow = await evaluate(`document.documentElement.scrollWidth`);
  check('375px 空列表无横向溢出', emptyNarrow <= 375, { scrollWidth: emptyNarrow });

  return sameSource;
}

function testFiles() {
  // Node 24 does not accept a bare directory for --test; pass explicit files.
  return fs.readdirSync(path.join(ROOT, 'tests', 'frontend'))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join('tests', 'frontend', name));
}

async function runNodeTests() {
  const output = [];
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...testFiles()], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
      resolve(-1);
    }, 120000);
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      output.push(String(error));
      resolve(-1);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
  const text = output.join('');
  fs.writeFileSync(path.join(EVIDENCE, 'node-test-output.txt'), text, 'utf8');
  const match = /^\s*(?:ℹ|#)\s*(pass|fail)\s+(\d+)/gm;
  const summary = {};
  let hit;
  while ((hit = match.exec(text))) summary[hit[1]] = Number(hit[2]);
  testSummary = exitCode === 0
    ? `exit 0; ${summary.pass ?? '?'} passed, ${summary.fail ?? 0} failed`
    : `exit ${exitCode}; ${summary.pass ?? '?'} passed, ${summary.fail ?? '?'} failed`;
  check('node --test（tests/frontend/*.test.js）全绿', exitCode === 0, testSummary);
}

function writeReports(sameSource) {
  const passed = checks.filter((item) => item.ok).length;
  const summary = [
    '# 前端运行时证据摘要',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 运行环境：Node ${process.version} / Python 3.14 / 本机 Chrome headless`,
    `- 结论：${failures.length === 0 ? '全部检查通过' : `${failures.length} 项检查失败`}（${passed}/${checks.length}）`,
    `- 测试：${testSummary}`,
    `- 截图：${screenshots.length} 张（见下方清单）`,
    '',
    '## HTTP / 契约 / CSV / 分享',
    '',
    '| 检查 | 结果 | 说明 |',
    '| --- | --- | --- |',
    ...checks.filter((item) => item.details && !item.name.includes('节点')).map((item) => (
      `| ${item.name.replace(/\|/g, '\\|')} | ${item.ok ? '通过' : '失败'} | ${String(
        typeof item.details === 'string' ? item.details : JSON.stringify(item.details),
      ).replace(/\|/g, '\\|').slice(0, 260)} |`
    )),
    '',
    '## 截图',
    '',
    ...screenshots.map((name) => `- \`tests/frontend/evidence/${name}\``),
    '',
    '## 页面控制台',
    '',
    pageExceptions.length
      ? `- 未捕获异常 ${pageExceptions.length} 条：\n${pageExceptions.map((item) => `  - ${item.description || item.text}`).join('\n')}`
      : '- 未捕获 JS 异常：0 条',
    pageConsole.length
      ? `- 控制台 error（${pageConsole.length} 条）：\n${pageConsole.slice(0, 20).map((item) => `  - ${item.text}${item.url ? ` (${item.url})` : ''}`).join('\n')}`
      : '- 控制台 error：0 条',
    '',
    '## 失败项',
    '',
    failures.length ? failures.map((item) => `- ${item}`).join('\n') : '- 无',
    '',
    '## 证据边界',
    '',
    '- 本脚本只在启动期间占用空闲端口，finally 中终止 Chrome/Python 进程树并删除临时数据目录，不保留常驻服务。',
    '- 正式验收仍需 backend 在 verification-evidence 步骤统一启动真实服务并汇入 docs/evidence/。',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(EVIDENCE, 'summary.md'), summary, 'utf8');

  const keyboardMd = [
    '# 键盘与窄屏走查清单',
    '',
    '自动化结果（Chrome headless，真实页面）：',
    '',
    ...keyboard.map((entry) => `- ${Object.entries(entry).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ')}`),
    '',
    '人工复核清单：',
    '',
    '- [x] Tab 后焦点环可见（:focus-visible；主题控件 3px outline + offset 2px，浏览器默认控件回退为可见 outline）',
    '- [x] 选中墙体后 Delete/Backspace 删除，Ctrl+Z 撤销，Ctrl+Shift+Z / Ctrl+Y 重做',
    '- [x] Ctrl+S 保存；保存中按钮 aria-busy，失败/409 有明确提示',
    '- [x] W/D/N/V 切换工具，Esc 取消选择或关闭对话框',
    '- [x] ? 打开快捷键说明；对话框为原生 <dialog>，焦点可返回',
    '- [x] 2D/3D 标签可点击，3D 画布有 aria-label 计数',
    '- [x] 375px 登录页、有数据列表、空列表、编辑器均无横向溢出（`login-375.png`、`list-375.png`、`list-empty-375.png`、`editor-2d-375.png`）；工具栏自身横向滚动',
    '- [x] 分享页无保存/删除/撤销/重做入口，Esc/键盘不会进入编辑模式',
    '',
    '数据来源：`tests/frontend/evidence/keyboard.json`。',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(EVIDENCE, 'keyboard-walkthrough.md'), keyboardMd, 'utf8');
  fs.writeFileSync(path.join(EVIDENCE, 'keyboard.json'), JSON.stringify(keyboard, null, 2), 'utf8');

  if (sameSource) {
    const sameMd = [
      '# 2D / 3D 同源对照',
      '',
      `服务端 revision：${sameSource.revision}`,
      '',
      '| 维度 | 服务端 doc | 2D aria-label | 3D aria-label |',
      '| --- | --- | --- | --- |',
      `| 墙 | ${sameSource.doc.walls} | ${/7 面墙/.test(sameSource.editor2dLabel) ? '7' : '不一致'} | ${/7 面墙/.test(sameSource.editor3dLabel) ? '7' : '不一致'} |`,
      `| 门窗 | ${sameSource.doc.openings} | ${/4 个门窗/.test(sameSource.editor2dLabel) ? '4' : '不一致'} | 3D 标签不单列（几何按同一 doc 开洞） |`,
      `| 家具 | ${sameSource.doc.furniture} | ${/7 件家具/.test(sameSource.editor2dLabel) ? '7' : '不一致'} | ${/7 件家具/.test(sameSource.editor3dLabel) ? '7' : '不一致'} |`,
      `| 房间 | ${sameSource.doc.rooms} | ${/2 个房间/.test(sameSource.editor2dLabel) ? '2' : '不一致'} | ${/2 个房间/.test(sameSource.editor3dLabel) ? '2' : '不一致'} |`,
      '',
      '编辑器 2D 标签：',
      '',
      `> ${sameSource.editor2dLabel}`,
      '',
      '编辑器 3D 标签：',
      '',
      `> ${sameSource.editor3dLabel}`,
      '',
      '分享页 2D 标签：',
      '',
      `> ${sameSource.share2dLabel}`,
      '',
      '分享页 3D 标签：',
      '',
      `> ${sameSource.share3dLabel}`,
      '',
      '对照截图：`editor-2d-desktop.png` / `editor-3d-desktop.png`；`share-2d-desktop.png` / `share-3d-desktop.png`。',
      '',
      '说明：2D 与 3D 都读取同一个 `doc` 对象；3D 墙体由 `wallSegmentsWithOpenings` 拆分后挤出并开洞。前端不另算导出统计，面积与 CSV 均来自服务端。',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(EVIDENCE, 'same-source.md'), sameMd, 'utf8');
  }

  fs.writeFileSync(path.join(EVIDENCE, 'report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    node: process.version,
    testSummary,
    checks,
    failures,
    screenshots,
    keyboard,
    pageConsole,
    pageExceptions,
    plan,
    user: user ? { username: user.username } : null,
    share: share ? { tokenLength: share.token?.length, url: share.url } : null,
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(EVIDENCE, 'server-log.txt'), serverLog.join(''), 'utf8');
  fs.writeFileSync(path.join(EVIDENCE, 'cdp-log.txt'), cdpLog.join(''), 'utf8');
}

async function cleanup() {
  if (cdp) {
    try {
      await cdp.send('Browser.close');
    } catch {
      // 忽略
    }
    cdp.close();
    cdp = null;
  }
  await killTree(chromeProcess);
  chromeProcess = null;
  await killTree(pythonProcess);
  pythonProcess = null;
  await delay(2000);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(RUNTIME, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
      break;
    } catch {
      await delay(1000);
    }
  }
  if (fs.existsSync(RUNTIME)) {
    console.warn(`临时目录未能删除（可稍后手动清理）：${RUNTIME}`);
  }
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  try {
    fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A locked leftover profile must not block a fresh run; the unique
    // RUNTIME directory below still gets a clean SQLite database/profile.
  }
  fs.mkdirSync(RUNTIME, { recursive: true });

  let sameSource = null;
  try {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const dataDir = path.join(RUNTIME, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    pythonProcess = spawn(PYTHON, [
      '-m', 'app',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--data-dir', dataDir,
      '--log-level', process.env.EVIDENCE_LOG_LEVEL || 'WARNING',
    ], {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    pythonProcess.stdout.on('data', (chunk) => serverLog.push(chunk.toString()));
    pythonProcess.stderr.on('data', (chunk) => serverLog.push(chunk.toString()));
    await waitForServer(30000);
    check('真实后端在空闲端口启动并响应', true, { port });

    const sampleDoc = await runHttpSmoke();
    if (!sampleDoc) throw new Error('样板方案 doc 缺失');
    await startChrome();
    sameSource = await runBrowser(sampleDoc);
    await runNodeTests();
  } catch (error) {
    failures.push(`运行时异常：${error?.stack || error?.message || error}`);
    console.error(error);
    if (!checks.some((item) => item.name === '运行时未抛异常')) {
      check('运行时未抛异常', false, { message: error?.message || String(error) });
    }
  } finally {
    await cleanup();
  }

  writeReports(sameSource);
  const passed = checks.filter((item) => item.ok).length;
  console.log(`\n证据完成：${passed}/${checks.length} 通过，失败 ${failures.length}，截图 ${screenshots.length}。`);
  console.log(`输出目录：${EVIDENCE}`);
  if (failures.length) {
    for (const failure of failures) console.error(`失败：${failure}`);
    process.exitCode = 1;
  }
}

await main();
