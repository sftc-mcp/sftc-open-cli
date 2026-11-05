#!/usr/bin/env node
/**
 * clite.js — 顺丰同城「一句话下单」业务动作层（Node 版）
 *
 * 与 clite.py 逻辑逐函数对齐，仅更换语言：
 *   - 零第三方依赖，只用 Node 内置模块（fetch / child_process / fs / path / crypto）
 *   - 选 Node 的理由：宿主环境（Claude Code、千问、元宝等 Agent 运行时）本身即 Node，Node 必然存在；
 *     而 macOS 12+ 已不再预装 python3，分发到他人机器可能跑不起来。
 *
 * 三层职责：
 *     SKILL.md    业务手册（动作清单 + 安全红线）
 *     clite.js    动作编排（业务动作 → MCP 工具、登录态管理、危险动作门禁、订单索引）
 *     (内置)      协议层（JSON-RPC over HTTP）
 *
 * 端点解析优先级：
 *     1. 环境变量 CLITE_MCP_URL / CLITE_MCP_CHANNEL
 *     2. 内置默认值（明文，用 `clite.js config` 查看）
 *
 * 本地状态：
 *     授权凭证 → macOS Keychain（service=clite-mcp-session）；其他平台为本地文件（0600）
 *     订单索引 → ~/.sf-intra-city-skill/orders.json（权限 0600）
 *
 * 退出码约定：
 *     0 成功 ｜ 1 一般/服务端错误 ｜ 2 参数错误或需要确认 ｜ 3 登录或权限问题
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ── 连接常量：明文。与顺丰官方专家包 defaults.json 的做法一致——
//    端点与渠道号属于「服务接入信息」，不是凭据，可随包分发。
//    真正的凭据（用户 token）只存在本机 Keychain / 本地文件，不进分发包。
const DEFAULT_ENDPOINT = 'https://bottc.sf-express.com/clite/mcp';
const CLI_VERSION = '1.0.0';
const DEFAULT_CHANNEL = '3001589';
const RESOURCE_METADATA_URL = 'https://bottc.sf-express.com/.well-known/oauth-protected-resource';
const FALLBACK_AS_METADATA_URL = 'https://bottc.sf-express.com/.well-known/oauth-authorization-server';

const KEYCHAIN_SERVICE = 'clite-mcp-session';
const KEYCHAIN_ACCOUNT = 'session';
const DATA_DIR = path.join(os.homedir(), '.sf-intra-city-skill');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const PENDING_FILE = path.join(DATA_DIR, 'oauth-pending.json');
const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 40000;
const LOGIN_TIMEOUT_MS = 180000;
const CLIENT_NAME = 'sf-intra-city-skill';
const OAUTH_SCOPE = 'mcp';

const EXIT_OK = 0, EXIT_ERROR = 1, EXIT_PARAM = 2, EXIT_AUTH = 3;

const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const CONTACT_REQUIRED = ['name', 'phone', 'lat', 'lng', 'cityId', 'cityName', 'street', 'building'];
const CONTACT_KEYS = ['name', 'phone', 'lat', 'lng', 'cityId', 'cityName', 'street', 'building', 'number', 'extNum'];
// 旧短信登录态没有 expires_at / refresh_token，OAuth 下不可再用
const CAPTCHA_STATUSES = ['need_captcha', 'captcha_invalid'];

// 每次运行生成一个可检索的链路 ID，随请求头下发。
// 服务端日志格式串含 %X{log-id} / %X{X-B3-TraceId}（MDC 字段，由框架从请求头注入），
// 带上它之后，出问题时可让服务端侧直接按此 ID 捞日志，不必靠时间盲猜。
const _logId = { value: null };

function currentLogId() {
  if (!_logId.value) {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    _logId.value = `clite-${ts}-${crypto.randomBytes(3).toString('hex')}`;
  }
  return _logId.value;
}

// ─────────────────────────── 输出与错误 ───────────────────────────

function fail(code, message, exitCode = EXIT_ERROR, extra = {}) {
  const out = { ok: false, code, message };
  if (_logId.value) out.log_id = _logId.value;
  Object.assign(out, extra);
  process.stderr.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(exitCode);
}

function emit(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

// ─────────────────────────── 本地订单索引 ───────────────────────────

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  } catch (e) {
    fail('[CONFIG_REQUIRED]', `无法创建本地数据目录 ${DATA_DIR}：${e.message}`, EXIT_ERROR);
  }
}

function loadOrders() {
  return readJson(ORDERS_FILE) || {};
}

function saveOrders(store) {
  ensureDataDir();
  const tmp = ORDERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, ORDERS_FILE);
}

function recordOrder(orderId, meta) {
  if (!orderId) return;
  const store = loadOrders();
  store[orderId] = meta;
  saveOrders(store);
}

/** 按订单号或支付单号查本机记录；查不到返回 null。 */
function findOrder(orderId) {
  if (!orderId) return null;
  const store = loadOrders();
  if (store[orderId]) return store[orderId];
  for (const rec of Object.values(store)) {
    if (rec && (rec.tc_order_id === orderId || rec.process_id === orderId)) return rec;
  }
  return null;
}

function isValidOrderId(id) {
  return !!id && ORDER_ID_RE.test(String(id));
}

// ─────────────────────────── 协议层 ───────────────────────────

function resolveConnection(token) {
  const url = process.env.CLITE_MCP_URL || DEFAULT_ENDPOINT;
  const channel = process.env.CLITE_MCP_CHANNEL || DEFAULT_CHANNEL;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    // 与官方客户端保持一致的来源标识（网关可能据此识别客户端来源）
    'X-Client': 'agent-skill',
  };
  if (channel) {
    // 服务端 Servlet 取 header 不区分大小写，但网关侧可能存在精确匹配，故沿用官方写法
    headers['Mcp-Channel'] = String(channel);
  }
  if (token) headers['Authorization'] = `Bearer ${token}`;
  headers['log-id'] = currentLogId();
  return { url, headers };
}

const _session = { id: null, done: false };

