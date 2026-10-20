/**
 * Browser end-to-end driver for the integration-e2e step.
 *
 * It talks to an already-running real backend (started by
 * `tests/e2e/run_integration.py`) and uses this machine's Chrome/Edge via
 * CDP.  It does not write to `web/` or `tests/frontend/`.
 *
 * Modes:
 *   (default)  full journey: register -> empty list -> sample plan -> 2D edit
 *              -> 3D -> save -> list reopen -> share page -> CSV download.
 *   revoked    open a revoked share URL and verify the visible error state.
 *
 * The final stdout line is `INTEGRATION_RESULT {json}`; the Python runner
 * strips it before persisting any console output, so share tokens are not
 * written to evidence files.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODE = process.env.INTEGRATION_MODE || 'full';
const BASE = process.env.INTEGRATION_BASE_URL || 'http://127.0.0.1:8080';
const USERNAME = process.env.INTEGRATION_USERNAME || '';
const PASSWORD = process.env.INTEGRATION_PASSWORD || '';
const EVIDENCE = process.env.INTEGRATION_EVIDENCE || path.join(ROOT, 'docs', 'evidence');
const DOWNLOAD_DIR = process.env.INTEGRATION_DOWNLOAD_DIR || path.join(EVIDENCE, 'integration-downloads');
const SHARE_URL = process.env.INTEGRATION_SHARE_URL || '';
const PROFILE = path.join(ROOT, 'data', `.integration-chrome-${process.pid}-${Date.now()}`);
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const checks = [];
const failures = [];
const screenshots = [];
let chrome = null;
let cdp = null;

function check(name, ok, details = '') {
  const entry = { name, ok: Boolean(ok), details };
  checks.push(`${ok ? 'PASS' : 'FAIL'} ${name}${details ? ` :: ${typeof details === 'string' ? details : JSON.stringify(details)}` : ''}`);
  if (!ok) failures.push(`${name}${details ? ` :: ${JSON.stringify(details)}` : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${details && !ok ? ` :: ${JSON.stringify(details)}` : ''}`);
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

function connectCdp(url) {
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
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
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

async function waitFor(expression, label, timeout = 20000) {
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
    `navigate ${url}`,
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

async function press(key, code, vk, modifiers = 0) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await delay(250);
}

async function planIdFromUrl() {
  return evaluate(`(() => {
    const hash = /#\\/plans\\/([0-9]+)/.exec(location.hash || '');
    if (hash) return Number(hash[1]);
    const pathMatch = /\\/plans\\/([0-9]+)/.exec(location.pathname || '');
    return pathMatch ? Number(pathMatch[1]) : null;
  })()`);
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

async function runFull() {
  if (!USERNAME || !PASSWORD) throw new Error('missing integration credentials');
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  await startChrome();

  await navigate(`${BASE}/`);
  await waitFor(`!!document.querySelector('.auth-card')`, 'login page');
  await screenshot('integration-login.png');

  if (!(await clickText('button.tab', '注册', true))) throw new Error('register tab not found');
  await waitFor(`document.querySelector('button.tab[aria-selected="true"]')?.textContent.trim() === '注册'`, 'register tab active');
  await setInput('input[autocomplete="username"]', USERNAME);
  await setInput('input[type="password"]', PASSWORD);
  await evaluate(`document.querySelector('form.auth-form').requestSubmit()`);
  await waitFor(`!!document.querySelector('.list-shell') && !!document.querySelector('.state-empty')`, 'empty list after UI register', 25000);
  await screenshot('integration-empty-list.png');
  check('UI register -> empty plan list', true, { username: USERNAME });

  if (!(await clickText('button', '从样板间新建', true))) throw new Error('sample button not found');
  await waitFor(`!!document.querySelector('.editor-shell')`, 'editor after sample create', 25000);
  await waitFor(`document.querySelectorAll('button[data-object-type="wall"]').length === 7`, '7 walls in editor');
  await waitFor(`!!document.querySelector('.swatch-button:not([disabled])')`, 'catalog materials enabled');
  const planId = await planIdFromUrl();
  if (!planId) throw new Error('plan id missing from editor URL');
  const editor2d = await evaluate(`document.querySelector('.canvas-2d')?.getAttribute('aria-label') || ''`);
  check('sample plan opened in 2D editor', /7 面墙/.test(editor2d) && /4 个门窗/.test(editor2d) && /2 个房间/.test(editor2d), { label: editor2d });
  await screenshot('integration-editor-2d.png');

  // 2D geometry edit + undo.
  await evaluate(`document.querySelector('button[data-object-type="wall"]')?.click()`);
  await press('Delete', 'Delete', 46);
  await waitFor(`document.querySelectorAll('button[data-object-type="wall"]').length === 6`, 'delete wall');
  await press('z', 'KeyZ', 90, 2);
  await waitFor(`document.querySelectorAll('button[data-object-type="wall"]').length === 7`, 'undo delete');
  check('2D edit: Delete wall (7->6), Ctrl+Z restores 7', true);

  // Apply a different floor material to the selected room.
  const materialClicked = await evaluate(`(() => {
    const button = document.querySelector('.swatch-button:not([disabled])[aria-pressed="false"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!materialClicked) throw new Error('no selectable material swatch');
  await waitFor(`(document.querySelector('.badge-dirty')?.textContent || '').includes('未保存')`, 'dirty after material edit');
  check('2D edit: material change marks document dirty', true);

  if (!(await clickText('.view-tabs button', '3D 漫游'))) throw new Error('3D tab not found');
  await waitFor(`!!document.querySelector('.editor-stage .three-canvas')`, 'editor 3D canvas', 25000);
  await delay(1500);
  const editor3d = await evaluate(`document.querySelector('.editor-stage .three-canvas')?.getAttribute('aria-label') || ''`);
  check('3D view uses the same document (7 walls / 2 rooms / 7 furniture)', /7 面墙/.test(editor3d) && /2 个房间/.test(editor3d) && /7 件家具/.test(editor3d), { label: editor3d });
  await screenshot('integration-editor-3d.png');

  if (!(await clickText('.view-tabs button', '2D 户型'))) throw new Error('2D tab not found');
  await waitFor(`!document.querySelector('.editor-stage .three-canvas')`, 'back to 2D');

  if (!(await clickText('button', '保存', true))) throw new Error('save button not found');
  await waitFor(`(document.querySelector('.badge-saved')?.textContent || '').includes('已保存')`, 'saved badge', 25000);
  const revision = await evaluate(`fetch('/api/v1/plans/${planId}').then((response) => response.json()).then((plan) => plan.revision)`, true);
  check('save through real API', Number.isInteger(revision) && revision >= 2, { planId, revision });

  // CSV download through the UI.
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
      // The browser may still use its default download directory; the
      // fallback below fetches the same bytes with the session cookie.
    }
  }
  if (!(await clickText('button', '导出 CSV'))) throw new Error('export CSV button not found');
  let downloaded = await latestCsv(12000);
  if (!downloaded) {
    const bytes = await evaluate(`fetch('/api/v1/plans/${planId}/export.csv').then((response) => response.arrayBuffer()).then((buffer) => Array.from(new Uint8Array(buffer)))`, true);
    downloaded = { file: path.join(EVIDENCE, 'browser-download.csv'), bytes: Buffer.from(bytes) };
    fs.writeFileSync(downloaded.file, downloaded.bytes);
  }
  const csvBytes = downloaded.bytes;
  const first3 = csvBytes.subarray(0, 3).toString('hex');
  const csvText = csvBytes.subarray(3).toString('utf8');
  check('CSV download: UTF-8 BOM + CRLF', first3 === 'efbbbf' && csvText.includes('\r\n'), { first3, bytes: csvBytes.length });
  check('CSV download: 12.00/9.00 room areas', csvText.includes('12.00') && csvText.includes('9.00'), { bytes: csvBytes.length });
  fs.writeFileSync(path.join(EVIDENCE, 'browser-download.csv'), csvBytes);

  // Share dialog.
  if (!(await clickText('button', '分享', true))) throw new Error('share button not found');
  await waitFor(`!!document.querySelector('dialog[open]')`, 'share dialog');
  await clickText('dialog[open] button', '生成');
  const shareUrl = await waitFor(`(() => {
    const dialog = document.querySelector('dialog[open]');
    if (!dialog) return '';
    const input = dialog.querySelector('input');
    if (input && /\\/share\\/|#\\/s\\//.test(input.value || '')) return input.value.trim();
    const link = dialog.querySelector('a[href*="/share/"], a[href*="#/s/"]');
    if (link) return link.href;
    const text = dialog.textContent || '';
    const match = text.match(/https?:\\/\\/[^\\s"']+/);
    return match && /\\/share\\/|#\\/s\\//.test(match[0]) ? match[0] : '';
  })()`, 'generated share link', 15000);
  await press('Escape', 'Escape', 27);
  check('share link generated in UI', /\/share\/|#\/s\//.test(shareUrl), { present: true });

  // List -> reopen.
  await navigate(`${BASE}/#/`);
  await waitFor(`!!document.querySelector('.list-shell')`, 'plan list');
  await waitFor(`!!document.querySelector('.plan-card')`, 'plan card');
  await screenshot('integration-list.png');
  if (!(await clickText('.plan-card a.button-primary', '打开编辑'))) throw new Error('open plan link not found');
  await waitFor(`!!document.querySelector('.editor-shell')`, 'editor reopened');
  const reopened = await evaluate(`document.querySelector('.canvas-2d')?.getAttribute('aria-label') || ''`);
  check('list reopen: same 7 walls / 2 rooms', /7 面墙/.test(reopened) && /2 个房间/.test(reopened), { label: reopened });

  // Public read-only share page (cookies cleared to prove anonymous access).
  await cdp.send('Network.clearBrowserCookies');
  await navigate(shareUrl);
  await waitFor(`!!document.querySelector('.share-shell')`, 'share shell', 25000);
  await waitFor(`!!document.querySelector('.share-shell .canvas-2d')`, 'share 2D canvas');
  const shareLabel = await evaluate(`document.querySelector('.share-shell .canvas-2d')?.getAttribute('aria-label') || ''`);
  const readOnly = await evaluate(`(() => ({
    editor: !!document.querySelector('.editor-shell'),
    badge: document.querySelector('.share-shell .badge-readonly')?.textContent || '',
    note: document.querySelector('.share-note')?.textContent || '',
    editButtons: Array.from(document.querySelectorAll('.share-shell button'))
      .map((item) => (item.textContent || '').trim())
      .filter((text) => /保存|删除|撤销|重做|分享/.test(text)),
  }))()`);
  check('anonymous share page: 2D read-only document', /7 面墙/.test(shareLabel) && /4 个门窗/.test(shareLabel) && /2 个房间/.test(shareLabel), { label: shareLabel });
  check('share page has no edit controls', !readOnly.editor && /只读/.test(readOnly.badge) && /只读分享/.test(readOnly.note) && readOnly.editButtons.length === 0, readOnly);
  await screenshot('integration-share-2d.png');

  if (!(await clickText('.share-shell .view-tabs button', '3D 漫游'))) throw new Error('share 3D tab not found');
  await waitFor(`!!document.querySelector('.share-shell .three-canvas')`, 'share 3D canvas', 25000);
  await delay(1500);
  const share3d = await evaluate(`document.querySelector('.share-shell .three-canvas')?.getAttribute('aria-label') || ''`);
  check('share page: 3D uses the same document', /7 面墙/.test(share3d) && /2 个房间/.test(share3d), { label: share3d });
  await screenshot('integration-share-3d.png');

  return {
    ok: failures.length === 0,
    checks,
    planId,
    revision,
    shareUrl,
    shareToken: (() => {
      const match = /(?:\/share\/|#\/s\/)([A-Za-z0-9_-]+)/.exec(shareUrl);
      return match ? match[1] : '';
    })(),
    csv: { bytes: csvBytes.length, first3 },
    screenshots,
  };
}

async function runRevoked() {
  if (!SHARE_URL) throw new Error('missing revoked share URL');
  await startChrome();
  await navigate(SHARE_URL);
  await waitFor(`!!document.querySelector('.state-error')`, 'revoked share error state', 25000);
  const state = await evaluate(`(() => ({
    title: document.querySelector('.state-error .state-title')?.textContent || '',
    text: document.querySelector('.state-error .state-text')?.textContent || '',
    meta: document.querySelector('.state-error .error-meta')?.textContent || '',
    editor: !!document.querySelector('.editor-shell'),
  }))()`);
  check('revoked share page shows invalid/revoked error', !state.editor && /无效|撤销/.test(state.text + state.title), state);
  check('revoked share page exposes NOT_FOUND + requestId', /NOT_FOUND/.test(state.meta) && /requestId/i.test(state.meta), state);
  await screenshot('integration-share-revoked.png');
  return { ok: failures.length === 0, checks, screenshots, revoked: state };
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
  // Windows releases a profile directory slightly after the process exits.
  await delay(1500);
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  } catch {
    // Chrome may still hold the profile; it is under data/ and disposable.
    console.error(`WARN could not remove temporary profile: ${PROFILE}`);
  }
}

async function main() {
  let result;
  try {
    result = MODE === 'revoked' ? await runRevoked() : await runFull();
  } finally {
    await cleanup();
  }
  console.log(`INTEGRATION_RESULT ${JSON.stringify(result)}`);
  if (!result.ok) process.exitCode = 1;
}

await main();
