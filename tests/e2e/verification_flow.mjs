/**
 * Real-browser delivery-evidence driver for the verification-evidence step.
 *
 * The backend is started by `tests/e2e/run_verification.py` with the exact
 * documented command (`python -m app --port 8080`).  This script uses this
 * machine's Chrome/Edge over CDP and never writes to `web/` or
 * `tests/frontend/`.
 *
 * Modes:
 *   full     register -> create blank 演示户型 -> draw a second connected room
 *            -> add 2 doors / 2 windows -> 3 furniture (rotated) -> floor /
 *            wall materials -> 3D orbit & first-person -> save -> logout/login
 *            -> reopen from list -> share -> anonymous 2D/3D + shared CSV.
 *   restart  login after the backend process was restarted and reopen the
 *            same plan from the list, proving persistence.
 *
 * The final stdout line is `VERIFICATION_RESULT {json}`.  The Python runner
 * removes share tokens and writes only redacted console output to evidence.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODE = process.env.VERIFICATION_MODE || 'full';
const BASE = process.env.VERIFICATION_BASE_URL || 'http://127.0.0.1:8080';
const USERNAME = process.env.VERIFICATION_USERNAME || '';
const PASSWORD = process.env.VERIFICATION_PASSWORD || '';
const PLAN_ID = process.env.VERIFICATION_PLAN_ID
  ? Number(process.env.VERIFICATION_PLAN_ID)
  : null;
const EVIDENCE = process.env.VERIFICATION_EVIDENCE || path.join(ROOT, 'docs', 'evidence');
const DOWNLOAD_DIR = process.env.VERIFICATION_DOWNLOAD_DIR || path.join(EVIDENCE, 'verification-downloads');
const PROFILE = path.join(ROOT, 'data', `.verification-chrome-${process.pid}-${Date.now()}`);
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const checks = [];
const failures = [];
const screenshots = [];
const network = [];
const inflight = new Map();
let chrome = null;
let cdp = null;
let browserInfo = null;

function check(name, ok, details = '') {
  const entry = { name, ok: Boolean(ok), details };
  checks.push(entry);
  if (!ok) failures.push(`${name}${details ? ` :: ${JSON.stringify(details)}` : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${details && !ok ? ` :: ${JSON.stringify(details)}` : ''}`);
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

function redactPath(value) {
  return String(value || '').replace(/\/share\/[A-Za-z0-9_-]{20,100}/g, '/share/[redacted]');
}

function recordRequest(params) {
  const url = String(params?.request?.url || '');
  if (!url.includes('/api/v1/')) return;
  inflight.set(params.requestId, {
    method: String(params.request?.method || 'GET').toUpperCase(),
    path: redactPath(url),
    startedAt: Date.now(),
  });
}

function recordResponse(params) {
  const pending = inflight.get(params.requestId);
  if (!pending) return;
  inflight.delete(params.requestId);
  const headers = params.response?.headers || {};
  let requestId = '';
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === 'x-request-id') {
      requestId = String(value || '');
      break;
    }
  }
  network.push({
    method: pending.method,
    path: pending.path,
    status: Number(params.response?.status || 0),
    requestId,
    durationMs: Math.max(0, Date.now() - pending.startedAt),
  });
}

function onCdpEvent(method, params) {
  if (method === 'Network.requestWillBeSent') recordRequest(params);
  else if (method === 'Network.responseReceived') recordResponse(params);
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
      killer.once('error', () => finish());
      killer.once('exit', finish);
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      finish();
    }
    setTimeout(finish, 5000);
  });
}

function connectCdp(url, eventHandler) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 15000);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          id += 1;
          const callId = id;
          socket.send(JSON.stringify({ id: callId, method, params }));
          return new Promise((resolveSend, rejectSend) => {
            const timeout = setTimeout(() => {
              pending.delete(callId);
              rejectSend(new Error(`CDP timeout: ${method}`));
            }, 30000);
            pending.set(callId, {
              resolve(value) {
                clearTimeout(timeout);
                resolveSend(value);
              },
              reject(error) {
                clearTimeout(timeout);
                rejectSend(error);
              },
            });
          });
        },
        close() {
          try {
            socket.close();
          } catch {
            // already closed
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
      if (message.method) {
        try {
          eventHandler?.(message.method, message.params || {});
        } catch {
          // Evidence capture must not break the flow.
        }
        return;
      }
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP websocket error'));
    });
    socket.addEventListener('close', () => {
      for (const entry of pending.values()) entry.reject(new Error('CDP closed'));
      pending.clear();
    });
  });
}

async function startChrome() {
  const executable = findChrome();
  if (!executable) throw new Error('Chrome/Edge executable not found');
  fs.mkdirSync(PROFILE, { recursive: true });
  const debugPort = await freePort();
  chrome = spawn(executable, [
    '--headless=new',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const chromeLog = [];
  chrome.stdout.on('data', (chunk) => chromeLog.push(chunk.toString()));
  chrome.stderr.on('data', (chunk) => chromeLog.push(chunk.toString()));

  const deadline = Date.now() + 20000;
  let target = null;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited early: ${chromeLog.join('').slice(-2000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        if (target) break;
      }
    } catch {
      // wait
    }
    await delay(200);
  }
  if (!target) throw new Error('no CDP page target');
  cdp = await connectCdp(target.webSocketDebuggerUrl, onCdpEvent);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  try {
    const version = await cdp.send('Browser.getVersion');
    browserInfo = {
      product: version.product || '',
      userAgent: version.userAgent || '',
      executable,
    };
  } catch {
    browserInfo = { product: '', userAgent: '', executable };
  }
  return executable;
}

async function evaluate(expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'page exception');
  }
  return result.result.value;
}

async function waitFor(expression, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(150);
  }
  throw new Error(`wait timeout: ${label}${last ? ` (${last.message})` : ''}`);
}

async function navigate(url) {
  await cdp.send('Page.navigate', { url });
  const expected = JSON.stringify(url);
  await waitFor(
    `document.readyState === 'complete' && !!document.body && location.href === ${expected}`,
    `navigate ${redactPath(url)}`,
    20000,
  );
}

async function screenshot(name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(EVIDENCE, name), Buffer.from(result.data, 'base64'));
  screenshots.push(name);
  console.log(`SHOT ${name}`);
}

async function clickText(selector, text, exact = false) {
  return evaluate(`(() => {
    const wanted = ${JSON.stringify(text)};
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const node = nodes.find((item) => {
      const value = (item.textContent || '').replace(/\\s+/g, ' ').trim();
      return ${exact ? 'value === wanted' : 'value.includes(wanted)'};
    });
    if (!node) return false;
    node.click();
    return true;
  })()`);
}

async function click(selector) {
  return evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.click();
    return true;
  })()`);
}

async function setInput(selector, value) {
  const payload = JSON.stringify(value);
  return evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${payload});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function setSelectIndex(selector, index) {
  return evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    if (!select || !select.options[${Number(index)}]) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, select.options[${Number(index)}].value);
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function press(key, code, vk, modifiers = 0) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await delay(200);
}

async function dispatchCanvasKey(key) {
  return evaluate(`(() => {
    const canvas = document.querySelector('.canvas-2d');
    if (!canvas) return false;
    canvas.focus();
    canvas.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
    }));
    return true;
  })()`);
}

async function canvasRect(selector = '.canvas-2d') {
  return evaluate(`(() => {
    const canvas = document.querySelector(${JSON.stringify(selector)});
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`);
}

async function clickScreen(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await delay(160);
}

async function clickWorld(rect, worldX, worldY, scale, offsetX, offsetY) {
  await clickScreen(rect.left + offsetX + worldX * scale, rect.top + offsetY + worldY * scale);
}

async function dragOrbit(selector) {
  const rect = await canvasRect(selector);
  if (!rect) throw new Error(`canvas not found: ${selector}`);
  const x = rect.left + rect.width * 0.5;
  const y = rect.top + rect.height * 0.5;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x + step * 18,
      y: y - step * 7,
      button: 'left',
      buttons: 1,
    });
    await delay(40);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 144, y: y - 56, button: 'left', clickCount: 1 });
  await delay(500);
}

async function dispatchWheel(deltaY = 600) {
  return evaluate(`(() => {
    const canvas = document.querySelector('.canvas-2d');
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const event = new WheelEvent('wheel', {
      deltaY: ${Number(deltaY)},
      deltaMode: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
      cancelable: true,
    });
    canvas.dispatchEvent(event);
    return true;
  })()`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function planIdFromUrl() {
  return evaluate(`(() => {
    const hash = /#\\/plans\\/([0-9]+)/.exec(location.hash || '');
    if (hash) return Number(hash[1]);
    const pathMatch = /\\/plans\\/([0-9]+)/.exec(location.pathname || '');
    return pathMatch ? Number(pathMatch[1]) : null;
  })()`);
}

async function fetchPlan(planId) {
  return evaluate(`fetch('/api/v1/plans/${Number(planId)}').then((response) => response.json())`, true);
}

function normalizePlan(payload) {
  const plan = payload?.plan || payload || {};
  const doc = plan.doc || payload?.doc || {};
  return { plan, doc };
}

function summarizeDoc(doc) {
  return {
    schemaVersion: doc.schemaVersion,
    units: doc.units,
    walls: Array.isArray(doc.walls) ? doc.walls.length : 0,
    openings: Array.isArray(doc.openings) ? doc.openings.map((item) => item.type) : [],
    furniture: Array.isArray(doc.furniture)
      ? doc.furniture.map((item) => ({ id: item.id, catalogId: item.catalogId, rotation: item.rotation, x: item.x, y: item.y }))
      : [],
    rooms: Array.isArray(doc.rooms) ? doc.rooms.map((item) => ({ id: item.id, name: item.name, loopKey: item.loopKey })) : [],
    materials: doc.materials || {},
  };
}

async function latestCsv(maxMs = 15000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const files = fs.existsSync(DOWNLOAD_DIR)
      ? fs.readdirSync(DOWNLOAD_DIR).filter((name) => name.toLowerCase().endsWith('.csv'))
      : [];
    if (files.length) {
      const file = path.join(DOWNLOAD_DIR, files[0]);
      const bytes = fs.readFileSync(file);
      if (bytes.length > 0) return { file, bytes };
    }
    await delay(200);
  }
  return null;
}

async function login(username, password) {
  await navigate(`${BASE}/`);
  await waitFor(`!!document.querySelector('.auth-card')`, 'auth page');
  const loginSelected = await evaluate(`document.querySelector('button.tab[aria-selected="true"]')?.textContent.trim() === '登录'`);
  if (!loginSelected) {
    if (!(await clickText('button.tab', '登录', true))) throw new Error('login tab not found');
    await waitFor(`document.querySelector('button.tab[aria-selected="true"]')?.textContent.trim() === '登录'`, 'login tab active');
  }
  await setInput('input[autocomplete="username"]', username);
  await setInput('input[autocomplete="current-password"]', password);
  await evaluate(`document.querySelector('form.auth-form').requestSubmit()`);
  await waitFor(`!!document.querySelector('.list-shell')`, 'plan list after login', 25000);
}

async function runFull() {
  if (!USERNAME || !PASSWORD) throw new Error('missing verification credentials');
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  for (const file of fs.existsSync(DOWNLOAD_DIR) ? fs.readdirSync(DOWNLOAD_DIR) : []) {
    try {
      fs.rmSync(path.join(DOWNLOAD_DIR, file), { force: true });
    } catch {
      // a previous download may still be open; latestCsv picks the new one
    }
  }

  await startChrome();
  await navigate(`${BASE}/`);
  await waitFor(`!!document.querySelector('.auth-card')`, 'login page');
  await screenshot('verification-01-login.png');

  if (!(await clickText('button.tab', '注册', true))) throw new Error('register tab not found');
  await waitFor(`document.querySelector('button.tab[aria-selected="true"]')?.textContent.trim() === '注册'`, 'register tab active');
  await setInput('input[autocomplete="username"]', USERNAME);
  await setInput('input[autocomplete="new-password"]', PASSWORD);
  await evaluate(`document.querySelector('form.auth-form').requestSubmit()`);
  await waitFor(`!!document.querySelector('.list-shell') && !!document.querySelector('.state-empty')`, 'empty list after UI register', 30000);
  await screenshot('verification-02-empty-list.png');
  check('UI register via real API -> empty plan list', true, { username: USERNAME });

  if (!(await clickText('button', '新建方案', true))) throw new Error('create plan button not found');
  await waitFor(`!!document.querySelector('dialog[open]')`, 'new plan dialog');
  await setInput('dialog[open] input.input', '演示户型');
  if (!(await click('dialog[open] .dialog-actions .button-primary'))) throw new Error('create confirm button not found');
  await waitFor(`!!document.querySelector('.editor-shell')`, 'editor after plan create', 30000);
  const planId = await planIdFromUrl();
  if (!planId) throw new Error('plan id missing from editor URL');
  const initialPayload = await fetchPlan(planId);
  const initial = normalizePlan(initialPayload);
  check('created blank 演示户型 via UI', initial.plan.name === '演示户型' && initial.plan.revision >= 1, {
    planId,
    revision: initial.plan.revision,
  });
  check('blank plan starts from one 12 m2 room', initial.doc.walls?.length === 4
    && initial.doc.rooms?.length === 1
    && initial.doc.openings?.length === 0
    && initial.doc.furniture?.length === 0, summarizeDoc(initial.doc));
  await waitFor(`!!document.querySelector('.canvas-2d')`, '2D canvas');
  await screenshot('verification-03-blank-plan.png');

  // ---- Draw a second connected room (3 new walls sharing the existing w2).
  // Re-fit once so the view matches the current canvas size (the initial
  // auto-fit may have run before the stage finished laying out).
  if (!(await clickText('.tool-button', '适配', true))) throw new Error('2D fit button not found before drawing');
  await delay(400);
  const rect = await canvasRect();
  if (!rect || !rect.width || !rect.height) throw new Error('invalid 2D canvas size');
  const s0 = clamp(Math.min((rect.width - 112) / 4000, (rect.height - 112) / 3000), 0.01, 3);
  let scale = s0;
  let offsetX = rect.width / 2 - 2000 * s0;
  let offsetY = rect.height / 2 - 1500 * s0;
  // The canvas keyboard shortcut `-` zooms out by exactly 1.2 around the
  // canvas centre, which keeps the world centre (2000,1500) fixed.  This is
  // deterministic, unlike wheel events with sub-pixel anchoring.
  let zoomSteps = 0;
  while (scale * 5000 > rect.width / 2 - 16 && zoomSteps < 12) {
    scale /= 1.2;
    zoomSteps += 1;
  }
  scale = clamp(scale, 0.01, 3);
  for (let step = 0; step < zoomSteps; step += 1) {
    if (!(await dispatchCanvasKey('-'))) throw new Error('could not dispatch zoom-out key');
  }
  await delay(300);
  offsetX = rect.width / 2 - 2000 * scale;
  offsetY = rect.height / 2 - 1500 * scale;
  check('2D keyboard zoom out keeps both rooms reachable', zoomSteps > 0 && scale < s0, { s0, scale, zoomSteps });

  if (!(await clickText('.tool-button span', '墙', true))) throw new Error('wall tool not found');
  await clickWorld(rect, 4000, 0, scale, offsetX, offsetY);
  await clickWorld(rect, 7000, 0, scale, offsetX, offsetY);
  await clickWorld(rect, 7000, 3000, scale, offsetX, offsetY);
  await clickWorld(rect, 4000, 3000, scale, offsetX, offsetY);
  await dispatchCanvasKey('Escape');
  if (await clickText('button', '同步房间', true)) {
    await delay(300);
  }
  await waitFor(`document.querySelectorAll('button[data-object-type="wall"]').length === 7`, '7 walls', 15000);
  await waitFor(`document.querySelectorAll('button[data-object-type="room"]').length === 2`, '2 rooms', 15000);
  const roomStatus = await evaluate(`document.querySelector('.editor-status')?.textContent || ''`);
  check('drew second connected room by clicking canvas (7 walls / 2 rooms)', /7 面墙/.test(roomStatus) && /2 个房间/.test(roomStatus), { status: roomStatus });

  // Re-fit to the 0..7000 x 0..3000 extent before placing openings/furniture.
  if (!(await clickText('.tool-button', '适配', true))) throw new Error('2D fit button not found');
  await delay(450);
  const s2 = clamp(Math.min((rect.width - 112) / 7000, (rect.height - 112) / 3000), 0.01, 3);
  const off2X = rect.width / 2 - 3500 * s2;
  const off2Y = rect.height / 2 - 1500 * s2;
  await screenshot('verification-04-two-rooms.png');

  // ---- 2 doors + 2 windows.
  if (!(await clickText('.tool-button span', '门', true))) throw new Error('door tool not found');
  await clickWorld(rect, 4000, 800, s2, off2X, off2Y);
  await clickWorld(rect, 2500, 0, s2, off2X, off2Y);
  if (!(await clickText('.tool-button span', '窗', true))) throw new Error('window tool not found');
  await clickWorld(rect, 1200, 0, s2, off2X, off2Y);
  await clickWorld(rect, 7000, 1200, s2, off2X, off2Y);
  await waitFor(`document.querySelectorAll('button[data-object-type="opening"]').length === 4`, '4 openings', 15000);
  const openingStatus = await evaluate(`document.querySelector('.editor-status')?.textContent || ''`);
  check('placed 2 doors + 2 windows on walls', /4 个门窗/.test(openingStatus), { status: openingStatus });
  await screenshot('verification-05-openings.png');

  // ---- Rename rooms and apply floor/wall materials through the catalog UI.
  await waitFor(`document.querySelector('.room-select-wrap select')?.options.length === 2`, 'two room options');
  if (!(await setSelectIndex('.room-select-wrap select', 0))) throw new Error('cannot select room 1');
  await waitFor(`!!document.querySelector('.properties input.input')`, 'room properties');
  await setInput('.properties input.input', '客厅');
  await delay(250);
  if (!(await setSelectIndex('.room-select-wrap select', 1))) throw new Error('cannot select room 2');
  await waitFor(`!!document.querySelector('.properties input.input')`, 'room 2 properties');
  await setInput('.properties input.input', '卧室');
  await delay(250);

  const applySwatch = async (roomIndex, title) => {
    await setSelectIndex('.room-select-wrap select', roomIndex);
    await delay(150);
    const clicked = await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('.swatch-button'))
        .find((item) => (item.title || '') === ${JSON.stringify(title)});
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`material swatch not found: ${title}`);
    await delay(200);
  };
  await applySwatch(0, '浅橡木地板');
  await applySwatch(0, '暖白乳胶漆');
  await applySwatch(1, '灰色瓷砖');
  await applySwatch(1, '鼠尾草绿');

  // ---- 3 furniture, each rotated 30 degrees via the properties action.
  const placeFurniture = async (name, x, y) => {
    const selected = await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('.catalog-item'))
        .find((item) => (item.textContent || '').includes(${JSON.stringify(name)}));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!selected) throw new Error(`furniture not found: ${name}`);
    await delay(200);
    await clickWorld(rect, x, y, s2, off2X, off2Y);
    await waitFor(`!!document.querySelector('.prop-actions button')`, `furniture properties after ${name}`);
    await delay(200);
    for (let turn = 0; turn < 2; turn += 1) {
      if (!(await clickText('.prop-actions button', '右转 15°', true))) {
        throw new Error(`rotate button not found after ${name}`);
      }
      await delay(200);
    }
  };
  await placeFurniture('双人沙发', 1000, 700);
  await placeFurniture('茶几', 1000, 1600);
  await placeFurniture('双人床', 5500, 1200);
  await waitFor(`document.querySelectorAll('button[data-object-type="furniture"]').length === 3`, '3 furniture', 15000);
  await screenshot('verification-06-furniture-materials.png');
  const editStatus = await evaluate(`document.querySelector('.editor-status')?.textContent || ''`);
  check('3 furniture placed and rotated, 2 room materials applied', /3 件家具/.test(editStatus), { status: editStatus });

  // ---- 3D orbit + first-person, then return to 2D and save.
  if (!(await clickText('.view-tabs button', '3D 漫游'))) throw new Error('3D tab not found');
  await waitFor(`!!document.querySelector('.editor-stage .three-canvas')`, 'editor 3D canvas', 30000);
  await delay(1800);
  await dragOrbit('.editor-stage .three-canvas');
  await screenshot('verification-07-3d-orbit.png');
  const orbitState = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.view-controls button'))
      .find((entry) => entry.textContent.trim() === '轨道视角');
    return {
      pressed: button ? button.getAttribute('aria-pressed') : null,
      hint: document.querySelector('.stage-hint')?.textContent || '',
    };
  })()`, true);
  check('3D orbit view renders and drag orbit executed',
    orbitState.pressed === 'true' && /拖拽旋转/.test(orbitState.hint), orbitState);
  if (!(await clickText('.view-controls button', '第一人称', true))) throw new Error('first-person button not found');
  await delay(1200);
  const walkHint = await evaluate(`document.querySelector('.stage-hint')?.textContent || ''`);
  await screenshot('verification-08-3d-first-person.png');
  check('3D first-person mode active', /第一人称/.test(walkHint), { hint: walkHint });

  if (!(await clickText('.view-tabs button', '2D 户型'))) throw new Error('2D tab not found');
  await waitFor(`!document.querySelector('.editor-stage .three-canvas')`, 'back to 2D');
  await clickText('.tool-button', '适配', true);
  await delay(400);
  if (!(await clickText('button', '保存', true))) throw new Error('save button not found');
  await waitFor(`(document.querySelector('.badge-saved')?.textContent || '').includes('已保存')`, 'saved badge', 30000);
  const savedPayload = await fetchPlan(planId);
  const saved = normalizePlan(savedPayload);
  const savedSummary = summarizeDoc(saved.doc);
  check('saved document revision 2 with 2 rooms/4 openings/3 furniture', saved.plan.revision === 2
    && savedSummary.walls === 7
    && savedSummary.openings.length === 4
    && savedSummary.furniture.length === 3
    && savedSummary.rooms.length === 2, { revision: saved.plan.revision, summary: savedSummary });
  const roomNames = savedSummary.rooms.map((room) => room.name).sort();
  const materials = savedSummary.materials || {};
  const roomIds = savedSummary.rooms.map((room) => room.id);
  const materialValues = [
    materials.floor?.[roomIds[0]],
    materials.wall?.[roomIds[0]],
    materials.floor?.[roomIds[1]],
    materials.wall?.[roomIds[1]],
  ];
  check('room names and materials persisted in the same document',
    roomNames.join('|') === '卧室|客厅'
      && materialValues.includes('floor-oak')
      && materialValues.includes('paint-warm-white')
      && materialValues.includes('floor-tile-grey')
      && materialValues.includes('paint-sage'), { roomNames, materialValues });
  check('all 3 furniture rotations are 30 degrees', savedSummary.furniture.every((item) => item.rotation === 30), savedSummary.furniture);
  await screenshot('verification-09-saved.png');

  // ---- Logout / login / reopen from the list.
  if (!(await clickText('button', '退出登录', true))) throw new Error('logout button not found');
  await waitFor(`!!document.querySelector('.auth-card')`, 'auth page after logout');
  await login(USERNAME, PASSWORD);
  await waitFor(`!!document.querySelector('.plan-card')`, 'plan card after relogin');
  await screenshot('verification-10-list-after-relogin.png');
  if (!(await clickText('.plan-card a.button-primary', '打开编辑'))) throw new Error('open plan link not found');
  await waitFor(`!!document.querySelector('.editor-shell')`, 'editor reopened');
  const revisionBadge = await evaluate(`document.querySelector('.editor-meta .badge')?.textContent || ''`);
  const reopenedStatus = await evaluate(`document.querySelector('.editor-status')?.textContent || ''`);
  check('logout/login -> opened from list with revision 2 and same document',
    /revision 2/.test(revisionBadge)
      && /7 面墙/.test(reopenedStatus)
      && /4 个门窗/.test(reopenedStatus)
      && /3 件家具/.test(reopenedStatus)
      && /2 个房间/.test(reopenedStatus), { revisionBadge, status: reopenedStatus });
  await screenshot('verification-11-reopened.png');

  // ---- Share dialog: generate a read-only link (never screenshot the token).
  if (!(await clickText('button', '分享', true))) throw new Error('share button not found');
  await waitFor(`!!document.querySelector('dialog[open]')`, 'share dialog');
  if (!(await clickText('dialog[open] button', '生成分享链接', true))) throw new Error('generate share button not found');
  const shareUrl = await waitFor(`(() => {
    const dialog = document.querySelector('dialog[open]');
    if (!dialog) return '';
    const input = dialog.querySelector('input');
    if (input && /\\/share\\/[A-Za-z0-9_-]{20,100}/.test(input.value || '')) return input.value.trim();
    const link = dialog.querySelector('a[href*="/share/"]');
    if (link && /\\/share\\/[A-Za-z0-9_-]{20,100}/.test(link.href || '')) return link.href;
    return '';
  })()`, 'generated share link', 20000);
  const shareMatch = /\/share\/([A-Za-z0-9_-]{20,100})/.exec(shareUrl);
  if (!shareMatch) throw new Error('share token missing from generated URL');
  const shareToken = shareMatch[1];
  await clickText('dialog[open] button', '关闭', true);
  await waitFor(`!document.querySelector('dialog[open]')`, 'share dialog closed');
  check('read-only share link generated via UI', shareToken.length >= 20, { tokenLength: shareToken.length });

  // ---- Anonymous share page (cookies cleared) + shared CSV.
  try {
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
      eventsEnabled: true,
    });
  } catch {
    try {
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR });
    } catch {
      // fallback below fetches the same public CSV
    }
  }
  await cdp.send('Network.clearBrowserCookies');
  await navigate(`${BASE}/share/${shareToken}`);
  await waitFor(`!!document.querySelector('.share-shell')`, 'share shell', 30000);
  await waitFor(`!!document.querySelector('.share-shell .canvas-2d')`, 'share 2D canvas');
  const shareLabel = await evaluate(`document.querySelector('.share-shell .canvas-2d')?.getAttribute('aria-label') || ''`);
  const shareState = await evaluate(`(() => ({
    editor: !!document.querySelector('.editor-shell'),
    badge: document.querySelector('.share-shell .badge-readonly')?.textContent || '',
    note: document.querySelector('.share-note')?.textContent || '',
    editButtons: Array.from(document.querySelectorAll('.share-shell button'))
      .map((item) => (item.textContent || '').trim())
      .filter((text) => /保存|删除|撤销|重做|分享/.test(text)),
    download: Array.from(document.querySelectorAll('.share-shell button'))
      .some((item) => (item.textContent || '').includes('下载 CSV 清单')),
  }))()`);
  check('anonymous share 2D shows the same 2-room document read-only', /7 面墙/.test(shareLabel)
    && /4 个门窗/.test(shareLabel)
    && /3 件家具/.test(shareLabel)
    && /2 个房间/.test(shareLabel), { label: shareLabel });
  check('share page has no editing controls and offers CSV list download', !shareState.editor
    && /只读/.test(shareState.badge)
    && /只读分享/.test(shareState.note)
    && shareState.editButtons.length === 0
    && shareState.download, shareState);
  await screenshot('verification-12-share-2d.png');

  if (!(await clickText('.share-shell .view-tabs button', '3D 漫游'))) throw new Error('share 3D tab not found');
  await waitFor(`!!document.querySelector('.share-shell .three-canvas')`, 'share 3D canvas', 30000);
  await delay(1500);
  const share3d = await evaluate(`document.querySelector('.share-shell .three-canvas')?.getAttribute('aria-label') || ''`);
  check('anonymous share 3D uses the same document', /7 面墙/.test(share3d) && /2 个房间/.test(share3d), { label: share3d });
  await screenshot('verification-13-share-3d.png');

  if (!(await clickText('.share-shell button', '下载 CSV 清单', true))) throw new Error('share CSV button not found');
  let downloaded = await latestCsv(15000);
  if (!downloaded) {
    const bytes = await evaluate(`fetch('/api/v1/share/${shareToken}/export.csv').then((response) => response.arrayBuffer()).then((buffer) => Array.from(new Uint8Array(buffer)))`, true);
    downloaded = { file: path.join(DOWNLOAD_DIR, 'share-fallback.csv'), bytes: Buffer.from(bytes) };
    fs.writeFileSync(downloaded.file, downloaded.bytes);
  }
  const shareCsvBytes = downloaded.bytes;
  fs.writeFileSync(path.join(EVIDENCE, 'verification-share.csv'), shareCsvBytes);
  const first3 = shareCsvBytes.subarray(0, 3).toString('hex');
  const csvText = shareCsvBytes.subarray(3).toString('utf8');
  check('anonymous shared CSV has UTF-8 BOM + CRLF + 12.00/9.00', first3 === 'efbbbf'
    && csvText.includes('\r\n')
    && csvText.includes('12.00')
    && csvText.includes('9.00'), { first3, bytes: shareCsvBytes.length });
  check('shared CSV includes per-room material IDs', csvText.includes('floor-oak')
    && csvText.includes('paint-warm-white')
    && csvText.includes('floor-tile-grey')
    && csvText.includes('paint-sage'), { bytes: shareCsvBytes.length });

  return {
    ok: failures.length === 0,
    checks,
    failures,
    planId,
    revision: saved.plan.revision,
    summary: savedSummary,
    shareToken,
    shareTokenLength: shareToken.length,
    shareCsv: { bytes: shareCsvBytes.length, first3 },
    network,
    screenshots,
    browser: browserInfo,
    mode: 'full',
  };
}

async function runRestart() {
  if (!USERNAME || !PASSWORD) throw new Error('missing verification credentials');
  if (!Number.isInteger(PLAN_ID) || PLAN_ID < 1) throw new Error('missing verification plan id');
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await startChrome();
  await login(USERNAME, PASSWORD);
  await waitFor(`!!document.querySelector('.plan-card')`, 'plan card after restart');
  if (!(await clickText('.plan-card a.button-primary', '打开编辑'))) throw new Error('open plan link not found after restart');
  await waitFor(`!!document.querySelector('.editor-shell')`, 'editor after restart');
  await waitFor(`!!document.querySelector('.canvas-2d')`, '2D canvas after restart');
  const revisionBadge = await evaluate(`document.querySelector('.editor-meta .badge')?.textContent || ''`);
  const status = await evaluate(`document.querySelector('.editor-status')?.textContent || ''`);
  const payload = await fetchPlan(PLAN_ID);
  const normalized = normalizePlan(payload);
  const summary = summarizeDoc(normalized.doc);
  const roomNames = summary.rooms.map((room) => room.name).sort();
  check('after process restart: login + open from list retains revision 2', /revision 2/.test(revisionBadge), { revisionBadge });
  check('after process restart: same 7 walls / 4 openings / 3 furniture / 2 rooms', /7 面墙/.test(status)
    && /4 个门窗/.test(status)
    && /3 件家具/.test(status)
    && /2 个房间/.test(status)
    && summary.walls === 7
    && summary.openings.length === 4
    && summary.furniture.length === 3
    && summary.rooms.length === 2, { status, summary });
  check('after process restart: room names/materials/rotations retained', roomNames.join('|') === '卧室|客厅'
    && summary.furniture.every((item) => item.rotation === 30)
    && Object.values(summary.materials.floor || {}).includes('floor-oak')
    && Object.values(summary.materials.wall || {}).includes('paint-sage'), { roomNames, materials: summary.materials });
  await screenshot('verification-14-restart-reopened.png');
  return {
    ok: failures.length === 0,
    checks,
    failures,
    planId: PLAN_ID,
    revision: normalized.plan.revision,
    summary,
    network,
    screenshots,
    browser: browserInfo,
    mode: 'restart',
  };
}

async function cleanup() {
  if (cdp) {
    try {
      await cdp.send('Browser.close');
    } catch {
      // ignore
    }
    cdp.close();
    cdp = null;
  }
  await killTree(chrome);
  chrome = null;
  await delay(1500);
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  } catch {
    console.error(`WARN could not remove temporary profile: ${PROFILE}`);
  }
}

async function main() {
  let result;
  try {
    result = MODE === 'restart' ? await runRestart() : await runFull();
  } finally {
    await cleanup();
  }
  console.log(`VERIFICATION_RESULT ${JSON.stringify(result)}`);
  if (!result.ok) process.exitCode = 1;
}

await main();