/** 按 MCP Streamable HTTP 规范先做 initialize 握手，取 Mcp-Session-Id。 */
async function ensureSession(token) {
  if (_session.done) return;
  _session.done = true;
  const { url, headers } = resolveConnection(token);
  const body = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sf-intra-city-skill', version: CLI_VERSION },
    },
  };
  try {
    const res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) {
      _session.id = sid;
      const noteHeaders = { ...headers, 'Mcp-Session-Id': sid };
      try {
        await fetchWithTimeout(url, {
          method: 'POST', headers: noteHeaders,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        }, 5000);
      } catch (e) { /* 通知失败不阻断 */ }
    }
  } catch (e) { /* 服务端无状态时拿不到 session，继续 */ }
}

async function fetchWithTimeout(url, opts, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 把服务端错误映射成本地错误码与退出码。 */
function classify(code, message) {
  const m = String(message || '').toLowerCase();
  if (m.includes('tool is not available') || m.includes('tool not found')) {
    return ['[MCP_TOOL_NOT_FOUND]', EXIT_ERROR];
  }
  if (m.includes('access_token')) return ['[AUTH_REQUIRED]', EXIT_AUTH];
  if (code === -32602 || m.includes('invalid argument')) return ['[PARAM_INVALID]', EXIT_PARAM];
  if (m.includes('auth') || m.includes('login') || m.includes('token')) return ['[AUTH_REQUIRED]', EXIT_AUTH];
  return ['[MCP_ERROR]', EXIT_ERROR];
}

/** JSON-RPC 调用。返回 { payload, err }；err 为 [code, message, exitCode] 或 null。 */
async function rpc(method, params) {
  let token = await getAccessToken();
  if (!token) return { payload: null, err: authRequired() };

  const body = { jsonrpc: '2.0', id: 1, method };
  if (params !== undefined) body.params = params;

  // 最多两次：首次 401 时用 refresh_token 续期后重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureSession(token);
    const { url, headers } = resolveConnection(token);
    if (_session.id) headers['Mcp-Session-Id'] = _session.id;

    let res, raw;
    try {
      res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      return { payload: null, err: ['[MCP_UNAVAILABLE]', `连不上服务：${e.message}`, EXIT_ERROR] };
    }

    try {
      raw = await res.text();
    } catch (e) {
      return { payload: null, err: ['[MCP_ERROR]', `读取响应失败：${e.message}`, EXIT_ERROR] };
    }

    if (res.status === 401 || res.status === 403) {
      if (attempt === 0) {
        const current = sessionLoad();
        const renewed = await refreshSession(current);
        if (renewed) {
          sessionSave({ ...current, ...renewed });
          token = renewed.access_token;
          continue;
        }
      }
      return { payload: null, err: authRequired() };
    }

    if (!res.ok) {
      return {
        payload: null,
        err: ['[MCP_UNAVAILABLE]', `服务返回 HTTP ${res.status}：${raw.slice(0, 200)}`, EXIT_ERROR],
      };
    }

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) { raw = line.slice(5).trim(); break; }
      }
    }

    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (e) {
      return { payload: null, err: ['[MCP_ERROR]', `响应不是合法 JSON：${raw.slice(0, 200)}`, EXIT_ERROR] };
    }

    if (envelope.error) {
      const [code, exitCode] = classify(envelope.error.code, envelope.error.message);
      return { payload: null, err: [code, envelope.error.message || '协议错误', exitCode] };
    }

    const result = envelope.result || {};
    let payload = null;
    for (const c of result.content || []) {
      if (c && c.type === 'text') {
        try {
          payload = JSON.parse(c.text);
        } catch (e) {
          payload = { message: c.text };
        }
        break;
      }
    }
    if (payload === null) payload = result.structuredContent || result;

    const status = payload && payload.status;
    if (status && CAPTCHA_STATUSES.includes(status)) {
      // 兼容旧版服务端：验证码类状态按成功返回
      return { payload, err: null };
    }
    if (result.isError || status === 'failed') {
      const [code, exitCode] = classify(payload.code !== undefined ? payload.code : payload.errno,
        payload.message);
      return { payload: null, err: [code, payload.message || '业务失败', exitCode] };
    }
    return { payload, err: null };
  }
  return { payload: null, err: authRequired() };
}

function callTool(name, args) {
  return rpc('tools/call', { name, arguments: args });
}

// ─────────────────────────── 授权凭证（OAuth 2.1 + PKCE） ───────────────────────────

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 仅本地读取 JWT 的 sub/exp（不验签），用于过期判断与订单归属提示。 */
function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function readSessionFile() {
  const data = readJson(SESSION_FILE);
  return data && typeof data === 'object' ? data : {};
}

function writeSessionFile(data) {
  ensureDataDir();
  const tmp = SESSION_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, SESSION_FILE);
}

function readStoredSession() {
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (out && out.trim()) return JSON.parse(out.trim());
    } catch (e) { /* 未登录 */ }
    return readSessionFile();
  }
  return readSessionFile();
}

/**
 * 读取登录态。CLITE_TOKEN 环境变量优先，用于 CI / 容器场景：
 * 从密钥管理注入一次性 access token，跳过浏览器授权。
 */
function sessionLoad() {
  // 1) CLITE_SESSION：完整会话 JSON，支持自动 refresh，适合 CI / 容器
  const rawSession = (process.env.CLITE_SESSION || '').trim();
  if (rawSession) {
    try {
      const parsed = JSON.parse(rawSession);
      if (parsed && parsed.access_token) return Object.assign({}, parsed, { source: 'env' });
    } catch (e) { /* 解析失败则继续尝试 CLITE_TOKEN */ }
  }

  // 2) CLITE_TOKEN：仅 access token，跳过浏览器授权（过期后需重新注入）
  const envToken = (process.env.CLITE_TOKEN || '').trim();
  if (envToken) {
    return { access_token: envToken, expires_at: null, refresh_token: null, subject: null, source: 'env' };
  }

  return readStoredSession();
}

function sessionSave(data) {
  if (process.platform === 'darwin') {
    try {
      execFileSync('security',
        ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT,
          '-w', JSON.stringify(data), '-U'],
        { encoding: 'utf8', timeout: 5000 });
      return;
    } catch (e) {
      // Keychain 不可用时退化为本地文件，避免受限环境下完全不可用
    }
  }
  writeSessionFile(data);
}

function sessionClear() {
  try {
    execFileSync('security',
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { /* 本来就没有 */ }
  try { fs.unlinkSync(SESSION_FILE); } catch (e) { /* 本来就没有 */ }
  try { fs.unlinkSync(PENDING_FILE); } catch (e) { /* 本来就没有 */ }
}

function savePending(data) {
  ensureDataDir();
  fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(PENDING_FILE, 0o600);
}

function loadPending() {
  return readJson(PENDING_FILE);
}

function isTokenExpired(s) {
  if (!s || !s.access_token) return true;
  if (!s.expires_at) return false; // 无法判断时交给服务端 401 兜底
  return Math.floor(Date.now() / 1000) >= Number(s.expires_at) - 30;
}

function authRequired(message) {
  return ['[AUTH_REQUIRED]',
    message || '授权已失效。请执行：node scripts/clite.js login 完成浏览器授权后重试',
    EXIT_AUTH];
}

async function discover() {
  let asUrl = null;
  try {
    const res = await fetchWithTimeout(RESOURCE_METADATA_URL, { method: 'GET' }, 15000);
    if (res.ok) {
      const meta = await res.json();
      if (Array.isArray(meta.authorization_servers) && meta.authorization_servers.length) {
        asUrl = String(meta.authorization_servers[0]);
      }
    }
  } catch (e) { /* 回退到固定元数据地址 */ }

  const candidates = [];
  if (asUrl) candidates.push(asUrl.replace(/\/+$/, '') + '/.well-known/oauth-authorization-server');
  candidates.push(FALLBACK_AS_METADATA_URL);

  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(url, { method: 'GET' }, 15000);
      if (!res.ok) continue;
      const meta = await res.json();
      if (meta.authorization_endpoint && meta.token_endpoint && meta.registration_endpoint) return meta;
    } catch (e) { /* 尝试下一个 */ }
  }
  fail('[OAUTH_DISCOVERY_FAILED]', '无法获取授权服务元数据，请检查网络后重试', EXIT_ERROR);
}

function withQuery(url, params) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function pkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function registerClient(meta, redirectUri) {
  const res = await fetchWithTimeout(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      scope: OAUTH_SCOPE,
    }),
  }, 15000);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* ignore */ }
  if (res.status === 201 && data && data.client_id) return data.client_id;
  if (res.status === 400 && data && data.error === 'invalid_redirect_uri') {
    fail('[OAUTH_REGISTER_FAILED]',
      `授权服务拒绝了本机回调地址 ${redirectUri}。请联系管理员确认回调域名白名单。`, EXIT_ERROR);
  }
  fail('[OAUTH_REGISTER_FAILED]',
    `授权客户端注册失败（HTTP ${res.status}）：${String(text).slice(0, 200)}`, EXIT_ERROR);
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 起本地回环回调服务（仅 127.0.0.1），返回 { port, wait(), close() }。 */
function startCallbackServer(port, expectedState, timeoutMs) {
  return new Promise((resolve, reject) => {
    let resolveDone, rejectDone;
    const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
    // 避免 print-url 等场景下 done 未被 await 时产生 unhandled rejection
    done.catch(() => {});
    let finished = false;
    let timer = null;

    const server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
      } catch (e) { return; }
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(error
        ? `<html><body><h3>授权失败</h3><p>${escapeHtml(error)}</p><p>请回到命令行重试。</p></body></html>`
        : '<html><body><h3>授权完成</h3><p>可以关闭此页面，回到命令行继续。</p></body></html>');
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close();
      if (error) return rejectDone(new Error(`授权被拒绝：${error}`));
      if (!code) return rejectDone(new Error('回调缺少 code 参数'));
      if (expectedState && state !== expectedState) return rejectDone(new Error('state 校验失败'));
      resolveDone({ code, state });
    });

    server.once('error', (e) => {
      if (server.listening) rejectDone(e);
      else reject(e);
    });

    server.listen(port, '127.0.0.1', () => {
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        server.close();
        rejectDone(new Error('等待授权超时'));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      resolve({
        port: server.address().port,
        wait: () => done,
        close: () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          server.close();
          rejectDone(new Error('已取消'));
        },
      });
    });
  });
}

async function exchangeToken(meta, { code, verifier, redirectUri, clientId }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const res = await fetchWithTimeout(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: body.toString(),
  }, 15000);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* ignore */ }
  if (!res.ok || !data || !data.access_token) {
    const reason = (data && (data.error_description || data.error)) || String(text).slice(0, 200);
    fail('[OAUTH_TOKEN_FAILED]', `换取授权凭证失败（HTTP ${res.status}）：${reason}`, EXIT_ERROR);
  }
  return data;
}

function buildSession(tokens, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = decodeJwtPayload(tokens.access_token) || {};
  const expiresIn = Number(tokens.expires_in);
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || null,
    token_type: tokens.token_type || 'Bearer',
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn : (payload.exp || null),
    subject: payload.sub || payload.empId || null,
    client_id: extra.client_id || null,
    redirect_uri: extra.redirect_uri || null,
    token_endpoint: extra.token_endpoint || null,
    saved_at: now,
  };
}

/** 用 refresh_token 续期；成功返回新会话对象，失败返回 null。 */
async function refreshSession(s) {
  if (!s || !s.refresh_token || !s.token_endpoint || !s.client_id) return null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: s.refresh_token,
    client_id: s.client_id,
  });
  let res;
  try {
    res = await fetchWithTimeout(s.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: body.toString(),
    }, 15000);
  } catch (e) {
    return null;
  }
  if (!res.ok) return null;
  let data = null;
  try { data = await res.json(); } catch (e) { return null; }
  if (!data || !data.access_token) return null;
  const renewed = buildSession(data, {
    client_id: s.client_id,
    redirect_uri: s.redirect_uri,
    token_endpoint: s.token_endpoint,
  });
  if (!renewed.refresh_token) renewed.refresh_token = s.refresh_token;
  return renewed;
}

/** 取可用 access_token；过期则自动续期。取不到返回 null。 */
async function getAccessToken() {
  const s = sessionLoad();
  if (!s.access_token) return null;
  // 旧短信登录态（无 expires_at / refresh_token）在 OAuth 下不可用；环境变量注入的除外
  if (s.source !== 'env' && !s.expires_at && !s.refresh_token) return null;
  if (!isTokenExpired(s)) return s.access_token;
  if (s.refresh_token) {
    const renewed = await refreshSession(s);
    if (renewed) {
      // 环境变量模式下不回写本机凭证，避免污染本地登录态
      if (s.source !== 'env') sessionSave({ ...s, ...renewed });
      return renewed.access_token;
    }
  }
  return s.access_token || null;
}

// ─────────────────────────── 地址联系人归一化 ───────────────────────────

/** 在返回里递归找出所有带坐标的候选地址，归一化为可用的联系人对象。 */
function collectContacts(payload) {
  const rawNodes = [];
  const seen = new Set();

  function walk(node, depth = 0) {
    if (depth > 10 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
    } else if (typeof node === 'object') {
      if ('lat' in node && 'lng' in node) {
        const key = JSON.stringify(node);
        if (!seen.has(key)) { seen.add(key); rawNodes.push(node); }
      }
      for (const v of Object.values(node)) walk(v, depth + 1);
    }
  }

  walk(payload);

  return rawNodes.map((node) => {
    const c = {};
    for (const k of CONTACT_KEYS) {
      const snake = k.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase();
      const v = node[k] !== undefined ? node[k] : node[snake];
      c[k] = v === null || v === undefined ? '' : v;
    }
    const n = Number(c.cityId);
    c.cityId = Number.isFinite(n) ? n : null;
    const missing = CONTACT_REQUIRED.filter((k) => !c[k]);
    return { contact: c, missing, usable_for_quote: missing.length === 0 };
  });
}

function parseAddr(inline, file, label) {
  let raw = null;
  if (file) {
    raw = readJson(file);
    if (raw === null) fail('[PARAM_INVALID]', `读不到${label}地址文件：${file}`, EXIT_PARAM);
  } else if (inline) {
    try {
      raw = JSON.parse(inline);
    } catch (e) {
      fail('[PARAM_INVALID]', `${label}地址的 JSON 解析失败：${e.message}`, EXIT_PARAM);
    }
  } else {
    fail('[PARAMS_MISSING]',
      `缺少${label}地址。用 --from-addr-json/--to-addr-json 传入 addr 输出的 contact`, EXIT_PARAM);
  }

  const missing = CONTACT_REQUIRED.filter((k) => !raw[k]);
  if (missing.length) {
    fail('[PARAM_INVALID]',
      `${label}地址缺少必要字段：${missing.join(', ')}。请先用 addr 命令解析地址，` +
      '直接使用其返回的 contact 对象', EXIT_PARAM);
  }
  const n = Number(raw.cityId);
  if (!Number.isFinite(n)) fail('[PARAM_INVALID]', `${label}地址的 cityId 必须是数字`, EXIT_PARAM);
  raw.cityId = n;
  return raw;
}

// ─────────────────────────── 业务动作 ───────────────────────────

async function actConfig() {
  const { url, headers } = resolveConnection();
  const overridden = [];
  if (process.env.CLITE_MCP_URL) overridden.push('端点←环境变量');
  if (process.env.CLITE_MCP_CHANNEL) overridden.push('渠道号←环境变量');
  emit({
    ok: true,
    endpoint: url,
    channel: headers['Mcp-Channel'] || null,
    source: overridden.length ? overridden.join('、') : '内置默认值',
    data_dir: DATA_DIR,
    note: '换环境可设 CLITE_MCP_URL / CLITE_MCP_CHANNEL 覆盖',
  });
}

async function actTools() {
  const { payload, err } = await rpc('tools/list', {});
  if (err) fail(...err);
  const tools = (payload.tools || []).map((t) => ({
    name: t.name,
    description: (t.description || '').trim(),
    required: (t.inputSchema || {}).required || [],
  }));
  emit({ ok: true, count: tools.length, tools });
}

async function actLogin(a) {
  const meta = await discover();

  // 模式一：用浏览器回调 URL 完成（无浏览器 / 远程环境）
  if (a.redirectUrl) {
    const pending = loadPending();
    if (!pending) {
      fail('[PARAMS_MISSING]', '没有待完成的授权请求。请先执行 login --print-url 获取授权链接', EXIT_PARAM);
    }
    let parsed;
    try {
      parsed = new URL(a.redirectUrl);
    } catch (e) {
      fail('[PARAM_INVALID]', '--redirect-url 不是合法 URL，请粘贴完整的回调地址', EXIT_PARAM);
    }
    const error = parsed.searchParams.get('error');
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    if (error) fail('[OAUTH_DENIED]', `授权被拒绝：${error}`, EXIT_AUTH);
    if (!code) fail('[PARAM_INVALID]', '回调 URL 中缺少 code 参数', EXIT_PARAM);
    if (pending.state && state !== pending.state) {
      fail('[OAUTH_STATE_MISMATCH]', 'state 校验失败，请重新执行 login', EXIT_AUTH);
    }
    const tokens = await exchangeToken(meta, {
      code,
      verifier: pending.verifier,
      redirectUri: pending.redirect_uri,
      clientId: pending.client_id,
    });
    const session = buildSession(tokens, {
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      token_endpoint: meta.token_endpoint,
    });
    sessionSave(session);
    try { fs.unlinkSync(PENDING_FILE); } catch (e) { /* 已删除 */ }
    emit({ ok: true, stage: 'login', logged_in: true, subject: session.subject, note: '授权完成，凭证已保存' });
    return;
  }

  // 优先复用上次注册的端口：client 与 redirect_uri 严格绑定
  const prev = sessionLoad();
  let preferredPort = 0;
  if (prev.redirect_uri) {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(prev.redirect_uri);
    if (m) preferredPort = Number(m[1]);
  }

  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString('base64url');
  const timeoutMs = a.timeout ? Number(a.timeout) * 1000 : LOGIN_TIMEOUT_MS;

  let server;
  try {
    server = await startCallbackServer(preferredPort, state, timeoutMs);
  } catch (e) {
    if (e && e.code !== 'EADDRINUSE') {
      fail('[OAUTH_ERROR]', `无法启动本机回调服务：${e.message}`, EXIT_ERROR);
    }
    server = await startCallbackServer(0, state, timeoutMs);
  }

  const redirectUri = `http://127.0.0.1:${server.port}/oauth/callback`;
  const clientId = (prev.client_id && prev.redirect_uri === redirectUri)
    ? prev.client_id
    : await registerClient(meta, redirectUri);

  const authUrl = withQuery(meta.authorization_endpoint, {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: OAUTH_SCOPE,
  });

  // 只输出链接：不等待回调，之后用 login --redirect-url 完成
  if (a.printUrl) {
    server.close();
    savePending({
      client_id: clientId,
      redirect_uri: redirectUri,
      verifier,
      state,
      created_at: Math.floor(Date.now() / 1000),
    });
    emit({
      ok: true,
      stage: 'login',
      browser_required: true,
      auth_url: authUrl,
      next: '请让用户在浏览器打开 auth_url 完成登录；若回调页打不开，复制地址栏完整 URL 后执行：' +
        'login --redirect-url "<回调URL>"',
    });
    return;
  }

  const opened = openBrowser(authUrl);

  // 无浏览器环境（沙箱 / 远程 / 无 GUI）：不空等超时，立即返回可执行指引，
  // 并保存待完成授权，之后可用 --redirect-url 完成。
  if (!opened) {
    server.close();
    savePending({
      client_id: clientId,
      redirect_uri: redirectUri,
      verifier,
      state,
      created_at: Math.floor(Date.now() / 1000),
    });
    emit({
      ok: true,
      stage: 'login',
      browser_required: true,
      browser_opened: false,
      auth_url: authUrl,
      next: '当前环境无法自动打开浏览器。请让用户在浏览器打开 auth_url 完成登录；' +
        '若回调页打不开，复制地址栏完整 URL 后执行：login --redirect-url "<回调URL>"',
    });
    return;
  }

  emit({
    ok: true,
    stage: 'login_waiting',
    browser_opened: true,
    auth_url: authUrl,
    next: `请在浏览器完成登录授权，命令会等待回调（最长 ${Math.round(timeoutMs / 1000)} 秒）`,
  });

  let result;
  try {
    result = await server.wait();
  } catch (e) {
    server.close();
    fail('[OAUTH_TIMEOUT]', `${e.message}。可改用 login --print-url 获取链接后手动完成`, EXIT_ERROR);
  }

  const tokens = await exchangeToken(meta, {
    code: result.code,
    verifier,
    redirectUri,
    clientId,
  });
  const session = buildSession(tokens, {
    client_id: clientId,
    redirect_uri: redirectUri,
    token_endpoint: meta.token_endpoint,
  });
  sessionSave(session);
  emit({
    ok: true, stage: 'login', logged_in: true,
    subject: session.subject,
    note: '授权完成，凭证已保存，后续动作自动携带',
  });
}

async function actWhoami() {
  const s = sessionLoad();
  if (!s.access_token) {
    emit({ ok: true, logged_in: false, next: '执行 node scripts/clite.js login 完成浏览器授权' });
    return;
  }
  if (s.source !== 'env' && !s.expires_at && !s.refresh_token) {
    emit({
      ok: true, logged_in: false, code: '[AUTH_REQUIRED]',
      message: '旧版短信登录态已失效，请重新授权',
      next: '执行 node scripts/clite.js login',
    });
    return;
  }
  const token = await getAccessToken();
  if (!token) {
    emit({
      ok: true, logged_in: false, code: '[AUTH_REQUIRED]', message: '授权已失效',
      next: '执行 node scripts/clite.js login',
    });
    return;
  }
  const { payload, err } = await callTool('open_city_list', {});
  if (err && err[0] === '[AUTH_REQUIRED]') {
    emit({
      ok: true, logged_in: true, token_valid: false, code: '[AUTH_REQUIRED]',
      message: '授权已失效', next: '执行 node scripts/clite.js login',
    });
    return;
  }
  emit({
    ok: !err, logged_in: true, token_valid: !err,
    subject: sessionLoad().subject || null,
    detail: err ? err[1] : payload,
  });
}

async function actLogout() {
  sessionClear();
  emit({ ok: true, note: '本地登录态已清除' });
}

async function actCities() {
  const { payload, err } = await callTool('open_city_list', {});
  if (err) fail(...err);
  emit({ ok: true, result: payload });
}

async function actOrders() {
  const store = loadOrders();
  const items = Object.entries(store).map(([k, rec]) => ({ ...rec, order_key: k }));
  items.sort((x, y) => (y.created_at || 0) - (x.created_at || 0));
  emit({ ok: true, count: items.length, orders: items, note: '只包含本机成功发出的订单' });
}

async function actAddr(a) {
  const args = { address_type: a.side };
  if (a.keyword) args.keyword = a.keyword;
  if (a.addressId) args.address_id = a.addressId;
  if (a.cityId !== undefined) args.city_id = Number(a.cityId);
  if (a.cityName) args.city_name = a.cityName;

  const { payload, err } = await callTool('resolve_order_address', args);
  if (err) {
    let [code, message, exitCode] = err;
    if (String(message).toLowerCase().includes('address')) code = '[GEOCODE_FAILED]';
    fail(code, message, exitCode);
  }

  const contacts = collectContacts(payload);
  const usable = contacts.filter((c) => c.usable_for_quote);
  const out = {
    ok: true, side: a.side,
    candidate_count: contacts.length,
    candidates: contacts,
    raw: payload,
  };
  if (usable.length > 1) {
    out.next = '匹配到多个候选，请列给用户选择，不要替用户决定；选中的 contact 直接用于 quote';
  } else if (usable.length === 1) {
    out.next = '把 contact 对象直接用于 quote 的 --from/--to-addr-json';
  } else {
    out.next = '没有可直接使用的候选，请看 missing 字段缺什么，或请用户补充更详细的地址';
  }
  emit(out);
}

async function actOptions(a) {
  const args = {};
  if (a.productType !== undefined) args.product_type = Number(a.productType);
  if (a.productName) args.product_name = a.productName;
  if (a.cityId !== undefined) args.city_id = Number(a.cityId);
  const { payload, err } = await callTool('get_order_options', args);
  if (err) fail(...err);
  emit({ ok: true, result: payload });
}

async function actQuote(a) {
  const sender = parseAddr(a.fromAddrJson, a.fromAddrFile, '寄件方');
  const receiver = parseAddr(a.toAddrJson, a.toAddrFile, '收件方');

  const args = {
    sender, receiver,
    product_type: Number(a.productType),
    product_name: a.productName,
    product_weight: Number(a.productWeight),
  };
  if (a.remark) args.remark = a.remark;
  // 取件时间固定「立即取件」：该字段仅为服务端必传兜底，不向用户暴露选择
  args.expect_pickup_time = a.expectPickupTime ? Number(a.expectPickupTime) : 0;

  const { payload, err } = await callTool('preview_order', args);
  if (err) {
    let [code, message, exitCode] = err;
    if (String(message).toLowerCase().includes('expire')) code = '[ESTIMATE_INVALID]';
    fail(code, message, exitCode);
  }

  ensureDataDir();
  const outFile = a.out
    || path.join(DATA_DIR, `quote-${String(payload.preview_id || 'latest').slice(0, 8)}.json`);
  fs.writeFileSync(outFile, JSON.stringify(payload.confirm_order_data || {}, null, 2),
    { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(outFile, 0o600);

  emit({
    ok: true, stage: 'quote',
    price: payload.user_money || payload.shop_pay_price,
    discount_money: payload.discount_money,
    distance: payload.distance,
    expect_time_name: payload.expect_time_name,
    sender: payload.sender, receiver: payload.receiver,
    product: payload.product,
    quote_file: outFile,
    next: `把价格与收寄件信息告知用户并取得明确同意，才可执行 place --preview-file ${outFile} --yes`,
  });
}

async function actPlace(a) {
  if (!a.yes) {
    fail('[CONFIRM_REQUIRED]',
      '拒绝执行：真实发单属于不可逆写操作。' +
      '必须确认用户已明确同意该价格与订单内容后，再追加 --yes。', EXIT_PARAM);
  }

  const data = readJson(a.previewFile);
  if (!data) {
    fail('[ESTIMATE_INVALID]', `读不到报价数据：${a.previewFile}。请先执行 quote。`, EXIT_PARAM);
  }

  const args = {};
  args.confirm_order_data = data;
  const { payload, err } = await callTool('confirm_order', args);
  if (err) {
    const message = err[1] || '';
    if (message.includes('未知') || message.toLowerCase().includes('unknown')) {
      fail('[CONFIRMATION_UNKNOWN]',
        '发单结果未知，请勿重试。请用 show 核实订单是否已产生，或让用户到顺丰同城 App 核实。',
        EXIT_PARAM);
    }
    fail(...err);
  }

  const orderId = payload.order_id || payload.tc_order_id;
  recordOrder(orderId, {
    subject: sessionLoad().subject || null,
    created_at: Math.floor(Date.now() / 1000),
    order_id: payload.order_id,
    tc_order_id: payload.tc_order_id,
    process_id: payload.process_id,
    prepay_bill_id: payload.prepay_bill_id,
    pay_amount: payload.pay_amount,
    payment_required: payload.payment_required,
  });

  const out = {
    ok: true, stage: 'place',
    order_id: orderId,
    tc_order_id: payload.tc_order_id,
    pay_amount: payload.pay_amount,
    payment_required: payload.payment_required,
  };
  out.next = payload.payment_required === false
    ? '该订单无需用户支付，可直接告知用户下单成功'
    : `告知用户下单成功，并提示 15 分钟内完成支付；执行 pay --order-id ${orderId} --method WX|ALI 获取支付方式`;
  emit(out);

  try { fs.unlinkSync(a.previewFile); } catch (e) { /* 已删除 */ }
}

async function actPay(a) {
  const rec = findOrder(a.orderId) || {};
  const tcOrderId = a.tcOrderId || rec.tc_order_id || a.orderId;
  const processId = a.processId || rec.process_id;
  const prepayBillId = a.prepayBillId || rec.prepay_bill_id;
  const amount = a.amount !== undefined ? a.amount : rec.pay_amount;

  const missing = [];
  if (!processId) missing.push('process_id');
  if (!prepayBillId) missing.push('prepay_bill_id');
  if (!amount) missing.push('amount');
  if (missing.length) {
    fail('[PARAMS_MISSING]',
      `缺少支付参数：${missing.join(', ')}。该订单不在本机记录中时需显式传入对应参数。`,
      EXIT_PARAM);
  }

  const args = {
    tc_order_id: tcOrderId,
    process_id: processId,
    prepay_bill_id: prepayBillId,
    amount: Number(amount),
    pay_method: a.method,
  };
  if (a.redirectUrl) args.redirect_url = a.redirectUrl;

  const { payload, err } = await callTool('prepare_order_payment', args);
  if (err) fail(...err);
  emit({
    ok: true, stage: 'pay', result: payload,
    note: '返回的是待拉起支付的参数，不代表已支付；请提示用户 15 分钟内完成支付',
  });
}

async function actShow(a) {
  if (!isValidOrderId(a.orderId)) fail('[ORDER_ID_INVALID]', '订单号格式不正确', EXIT_PARAM);
  const args = {};
  args.order_id = a.orderId;
  const { payload, err } = await callTool('get_order_detail', args);
  if (err) fail(...err);
  const out = { ok: true, result: payload };
  const rec = findOrder(a.orderId);
  const subject = sessionLoad().subject;
  if (rec && rec.subject && subject && rec.subject !== subject) {
    out.warning = '该订单不是当前登录用户在本机下的单，请谨慎处理';
  }
  emit(out);
}

/** 查取消扣费。返回对象或 null（查询失败时不阻断取消）。 */
async function queryCancelFee(tcOrderId) {
  const args = {};
  args.tc_order_id = tcOrderId;
  const { payload, err } = await callTool('get_cancel_reason', args);
  if (err || !payload || typeof payload !== 'object') return null;

  const pick = (...names) => {
    for (const n of names) if (payload[n] !== undefined && payload[n] !== null) return payload[n];
    return undefined;
  };

  const rawFee = pick('deductionsAmount', 'deductions_amount', 'deductionFee', 'deduction_fee');
  let fee = 0;
  if (rawFee !== undefined && rawFee !== '') {
    const n = Number(rawFee);
    fee = Number.isFinite(n) ? n : 0;
  }

  const rawReasons = pick('reasonList', 'reason_list') || [];
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter((r) => r && typeof r === 'object').map((r) => ({
      reason_id: r.reasonId !== undefined ? r.reasonId : r.reason_id,
      reason_desc: r.reasonDesc !== undefined ? r.reasonDesc : r.reason_desc,
    }))
    : [];

  return {
    fee,
    order_status: pick('orderStatus', 'order_status'),
    reason_list: reasons,
    raw: payload,
  };
}

async function actReasons(a) {
  if (!isValidOrderId(a.orderId)) fail('[ORDER_ID_INVALID]', '订单号格式不正确', EXIT_PARAM);

  const rec = findOrder(a.orderId) || {};
  const tcOrderId = rec.tc_order_id || a.orderId;
  const info = await queryCancelFee(tcOrderId);
  if (!info) fail('[MCP_UNAVAILABLE]', '查询取消费用失败，请稍后重试', EXIT_ERROR);

  const out = {
    ok: true,
    order_id: a.orderId,
    deduction_fee: info.fee,
    deduction_fee_yuan: info.fee.toFixed(2),
    order_status: info.order_status,
    reason_list: info.reason_list,
  };
  out.next = info.fee > 0
    ? '取消将产生扣费，必须先把金额与规则告知用户，取得同意后再 cancel --yes'
    : '当前取消不产生扣费，取得用户同意后执行 cancel --yes';
  emit(out);
}

async function actCancel(a) {
  if (!isValidOrderId(a.orderId)) fail('[ORDER_ID_INVALID]', '订单号格式不正确', EXIT_PARAM);

  const rec = findOrder(a.orderId);
  const subject = sessionLoad().subject;

  // 归属校验：本机记录属主与当前登录用户不一致 → 直接拒绝
  if (rec && rec.subject && subject && rec.subject !== subject) {
    fail('[FORBIDDEN]', '该订单不属于当前登录用户，拒绝操作', EXIT_AUTH);
  }

  // 本机无记录的订单：取消是资金相关操作，必须显式二次确认
  if (!rec && !a.yes) {
    fail('[CONFIRM_REQUIRED]',
      '该订单不在本机下单记录中，取消属于资金相关操作。' +
      '请与用户确认这是本人订单后，追加 --yes 重试。', EXIT_PARAM);
  }

  const tcOrderId = (rec || {}).tc_order_id || a.orderId;

  // 扣费前置检查（防「支付 10 元只退 8 元」类客诉）
  const info = await queryCancelFee(tcOrderId);
  if (info && info.fee > 0 && !a.yes) {
    fail('[FEE_CONFIRM_REQUIRED]',
      '取消该订单将产生扣费。必须先把扣款金额与规则原原本本告知用户，' +
      '取得明确同意后再追加 --yes 重试。',
      EXIT_PARAM,
      {
        deduction_fee: info.fee,
        deduction_fee_yuan: info.fee.toFixed(2),
        order_status: info.order_status,
        reason_list: info.reason_list,
      });
  }

  const args = {};
  args.tc_order_id = tcOrderId;
  const { payload, err } = await callTool('cancel_order', args);
  if (err) fail(...err);

  const out = { ok: true, stage: 'cancel', order_id: a.orderId, result: payload };
  if (info && info.fee > 0) out.deduction_fee_yuan = info.fee.toFixed(2);
  emit(out);

  const store = loadOrders();
  if (store[a.orderId]) {
    store[a.orderId].cancelled_at = Math.floor(Date.now() / 1000);
    saveOrders(store);
  }
}

async function actRaw(a) {
  let arguments_ = {};
  if (a.args) {
    try {
      arguments_ = JSON.parse(a.args);
    } catch (e) {
      fail('[PARAM_INVALID]', `--args 不是合法 JSON：${e.message}`, EXIT_PARAM);
    }
  }
  const { payload, err } = await callTool(a.tool, arguments_);
  if (err) fail(...err);
  emit({ ok: true, result: payload });
}

// ─────────────────────────── CLI ───────────────────────────

function skillRootDir() {
  return path.resolve(__dirname, '..');
}

async function actSkill(a) {
  const action = (a._args && a._args[0]) || 'install';
  const rootDir = path.resolve(a.root || path.join(os.homedir(), '.claude', 'skills'));
  const dest = path.join(rootDir, 'sf-intra-city-skill');
  const src = skillRootDir();
  const srcSkillMd = path.join(src, 'SKILL.md');
  const srcCli = path.join(src, 'scripts', 'clite.js');
  const srcPkg = path.join(src, 'package.json');

  if (action === 'uninstall') {
    let owned = false;
    try {
      owned = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8').includes('name: sf-intra-city-skill');
    } catch (e) { /* 目录不存在 */ }
    if (!fs.existsSync(dest)) {
      emit({ ok: true, action: 'uninstall', target: dest, removed: false, note: '目标目录不存在，无需卸载' });
      return;
    }
    if (!owned) {
      fail('[PARAM_INVALID]', `目标目录不是本技能：${dest}，已拒绝删除`, EXIT_PARAM);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    emit({ ok: true, action: 'uninstall', target: dest, removed: true });
    return;
  }

  if (action !== 'install') {
    fail('[PARAM_INVALID]', `未知的 skill 子命令：${action}（可用：install / uninstall）`, EXIT_PARAM);
  }

  if (!fs.existsSync(srcSkillMd)) {
    fail('[CONFIG_REQUIRED]', '未找到 SKILL.md，无法安装为技能', EXIT_ERROR);
  }

  // 覆盖安装：目标已存在时，仅当确认是本技能才清理，避免误删他人目录
  if (fs.existsSync(dest)) {
    let owned = false;
    try {
      owned = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8').includes('name: sf-intra-city-skill');
    } catch (e) { /* 无 SKILL.md */ }
    if (!owned) fail('[PARAM_INVALID]', `目标目录已存在且不是本技能：${dest}，已拒绝覆盖`, EXIT_PARAM);
    fs.rmSync(dest, { recursive: true, force: true });
  }

  fs.mkdirSync(path.join(dest, 'scripts'), { recursive: true });
  fs.copyFileSync(srcSkillMd, path.join(dest, 'SKILL.md'));
  fs.copyFileSync(srcCli, path.join(dest, 'scripts', 'clite.js'));
  if (fs.existsSync(srcPkg)) fs.copyFileSync(srcPkg, path.join(dest, 'package.json'));
  fs.chmodSync(path.join(dest, 'scripts', 'clite.js'), 0o755);

  emit({
    ok: true,
    action: 'install',
    target: dest,
    files: ['SKILL.md', 'scripts/clite.js', 'package.json'],
    next: '重启客户端的会话后即可在对话中使用「顺丰同城急送」技能',
  });
}

async function actVersion() {
  emit({
    ok: true,
    name: 'sftc-open-cli',
    version: CLI_VERSION,
    runtime: `node ${process.version}`,
    platform: process.platform,
    api: 'MCP 2025-06-18',
  });
}

const COMMANDS = {
  version: { fn: actVersion, help: '显示 CLI 版本与运行环境' },
  skill: { fn: actSkill, help: '安装/卸载为 AI 客户端技能（install|uninstall）' },
  config: { fn: actConfig, help: '显示当前生效的连接配置' },
  tools: { fn: actTools, help: '列出服务端当前可用工具' },
  orders: { fn: actOrders, help: '列出本机发过的订单' },
  login: { fn: actLogin, help: '浏览器授权登录（OAuth 2.1 + PKCE）' },
  whoami: { fn: actWhoami, help: '查看当前授权状态' },
  logout: { fn: actLogout, help: '清除本地登录态' },
  cities: { fn: actCities, help: '查询已开通服务的城市' },
  addr: { fn: actAddr, help: '解析或推荐下单地址' },
  options: { fn: actOptions, help: '查询可选物品类型与重量规则' },
  quote: { fn: actQuote, help: '预下单计价（不产生订单）' },
  place: { fn: actPlace, help: '真实发单（需 --yes）' },
  pay: { fn: actPay, help: '生成支付参数（其余参数自动从订单索引取）' },
  show: { fn: actShow, help: '查询订单详情' },
  reasons: { fn: actReasons, help: '查询取消费用与可用原因' },
  cancel: { fn: actCancel, help: '取消订单（先不带 --yes 看扣费，确认后再带）' },
  raw: { fn: actRaw, help: '逃生舱：直接调用指定工具' },
};

/** 把 --some-flag 转成 camelCase key */
function toCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function parseArgv(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith('--')) { positional.push(tok); continue; }
    const key = toCamel(tok.slice(2));
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i++;
    }
  }
  opts._args = positional;
  return { cmd, opts };
}

function usage() {
  const lines = ['顺丰同城急送（业务动作层，自包含，无需任何 MCP 配置）', '', '用法: sftc-open-cli <命令> [选项]', '', '命令:'];
  for (const [name, spec] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(9)} ${spec.help}`);
  }
  lines.push('', '示例:');
  lines.push('  sftc-open-cli config');
  lines.push('  sftc-open-cli login                         # 打开浏览器完成授权');
  lines.push('  sftc-open-cli login --print-url             # 只输出授权链接（无浏览器环境）');
  lines.push('  sftc-open-cli login --redirect-url "<回调URL>"  # 用粘贴的回调地址完成');
  lines.push('  sftc-open-cli addr --side sender --keyword "北京市朝阳区望京SOHO"');
  lines.push('  sftc-open-cli quote --from-addr-json \'<寄件方>\' --to-addr-json \'<收件方>\' \\');
  lines.push('                 --product-type 12 --product-name 文件 --product-weight 1');
  lines.push('  sftc-open-cli place --preview-file <quote返回的路径> --yes');
  lines.push('  sftc-open-cli pay --order-id X --method WX');
  lines.push('  sftc-open-cli reasons --order-id X');
  lines.push('  sftc-open-cli cancel --order-id X');
  lines.push('');
  lines.push('环境变量（用于无浏览器 / CI / 容器）:');
  lines.push('  CLITE_TOKEN    仅注入 access token，跳过浏览器授权');
  lines.push('  CLITE_SESSION  注入完整会话 JSON（含 refresh_token，支持自动续期）');
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(usage() + '\n');
    process.exit(EXIT_OK);
  }

  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    await actVersion();
    return;
  }

  const { cmd, opts } = parseArgv(argv);
  const spec = COMMANDS[cmd];
  if (!spec) {
    fail('[PARAM_INVALID]', `未知命令：${cmd}\n\n${usage()}`, EXIT_PARAM);
  }
  await spec.fn(opts);
}

main().catch((e) => {
  fail('[MCP_ERROR]', `未预期的错误：${e && e.message ? e.message : String(e)}`, EXIT_ERROR);
});
