'use strict'

const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  dialog,
  shell,
  session,
  Notification,
  ipcMain,
  screen,
  clipboard,
  net,
  desktopCapturer,
} = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const os = require('node:os')
const child_process = require('node:child_process')

const APP_NAME = 'Stram'
const DEFAULT_SITE_URL = 'https://stram.lol'
const AUTH_FLOW_TTL_MS = 10 * 60 * 1000
const SESSION_COOKIE_NAME = 'stram_session'
const PROTOCOL_SCHEME = 'stram'
const PROTOCOL_CALLBACK = 'stram://auth/callback'
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png')
const PRELOAD_PATH = path.join(__dirname, 'preload.js')
const PAGES_DIR = path.join(__dirname, 'pages')
const SIGNIN_PAGE = path.join(PAGES_DIR, 'signin.html')
const TABS_PAGE = path.join(PAGES_DIR, 'tabs.html')
const TABS_PRELOAD = path.join(PAGES_DIR, 'tabs-preload.js')
// The in-app browser lives in a docked sidebar on the right. The site keeps
// the rest of the window, so the chat stays visible while a page is open.
const SIDEBAR_WIDTH_DEFAULT = 420
const SIDEBAR_WIDTH_MIN = 320
const SIDEBAR_WIDTH_MAX = 640
const SIDEBAR_CHROME_H = 80
// Default folder where the assistant works on files (shown in the Files panel).
const WORKSPACE_DIRNAME = 'Stram Workspace'

// Domains that are part of signing in / human verification. They stay inside
// the app so the OAuth round-trip can drop the session back into the window.
const AUTH_DOMAINS = [
  'google.com',
  'googleusercontent.com',
  'discord.com',
  'discordapp.com',
  'github.com',
  'githubusercontent.com',
  'appleid.apple.com',
  'microsoftonline.com',
  'live.com',
  'clerk.com',
  'clerk.accounts.dev',
  'supabase.co',
  'cloudflare.com',
  'hcaptcha.com',
  'recaptcha.net',
  'stripe.com',
]

let mainWindow = null
let settingsWindow = null
let authFlow = null
// In-app browser tabs (WebContentsView per site) and the docked sidebar chrome.
const siteTabs = new Map()
const siteTabContents = new WeakSet()
let activeSiteTabId = null
let sidebarChrome = null
let sidebarWidth = SIDEBAR_WIDTH_DEFAULT
let sidebarInsetKey = null
const popupContents = new WeakSet()
const authFallbackPrompted = new Set()
let configPath = ''
let config = {
  siteUrl: DEFAULT_SITE_URL,
  zoomFactor: 1,
  windowState: null,
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      config = { ...config, ...parsed }
    }
  } catch {
    // First run, or a config file that was deleted. Defaults are fine.
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
  } catch (error) {
    console.error('Could not save settings:', error)
  }
}

function normalizeSiteUrl(value) {
  if (typeof value !== 'string') return null
  let candidate = value.trim()
  if (!candidate) return null
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
    if (!url.hostname.includes('.') && !localHosts.has(url.hostname)) return null
    // A remote site must use HTTPS. Local development servers may use HTTP.
    if (url.protocol === 'http:' && !localHosts.has(url.hostname)) return null
    return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')) + url.search
  } catch {
    return null
  }
}

function siteOrigin() {
  try {
    return new URL(config.siteUrl).origin
  } catch {
    return new URL(DEFAULT_SITE_URL).origin
  }
}

function isInternalUrl(target) {
  try {
    return new URL(target).origin === siteOrigin()
  } catch {
    return false
  }
}

function isAuthDomain(target) {
  try {
    const host = new URL(target).hostname.toLowerCase()
    return AUTH_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

function openExternal(target) {
  if (!/^(https?:|mailto:)/i.test(target)) return
  shell.openExternal(target).catch(() => {})
}

function offerBrowserFallback(win, url, detail) {
  if (!win || win.isDestroyed() || !url) return
  const key = url.split('#')[0]
  if (authFallbackPrompted.has(key)) return
  authFallbackPrompted.add(key)

  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    title: 'Sign in in your browser?',
    message: 'Sign-in needs your browser.',
    detail: `${detail}\n\nSign in in your default browser. Stram will finish signing in here automatically when you are done.`,
    buttons: ['Sign in in browser', 'Try again', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })

  if (choice === 0) startBrowserSignIn()
  if (choice === 1) win.loadURL(url).catch(() => {})
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return
    new Notification({ title, body, icon: ICON_PATH }).show()
  } catch {
    // Notifications are optional.
  }
}

function showAuthError(message) {
  const options = {
    type: 'error',
    title: 'Sign-in problem',
    message: 'Could not finish signing in.',
    detail: message,
    buttons: ['OK'],
    defaultId: 0,
    noLink: true,
  }
  if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBoxSync(mainWindow, options)
  else dialog.showMessageBoxSync(options)
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function authResultPage(ok, message) {
  const title = ok ? 'Signed in to Stram' : 'Sign-in did not finish'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #08070c; color: #fff; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(420px, calc(100vw - 40px)); padding: 32px; border: 1px solid rgba(255,255,255,.09); border-radius: 24px; background: #111016; box-shadow: 0 24px 80px rgba(0,0,0,.55); }
  .mark { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: ${ok ? '#173d2b' : '#3d1717'}; color: ${ok ? '#6ee7a8' : '#fca5a5'}; font-size: 22px; font-weight: 700; }
  h1 { margin: 22px 0 8px; font-size: 22px; letter-spacing: -.03em; }
  p { margin: 0; color: rgba(255,255,255,.58); font-size: 14px; line-height: 1.6; }
  .hint { margin-top: 20px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,.07); font-size: 12px; color: rgba(255,255,255,.35); }
</style>
</head>
<body>
<main>
  <div class="mark">${ok ? '✓' : '!'}</div>
  <h1>${title}</h1>
  <p>${escapeHtml(message)}</p>
  <p class="hint">${ok ? 'You can close this tab and return to the Stram app.' : 'Return to the Stram app and try again.'}</p>
</main>
</body>
</html>`
}

function closeAuthFlow() {
  if (!authFlow) return
  const { server, timer } = authFlow
  authFlow = null
  if (timer) clearTimeout(timer)
  if (server) {
    try {
      server.close()
    } catch {
      // The server may already be closed.
    }
  }
}

function findProtocolUrl(args) {
  if (!Array.isArray(args)) return ''
  return args.find((arg) => typeof arg === 'string' && /^stram:\/\//i.test(arg)) || ''
}

function ensureProtocolRegistered() {
  try {
    if (process.defaultApp) {
      if (process.argv.length < 2) return false
      return app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ])
    }
    const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
    return app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, executable)
  } catch (error) {
    console.error('Could not register the Stram sign-in protocol:', error)
    return false
  }
}

function openBrowserSignInPage(state, challenge, redirect) {
  const target = new URL('/desktop-login', siteOrigin())
  target.searchParams.set('state', state)
  target.searchParams.set('challenge', challenge)
  target.searchParams.set('redirect', redirect)

  if (!app.isPackaged) console.log('Browser sign-in URL:', target.toString())

  shell.openExternal(target.toString()).catch((error) => {
    console.error('Could not open the sign-in page:', error)
    closeAuthFlow()
    showAuthError('Could not open your default browser. Check your browser settings and try again.')
  })

  notify(
    'Finish signing in in your browser',
    'Stram will finish signing in automatically when you are done.',
  )
}

function armAuthTimeout(flow) {
  const timer = setTimeout(() => {
    if (authFlow !== flow) return
    closeAuthFlow()
    showAuthError('The browser sign-in timed out. Start again from Stram.')
  }, AUTH_FLOW_TTL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return timer
}

function startBrowserSignIn() {
  closeAuthFlow()

  const state = base64Url(crypto.randomBytes(32))
  const verifier = base64Url(crypto.randomBytes(32))
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())
  const startedAt = Date.now()

  // stram:// gives the browser's "Open Stram?" confirmation and hands the
  // encrypted code straight back to this running app. If Windows will not
  // register the protocol, use the loopback callback instead.
  if (ensureProtocolRegistered()) {
    const flow = { state, verifier, startedAt, mode: 'protocol' }
    authFlow = flow
    flow.timer = armAuthTimeout(flow)
    openBrowserSignInPage(state, challenge, PROTOCOL_CALLBACK)
    return
  }

  let finished = false

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || requestUrl.pathname !== '/callback') {
      response.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      response.end('Not found')
      return
    }
    if (finished) {
      response.writeHead(409, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      response.end('This sign-in link was already used.')
      return
    }
    finished = true

    const code = requestUrl.searchParams.get('code') || ''
    const returnedState = requestUrl.searchParams.get('state') || ''
    const result = await completeBrowserSignIn(code, returnedState, verifier)
    response.writeHead(result.ok ? 200 : 400, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    })
    response.end(authResultPage(result.ok, result.message))
    if (authFlow && authFlow.server === server) closeAuthFlow()
  })

  const cleanup = () => {
    if (authFlow && authFlow.server === server) closeAuthFlow()
    else {
      try {
        server.close()
      } catch {
        // The server may already be closed.
      }
    }
  }

  server.on('error', (error) => {
    console.error('Local sign-in server failed:', error)
    cleanup()
    showAuthError('Could not start the local sign-in listener. Try again.')
  })

  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      cleanup()
      showAuthError('Could not start the local sign-in listener. Try again.')
      return
    }

    const redirect = `http://127.0.0.1:${address.port}/callback`
    const flow = { state, verifier, server, startedAt, mode: 'loopback' }
    authFlow = flow
    flow.timer = armAuthTimeout(flow)
    openBrowserSignInPage(state, challenge, redirect)
  })
}

async function completeBrowserSignIn(code, state, verifier) {
  if (!code || !state) {
    return { ok: false, message: 'The browser did not return a sign-in code. Start again from Stram.' }
  }

  const flow = authFlow
  if (!flow || !safeEqual(state, flow.state) || !safeEqual(verifier, flow.verifier)) {
    return { ok: false, message: 'This sign-in link is not valid for this app. Start again from Stram.' }
  }
  if (Date.now() - flow.startedAt > AUTH_FLOW_TTL_MS) {
    return { ok: false, message: 'This sign-in link expired. Start again from Stram.' }
  }

  let data
  try {
    const response = await net.fetch(`${siteOrigin()}/api/auth/desktop/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stram-Desktop': '1',
      },
      body: JSON.stringify({ code, verifier, state }),
    })
    data = await response.json().catch(() => ({}))
    if (!response.ok || !data || typeof data.token !== 'string') {
      throw new Error(
        data && typeof data.error === 'string'
          ? data.error
          : 'The sign-in link could not be verified.',
      )
    }
  } catch (error) {
    return {
      ok: false,
      message:
        error && error.message
          ? error.message
          : 'Could not reach Stram. Check your connection and try again.',
    }
  }

  try {
    const maxAge = Number(data.maxAge)
    await session.defaultSession.cookies.set({
      url: siteOrigin(),
      name: SESSION_COOKIE_NAME,
      value: data.token,
      secure: siteOrigin().startsWith('https://'),
      httpOnly: true,
      sameSite: 'lax',
      expirationDate:
        Math.floor(Date.now() / 1000) +
        (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 60 * 60 * 24 * 30),
    })
  } catch (error) {
    console.error('Could not save the sign-in session:', error)
    return { ok: false, message: 'Could not save the sign-in session. Try again.' }
  }

  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      await mainWindow.loadURL(config.siteUrl)
    } catch {
      // The window may have been closed while the exchange was running.
    }
    if (!mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  }
  notify('Signed in to Stram', 'Your browser sign-in was completed.')
  return { ok: true, message: 'Your browser sign-in was completed.' }
}

function parseProtocolCallback(raw) {
  try {
    const url = new URL(raw)
    if (url.protocol !== `${PROTOCOL_SCHEME}:`) return null
    if (url.hostname !== 'auth' || url.pathname !== '/callback') return null
    if (url.username || url.password) return null
    const code = url.searchParams.get('code') || ''
    const state = url.searchParams.get('state') || ''
    if (!code || !state) return null
    return { code, state }
  } catch {
    return null
  }
}

async function handleProtocolUrl(raw) {
  const callback = parseProtocolCallback(raw)
  if (!callback) return false

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  if (!authFlow) {
    showAuthError('Start sign-in from the Stram app so it can finish securely.')
    return true
  }

  const result = await completeBrowserSignIn(callback.code, callback.state, authFlow.verifier)
  closeAuthFlow()
  if (!result.ok) showAuthError(result.message)
  return true
}

function parseCliUrl() {
  const flag = process.argv.find((arg) => arg.startsWith('--url='))
  if (flag) return normalizeSiteUrl(flag.slice('--url='.length))
  const index = process.argv.indexOf('--url')
  if (index !== -1) return normalizeSiteUrl(process.argv[index + 1])
  return normalizeSiteUrl(process.env.STRAM_SITE_URL || '')
}

function restoreWindowState() {
  const state = config.windowState
  const fallback = { width: 1280, height: 860 }

  if (!state || typeof state !== 'object') return fallback

  const bounds = {
    width: Math.max(940, Math.round(state.width) || fallback.width),
    height: Math.max(620, Math.round(state.height) || fallback.height),
  }

  if (Number.isFinite(state.x) && Number.isFinite(state.y)) {
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea
      return (
        state.x + 80 < area.x + area.width &&
        state.x + bounds.width - 80 > area.x &&
        state.y + 40 < area.y + area.height &&
        state.y + bounds.height - 40 > area.y
      )
    })
    if (visible) {
      bounds.x = Math.round(state.x)
      bounds.y = Math.round(state.y)
    }
  }

  return bounds
}

function rememberWindowState(win) {
  if (!win || win.isDestroyed()) return
  if (win.isMaximized() || win.isFullScreen()) return
  const bounds = win.getNormalBounds()
  config.windowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  }
  saveConfig()
}

function showOfflinePage(win, details) {
  if (!win || win.isDestroyed()) return
  const query = new URLSearchParams({
    code: String(details.code || ''),
    description: details.description || 'The page could not be loaded.',
    url: details.url || config.siteUrl,
  })
  win.loadFile(path.join(PAGES_DIR, 'offline.html'), { search: `?${query.toString()}` })
}

async function hasSessionCookie() {
  try {
    const cookies = await session.defaultSession.cookies.get({
      name: SESSION_COOKIE_NAME,
      url: siteOrigin(),
    })
    return cookies.some((cookie) => typeof cookie.value === 'string' && cookie.value.length > 0)
  } catch {
    return false
  }
}

async function loadStartPage(win) {
  if (!win || win.isDestroyed()) return

  if (await hasSessionCookie()) {
    if (!win || win.isDestroyed()) return
    try {
      await win.loadURL(config.siteUrl)
    } catch (error) {
      const message = error && error.message ? error.message : ''
      if (!message.includes('ERR_ABORTED')) {
        showOfflinePage(win, { code: '', description: 'Could not reach the site.', url: config.siteUrl })
      }
    }
    return
  }

  if (!win.isDestroyed()) win.loadFile(SIGNIN_PAGE)
}

// ============================================================
// IN-APP BROWSER TABS
// Sites the assistant (or the user) open live inside the Stram
// window as real browser tabs under the shared app session.
// ============================================================
// The chat page reserves room for the docked browser. The rule is injected
// into the Stram site only; file:// pages (sign-in, offline) stay full width.
const SIDEBAR_INSET_CSS = `
html[data-stram-browser="open"] body { padding-right: var(--stram-browser-width, 420px) !important; }
html[data-stram-browser="open"] body { transition: padding-right 160ms ease; }
html[data-stram-browser="open"] .fixed.inset-0 { right: var(--stram-browser-width, 420px) !important; }
@media (prefers-reduced-motion: reduce) { html[data-stram-browser="open"] body { transition: none; } }
`

function sidebarWidthFor(windowWidth) {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(sidebarWidth, SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, windowWidth - 360)))
}

/** Tell the hosted site how much room the docked browser takes. */
function applySiteSidebarInset(open, width) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  if (!isInternalUrl(mainWindow.webContents.getURL())) return
  const key = open ? Math.round(width) : 0
  if (key === sidebarInsetKey) return
  sidebarInsetKey = key
  const cssWidth = `${Math.max(0, Math.round(width))}px`
  const script = `(() => {
    const root = document.documentElement;
    if (!root) return;
    root.style.setProperty('--stram-browser-width', ${JSON.stringify(cssWidth)});
    if (${open ? 'true' : 'false'}) root.setAttribute('data-stram-browser', 'open');
    else root.removeAttribute('data-stram-browser');
  })()`
  try {
    void mainWindow.webContents.executeJavaScript(script, true).catch(() => { sidebarInsetKey = null })
  } catch {
    sidebarInsetKey = null
  }
}

function installSiteSidebarCss() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  if (!isInternalUrl(mainWindow.webContents.getURL())) return
  try {
    void mainWindow.webContents.insertCSS(SIDEBAR_INSET_CSS).catch(() => {})
  } catch {}
  sidebarInsetKey = null
}

function layoutChrome() {
  if (!mainWindow || mainWindow.isDestroyed() || !sidebarChrome || sidebarChrome.webContents.isDestroyed()) return
  const { width, height } = mainWindow.getContentBounds()
  const active = activeSiteTabId ? siteTabs.get(activeSiteTabId) : null
  if (!active) {
    try { sidebarChrome.setVisible(false) } catch {}
    for (const tab of siteTabs.values()) {
      try { tab.view.setVisible(false) } catch {}
    }
    applySiteSidebarInset(false, 0)
    return
  }
  const w = sidebarWidthFor(width)
  try { sidebarChrome.setBounds({ x: Math.max(0, width - w), y: 0, width: w, height: SIDEBAR_CHROME_H }) } catch {}
  try { sidebarChrome.setVisible(true) } catch {}
  for (const [id, tab] of siteTabs) {
    try {
      tab.view.setBounds({ x: Math.max(0, width - w), y: SIDEBAR_CHROME_H, width: w, height: Math.max(0, height - SIDEBAR_CHROME_H) })
      tab.view.setVisible(id === activeSiteTabId)
    } catch {}
  }
  applySiteSidebarInset(true, w)
  syncSidebarZ()
}

/** Keep the sidebar and its active page rendered above the chat. */
function syncSidebarZ() {
  if (!mainWindow || mainWindow.isDestroyed() || !sidebarChrome || sidebarChrome.webContents.isDestroyed()) return
  const active = activeSiteTabId ? siteTabs.get(activeSiteTabId) : null
  if (active) {
    try {
      mainWindow.contentView.removeChildView(active.view)
      mainWindow.contentView.addChildView(active.view)
    } catch {}
  }
  try {
    mainWindow.contentView.removeChildView(sidebarChrome)
    mainWindow.contentView.addChildView(sidebarChrome)
  } catch {}
}

function tabStatePayload() {
  return {
    active: activeSiteTabId,
    tabs: [...siteTabs.values()].map((tab) => ({
      id: tab.id,
      title: tab.title || (tab.blank ? 'New tab' : tab.url),
      url: tab.url,
      blank: Boolean(tab.blank),
      favicon: tab.favicon || '',
      audible: Boolean(tab.view.webContents.isCurrentlyAudible()),
    })),
  }
}

function broadcastTabState() {
  const payload = tabStatePayload()
  try { if (sidebarChrome && !sidebarChrome.webContents.isDestroyed()) sidebarChrome.webContents.send('stram:tabs-state', payload) } catch {}
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stram:tabs-state', payload) } catch {}
}

function createTabView({ url = '', title = 'New tab', blank = false } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Inactive pages must not keep the whole app busy; audio still plays.
      backgroundThrottling: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  const id = `tab_${crypto.randomBytes(6).toString('hex')}`
  const tab = { id, view, title, url, favicon: '', blank }
  siteTabs.set(id, tab)
  siteTabContents.add(view.webContents)
  const contents = view.webContents
  contents.on('page-title-updated', (_event, nextTitle) => {
    const title = String(nextTitle || '').trim()
    if (tab.blank && (!title || title === 'about:blank')) return
    tab.title = title || tab.title
    broadcastTabState()
  })
  contents.on('page-favicon-updated', (_event, favicons) => {
    tab.favicon = Array.isArray(favicons) && favicons[0] ? String(favicons[0]) : tab.favicon
    broadcastTabState()
  })
  contents.on('did-navigate', (_event, nextUrl) => {
    const navigated = String(nextUrl || tab.url)
    if (navigated && navigated !== 'about:blank') {
      tab.url = navigated
      tab.blank = false
    }
    broadcastTabState()
  })
  contents.on('did-navigate-in-page', (_event, nextUrl) => {
    const navigated = String(nextUrl || tab.url)
    if (navigated && navigated !== 'about:blank') {
      tab.url = navigated
      tab.blank = false
    }
    broadcastTabState()
  })
  contents.on('destroyed', () => {
    siteTabs.delete(id)
    if (activeSiteTabId === id) activeSiteTabId = null
    broadcastTabState()
  })
  mainWindow.contentView.addChildView(view, 0)
  tab.view.setVisible(false)
  return tab
}

/** Open a https site in the docked sidebar, reusing an existing tab. */
function openSiteTab(rawUrl, { activate = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'The Stram window is not ready.' }
  let parsed
  try {
    const candidate = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${String(rawUrl).trim()}`
    parsed = new URL(candidate)
  } catch {
    return { ok: false, error: 'That is not a valid address.' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'Only https sites open in Stram tabs.' }
  const target = parsed.href.replace(/#.*$/, '')
  for (const tab of siteTabs.values()) {
    if (!tab.blank && tab.url.replace(/#.*$/, '') === target) {
      if (activate) activateSiteTab(tab.id)
      return { ok: true, tabId: tab.id, url: tab.url, reused: true }
    }
  }
  // A blank "new tab" becomes the page instead of leaving an empty tab behind.
  const blankTab = [...siteTabs.values()].find((tab) => tab.blank)
  if (blankTab) {
    blankTab.blank = false
    blankTab.url = parsed.href
    blankTab.title = parsed.hostname
    if (activate) activateSiteTab(blankTab.id)
    void blankTab.view.webContents.loadURL(parsed.href).catch(() => {})
    broadcastTabState()
    return { ok: true, tabId: blankTab.id, url: blankTab.url }
  }
  const tab = createTabView({ url: parsed.href, title: parsed.hostname })
  if (activate) activateSiteTab(tab.id)
  else layoutChrome()
  void tab.view.webContents.loadURL(parsed.href).catch(() => {})
  return { ok: true, tabId: tab.id, url: tab.url }
}

/** A new-tab page keeps the sidebar open with the address bar focused. */
function openBlankTab() {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'The Stram window is not ready.' }
  const existing = [...siteTabs.values()].find((tab) => tab.blank)
  if (existing) {
    activateSiteTab(existing.id)
    return { ok: true, tabId: existing.id, url: '', blank: true }
  }
  const tab = createTabView({ blank: true })
  activateSiteTab(tab.id)
  void tab.view.webContents.loadURL('about:blank').catch(() => {})
  return { ok: true, tabId: tab.id, url: '', blank: true }
}

/** Show the docked browser: last open page, or a fresh new-tab page. */
function showSidebar() {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'The Stram window is not ready.' }
  if (activeSiteTabId && siteTabs.has(activeSiteTabId)) {
    // The window may have been minimized or resized while the page stayed open;
    // recompute the docked width before showing it again.
    layoutChrome()
    return { ok: true, tabId: activeSiteTabId }
  }
  const remaining = [...siteTabs.keys()]
  if (remaining.length > 0) {
    const id = remaining[remaining.length - 1]
    activateSiteTab(id)
    return { ok: true, tabId: id }
  }
  return openBlankTab()
}

function activateSiteTab(id) {
  const tab = siteTabs.get(id)
  if (!tab || !mainWindow || mainWindow.isDestroyed()) return
  activeSiteTabId = id
  for (const entry of siteTabs.values()) entry.view.setVisible(entry.id === id)
  tab.view.setVisible(true)
  layoutChrome()
  syncSidebarZ()
  try { tab.view.webContents.focus() } catch {}
  broadcastTabState()
}

/** Back to the chat view (the sidebar hides, tabs stay open). */
function activateChat() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  activeSiteTabId = null
  for (const tab of siteTabs.values()) tab.view.setVisible(false)
  layoutChrome()
  try { mainWindow.webContents.focus() } catch {}
  broadcastTabState()
}

function closeSiteTab(id) {
  const tab = siteTabs.get(id)
  if (!tab || !mainWindow || mainWindow.isDestroyed()) return
  const wasActive = id === activeSiteTabId
  siteTabs.delete(id)
  try { mainWindow.contentView.removeChildView(tab.view) } catch {}
  try { tab.view.webContents.close() } catch {}
  if (wasActive) {
    const remaining = [...siteTabs.keys()]
    if (remaining.length > 0) activateSiteTab(remaining[remaining.length - 1])
    else activateChat()
  } else broadcastTabState()
}

const browserWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Read/click/type inside the page that is currently open in the sidebar. */
async function runBrowserCommand(rawAction, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'The Stram window is not ready.' }
  const tab = activeSiteTabId ? siteTabs.get(activeSiteTabId) : null
  if (!tab || tab.view.webContents.isDestroyed()) {
    return { ok: false, error: 'No browser page is open. Use computer_open with a full https:// URL first.' }
  }
  const contents = tab.view.webContents
  const action = String(rawAction || 'read').toLowerCase()
  const selector = String(payload.selector || '').slice(0, 300)
  const label = String(payload.text || payload.label || '').slice(0, 500)
  const value = String(payload.value || payload.text || '').slice(0, 4000)

  if (action === 'read') {
    const page = await contents.executeJavaScript(`(() => ({
      title: document.title || '',
      url: location.href,
      text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 12000)
    }))()`)
    return { ok: true, output: `Page: ${page.title || '(untitled)'}\nURL: ${page.url}\n\n${page.text || '(no readable text)'}` }
  }

  if (action === 'click') {
    const result = await contents.executeJavaScript(`(() => {
      const selector = ${JSON.stringify(selector)};
      const wanted = ${JSON.stringify(label)}.trim().toLowerCase();
      let el = null;
      if (selector) { try { el = document.querySelector(selector); } catch {} }
      if (!el && wanted) {
        const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,summary,label,[role="button"],[role="link"],[role="tab"],[onclick]'));
        const describe = (node) => String(node.innerText || node.textContent || node.value || node.getAttribute('aria-label') || node.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        el = nodes.find((node) => describe(node) === wanted) || nodes.find((node) => describe(node).includes(wanted));
      }
      if (!el) return { ok: false, error: 'No clickable element matched ' + (selector || wanted || 'that request') + '.' };
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      try { el.focus({ preventScroll: true }); } catch {}
      el.click();
      return { ok: true, label: String(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || selector || 'element').replace(/\\s+/g, ' ').trim().slice(0, 120) };
    })()`)
    if (!result || !result.ok) return { ok: false, error: result?.error || 'Nothing matched that click.' }
    await browserWait(1200)
    let after = ''
    try {
      after = await contents.executeJavaScript(`(() => location.href + ' | ' + (document.title || ''))()`)
    } catch {}
    return { ok: true, output: `Clicked ${result.label}${after ? `\nNow: ${after}` : ''}` }
  }

  if (action === 'type') {
    if (!value) return { ok: false, error: 'A value is required to type.' }
    const result = await contents.executeJavaScript(`(() => {
      const selector = ${JSON.stringify(selector)};
      const value = ${JSON.stringify(value)};
      const submit = ${payload.submit === true ? 'true' : 'false'};
      let el = null;
      if (selector) { try { el = document.querySelector(selector); } catch {} }
      if (!el) el = document.activeElement;
      if (!el || el === document.body) return { ok: false, error: 'No field is focused. Pass a CSS selector for the input.' };
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value); else el.value = value;
      } else if (el.isContentEditable) {
        el.textContent = value;
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      try { el.focus({ preventScroll: true }); } catch {}
      if (submit) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
      }
      return { ok: true, label: el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || selector || tag.toLowerCase() };
    })()`)
    if (!result || !result.ok) return { ok: false, error: result?.error || 'That field could not be filled.' }
    await browserWait(payload.submit === true ? 1200 : 250)
    return { ok: true, output: `Typed into ${result.label}${payload.submit === true ? ' and submitted' : ''}.` }
  }

  if (action === 'scroll') {
    const amount = Number(payload.amount || 700) || 700
    const result = await contents.executeJavaScript(`(() => {
      const selector = ${JSON.stringify(selector)};
      if (selector) {
        try {
          const el = document.querySelector(selector);
          if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return { ok: true, output: 'Scrolled to ' + selector }; }
        } catch {}
      }
      window.scrollBy({ top: ${amount}, behavior: 'smooth' });
      return { ok: true, output: 'Scrolled to ' + Math.round(window.scrollY) + ' of ' + Math.round(document.documentElement.scrollHeight) };
    })()`)
    await browserWait(500)
    return { ok: true, output: result?.output || 'Scrolled the page.' }
  }

  if (action === 'back' || action === 'forward' || action === 'reload') {
    const history = contents.navigationHistory
    if (action === 'back') {
      if (!history.canGoBack()) return { ok: false, error: 'There is no previous page in this tab.' }
      history.goBack()
    } else if (action === 'forward') {
      if (!history.canGoForward()) return { ok: false, error: 'There is no next page in this tab.' }
      history.goForward()
    } else {
      contents.reload()
    }
    await browserWait(900)
    return { ok: true, output: `${action === 'reload' ? 'Reloaded' : `Went ${action}`} ${tab.url || ''}`.trim() }
  }

  if (action === 'navigate') {
    const target = String(payload.url || '').trim()
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'A full https:// address is required.' }
    let parsed
    try { parsed = new URL(target) } catch { return { ok: false, error: 'That is not a valid address.' } }
    if (parsed.protocol !== 'https:') return { ok: false, error: 'Only https sites open in Stram tabs.' }
    tab.blank = false
    tab.url = parsed.href
    tab.title = parsed.hostname
    broadcastTabState()
    void contents.loadURL(parsed.href).catch(() => {})
    return { ok: true, output: `Opened ${parsed.href}` }
  }

  return { ok: false, error: `Unknown browser action "${action}".` }
}

function workspaceFolderPath() {
  try {
    const folder = path.join(os.homedir(), WORKSPACE_DIRNAME)
    // The Workspace panel expects this folder to exist; create it on first use
    // instead of showing a raw ENOENT to the user.
    fs.mkdirSync(folder, { recursive: true })
    return folder
  } catch { return WORKSPACE_DIRNAME }
}

// ============================================================
// LOCAL MCP SERVERS (Model Context Protocol over stdio)
// The user links servers from the Workspace panel; Stram speaks
// JSON-RPC over the server's stdio and offers its tools to the
// assistant as mcp_* tools.
// ============================================================
const MCP_PROTOCOL_VERSION = '2024-11-05'
const mcpServers = new Map()
let mcpPlannerIndex = new Map()

function sanitizeMcpServerName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
}

function mcpConfigFile() {
  try { return path.join(app.getPath('userData'), 'mcp-servers.json') } catch { return '' }
}

/** The old public Memory preset is gone; recall now lives inside the app. */
function isLegacyMemoryMcp(entry) {
  const name = sanitizeMcpServerName(entry && entry.name)
  const command = String(entry?.command || '').toLowerCase()
  const args = Array.isArray(entry?.args) ? entry.args.map((arg) => String(arg)).join(' ').toLowerCase() : ''
  return name === 'memory' && (command.includes('server-memory') || args.includes('@modelcontextprotocol/server-memory'))
}

function readMcpConfig() {
  try {
    const list = JSON.parse(fs.readFileSync(mcpConfigFile(), 'utf8'))
    return Array.isArray(list)
      ? list.filter((entry) => entry && typeof entry.name === 'string' && typeof entry.command === 'string' && !isLegacyMemoryMcp(entry))
      : []
  } catch { return [] }
}

function writeMcpConfig(list) {
  const file = mcpConfigFile()
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8')
  } catch {}
}

function mcpStateList() {
  return [...mcpServers.values()].map((server) => ({
    id: server.id,
    name: server.name,
    status: server.status,
    error: server.error || null,
    tools: (server.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      plannerName: server.toolPlanner ? server.toolPlanner.get(tool.name) || null : null,
    })),
  }))
}

function mcpSend(server, message) {
  try { server.child && server.child.stdin.write(`${JSON.stringify(message)}\n`) } catch {}
}

function mcpRequest(server, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = ++server.seq
    const timer = setTimeout(() => {
      server.pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, timeoutMs)
    server.pending.set(id, { resolve, reject, timer })
    mcpSend(server, { jsonrpc: '2.0', id, method, params })
  })
}

function stopMcpServer(server, silent = false) {
  server.status = 'stopped'
  try {
    if (server.child && server.child.pid) {
      // The shell wrapper spawns a process tree; kill all of it.
      if (process.platform === 'win32') {
        child_process.exec(`taskkill /pid ${server.child.pid} /T /F`, () => {})
      } else {
        server.child.kill()
      }
    }
  } catch {}
  if (silent) mcpServers.delete(server.id)
}

/** Map every running server's tools to planner-safe mcp_* names. */
function refreshMcpPlannerIndex() {
  const index = new Map()
  for (const server of mcpServers.values()) {
    server.toolPlanner = new Map()
    if (server.status !== 'running') continue
    for (const tool of server.tools || []) {
      const toolSlug = String(tool.name || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+/, '').replace(/_+$/, '').slice(0, 60)
      const plannerName = `mcp_${server.name}_${toolSlug}`
      if (!/^mcp_[a-z0-9_]{2,100}$/.test(plannerName) || index.has(plannerName)) continue
      index.set(plannerName, { serverId: server.id, toolName: tool.name })
      server.toolPlanner.set(tool.name, plannerName)
    }
  }
  mcpPlannerIndex = index
}

function normalizeMcpContent(result) {
  const content = result?.content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part?.type === 'text') return String(part.text || '')
      if (part?.type === 'resource' && part?.resource) return String(part.resource.text || part.resource.uri || '')
      return ''
    }).filter(Boolean).join('\n')
  }
  if (typeof result?.content === 'string') return result.content
  if (typeof result === 'string') return result
  return result ? JSON.stringify(result).slice(0, 8000) : ''
}

async function callMcpTool(plannerName, args) {
  const resolved = mcpPlannerIndex.get(plannerName)
  if (!resolved) return { ok: false, error: `No linked MCP server provides "${plannerName}".` }
  const server = mcpServers.get(resolved.serverId)
  if (!server || server.status !== 'running' || !server.child) {
    return { ok: false, error: `The "${resolved.serverId}" MCP server is not running. Restart it from the Workspace panel.` }
  }
  try {
    const result = await mcpRequest(server, 'tools/call', { name: resolved.toolName, arguments: args }, 60000)
    if (result?.isError) {
      const text = normalizeMcpContent(result)
      return { ok: false, error: (text || 'The MCP tool reported an error.').slice(0, 600) }
    }
    return { ok: true, output: normalizeMcpContent(result) || '(the tool returned no content)' }
  } catch (error) {
    return { ok: false, error: error?.message || 'The MCP tool could not run.' }
  }
}

/** Locate Roblox Studio's bundled MCP bridge, which ships inside Studio's version folder. */
function findRobloxStudioMcp() {
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'Versions'),
    path.join(process.env.LOCALAPPDATA || '', 'Roblox Studio', 'Versions'),
  ]
  const candidates = []
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const executable = path.join(root, entry.name, 'StudioMCP.exe')
        try {
          if (fs.existsSync(executable)) candidates.push({ executable, modified: fs.statSync(executable).mtimeMs })
        } catch {}
      }
    } catch {}
  }
  candidates.sort((a, b) => b.modified - a.modified)
  return candidates[0]?.executable || ''
}

function commandOnPath(command) {
  const raw = String(command || '').trim()
  if (!raw) return false
  if (/[\\/]/.test(raw)) return fs.existsSync(raw)
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
  const folders = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const folder of folders) {
    if (fs.existsSync(path.join(folder, raw))) return true
    for (const ext of exts) {
      if (fs.existsSync(path.join(folder, `${raw}${ext.toLowerCase()}`))) return true
    }
  }
  return false
}

/** Swap friendly preset names for the real local executable, with clear install hints. */
function resolveMcpLaunch(command, args) {
  const friendly = path.basename(String(command || '')).toLowerCase().replace(/\.exe$/, '')
  if (['studiomcp', 'roblox', 'roblox-studio', 'roblox_studio'].includes(friendly)) {
    const executable = findRobloxStudioMcp()
    if (!executable) {
      return {
        ok: false,
        error: "Roblox Studio's MCP server was not found. Open Roblox Studio once so it installs StudioMCP, then link the preset again.",
      }
    }
    return { ok: true, command: executable, args }
  }
  if (friendly === 'uvx' && !commandOnPath(command)) {
    return {
      ok: false,
      error: 'Blender MCP needs uv (the uvx command). Install it from https://docs.astral.sh/uv/ then restart Stram, or open Blender and use the built-in chat instead.',
    }
  }
  return { ok: true, command, args }
}

/** Spawn an MCP server, complete the handshake, and cache its tool list. */
async function startMcpServer(record) {
  const name = sanitizeMcpServerName(record && record.name)
  if (!name) return { ok: false, error: 'A server name is required.' }
  const command = String(record.command || '').trim().slice(0, 500)
  if (!command || /[\r\n]/.test(command)) return { ok: false, error: 'A valid start command is required.' }
  const args = Array.isArray(record.args) ? record.args.slice(0, 24).map((arg) => String(arg).slice(0, 400)) : []
  const previous = mcpServers.get(name)
  if (previous) stopMcpServer(previous, true)

  const server = {
    id: name,
    name,
    command,
    args,
    child: null,
    status: 'starting',
    error: null,
    tools: [],
    toolPlanner: new Map(),
    seq: 0,
    pending: new Map(),
  }
  mcpServers.set(name, server)
  const launch = resolveMcpLaunch(command, args)
  if (!launch.ok) {
    server.status = 'error'
    server.error = launch.error
    return { ok: false, error: launch.error }
  }
  let child
  try {
    // Windows note: commands like `npx` are .cmd files that CreateProcess
    // cannot start directly. Run the user's command line through the shell
    // with explicit quoting (same trust level as the user typing it).
    const quote = (value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value)
    const commandLine = [launch.command, ...launch.args].map(quote).join(" ")
    child = child_process.spawn(commandLine, {
      windowsHide: true,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
  } catch (error) {
    server.status = 'error'
    server.error = error?.message || 'Could not start the server.'
    return { ok: false, error: server.error }
  }
  server.child = child
  let stderrTail = ''
  child.stderr.on('data', (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-2000)
  })
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer = `${buffer}${chunk}`
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const pending = server.pending.get(message.id)
      if (pending) {
        server.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(String(message.error.message || message.error.code || 'MCP error')))
        else pending.resolve(message.result)
      }
    }
  })
  child.on('error', (error) => {
    if (server.status === 'starting') {
      server.status = 'error'
      server.error = error?.message || 'Could not start the server.'
    }
  })
  child.on('close', (code) => {
    for (const pending of server.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('The MCP server stopped.'))
    }
    server.pending.clear()
    if (server.status !== 'stopped') {
      server.status = 'stopped'
      server.error = code ? `Server exited (code ${code}). ${stderrTail.slice(-300)}` : null
    }
    refreshMcpPlannerIndex()
    broadcastTabState()
  })

  try {
    // 60s: a first `npx` run may download the package before answering.
    await mcpRequest(server, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Stram Desktop', version: app.getVersion() },
    }, 60000)
    mcpSend(server, { jsonrpc: '2.0', method: 'notifications/initialized' })
    const listing = await mcpRequest(server, 'tools/list', {}, 20000)
    server.tools = (Array.isArray(listing?.tools) ? listing.tools : []).slice(0, 32).map((tool) => ({
      name: String(tool?.name || '').slice(0, 60),
      description: String(tool?.description || '').slice(0, 400),
      inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
    })).filter((tool) => tool.name)
    server.status = 'running'
    server.error = null
    refreshMcpPlannerIndex()
    return { ok: true, server: mcpStateList().find((entry) => entry.id === name) }
  } catch (error) {
    server.status = 'error'
    server.error = `${String(error?.message || 'The server did not answer.')}${stderrTail ? ` ${stderrTail.slice(-200)}` : ''}`
    try { child.kill() } catch {}
    return { ok: false, error: server.error }
  }
}

function createWindow() {
  const bounds = restoreWindowState()

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: APP_NAME,
    backgroundColor: '#292929',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false,
      webviewTag: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      v8CacheOptions: 'code',
    },
  })

  mainWindow = win

  win.once('ready-to-show', () => {
    win.show()
    if (config.windowState && config.windowState.maximized) win.maximize()
  })

  // If the site is slow, don't leave the user staring at nothing.
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }, 6000)

  let stateTimer = null
  const queueStateSave = () => {
    clearTimeout(stateTimer)
    stateTimer = setTimeout(() => rememberWindowState(win), 400)
  }
  win.on('resize', () => { queueStateSave(); layoutChrome() })
  win.on('maximize', () => { layoutChrome() })
  win.on('restore', () => { queueStateSave(); layoutChrome() })
  win.on('move', queueStateSave)
  win.on('maximize', () => {
    config.windowState = { ...(config.windowState || {}), maximized: true }
    saveConfig()
  })
  win.on('unmaximize', () => {
    config.windowState = { ...(config.windowState || {}), maximized: false }
    saveConfig()
    queueStateSave()
  })
  win.on('close', () => rememberWindowState(win))

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.setZoomFactor(config.zoomFactor || 1)

  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(config.zoomFactor || 1)

    const currentUrl = win.webContents.getURL()
    if (!isAuthDomain(currentUrl)) return

    win.webContents
      .executeJavaScript('document.body ? document.body.innerText.slice(0, 4000) : ""', true)
      .then((text) => {
        if (typeof text !== 'string') return
        if (/browser or app may not be secure|couldn.t sign you in|disallowed_useragent/i.test(text)) {
          offerBrowserFallback(win, currentUrl, 'The sign-in provider blocked the embedded browser.')
        }
      })
      .catch(() => {})
  })

  win.webContents.on('zoom-changed', (_event, _direction) => {
    config.zoomFactor = win.webContents.getZoomFactor()
    saveConfig()
  })

  win.webContents.on('did-finish-load', () => {
    installSiteSidebarCss()
    // A reload forgets the injected inset class; re-apply it if a page is open.
    sidebarInsetKey = null
    layoutChrome()
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    // -3 is ERR_ABORTED, which happens on ordinary redirects.
    if (!isMainFrame || errorCode === -3) return
    if (validatedUrl.startsWith('file://')) return

    const target = validatedUrl || win.webContents.getURL()
    if (isAuthDomain(target)) {
      offerBrowserFallback(win, target, `The sign-in page could not load (${errorDescription}).`)
      return
    }

    showOfflinePage(win, { code: errorCode, description: errorDescription, url: validatedUrl })
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'error',
      title: 'Stram stopped responding',
      message: 'The page crashed.',
      detail: `Reason: ${details.reason}. Reload the app to keep going.`,
      buttons: ['Reload', 'Close'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 0) win.reload()
    else win.close()
  })

  win.on('unresponsive', () => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Stram is busy',
      message: 'The page is not responding.',
      detail: 'You can wait, or reload the window.',
      buttons: ['Keep waiting', 'Reload'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 1) win.reload()
  })

  void loadStartPage(win)

  // The in-app browser sidebar: a tiny local page with tabs and an address
  // bar, docked on the right above the currently open page.
  try {
    sidebarChrome = new WebContentsView({
      webPreferences: {
        preload: TABS_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    win.contentView.addChildView(sidebarChrome)
    sidebarChrome.setVisible(false)
    sidebarChrome.webContents.on('did-finish-load', () => {
      sidebarInsetKey = null
      broadcastTabState()
      layoutChrome()
    })
    void sidebarChrome.webContents.loadFile(TABS_PAGE).catch(() => {})
    layoutChrome()
  } catch {}

  return win
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 580,
    height: 520,
    parent: mainWindow || undefined,
    modal: Boolean(mainWindow),
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: 'Stram settings',
    backgroundColor: '#1d1d22',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      navigateOnDragDrop: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  settingsWindow.setMenu(null)
  settingsWindow.once('ready-to-show', () => settingsWindow.show())
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
  settingsWindow.loadFile(path.join(PAGES_DIR, 'settings.html'))
}

function showAbout() {
  const info = [
    `Stram ${app.getVersion()}`,
    '',
    `Site: ${config.siteUrl}`,
    `Electron: ${process.versions.electron}`,
    `Chromium: ${process.versions.chrome}`,
    `Node: ${process.versions.node}`,
    '',
    'A desktop window for your Stram workspace.',
  ].join('\n')

  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: 'About Stram',
    message: 'Stram Desktop',
    detail: info,
    buttons: ['OK'],
    icon: ICON_PATH,
  })
}

function setZoom(factor) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const clamped = Math.min(3, Math.max(0.5, Math.round(factor * 100) / 100))
  mainWindow.webContents.setZoomFactor(clamped)
  config.zoomFactor = clamped
  saveConfig()
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: openSettings,
        },
        {
          label: 'Open Site in Browser',
          click: () => openExternal(config.siteUrl),
        },
        {
          label: 'Open Current Page in Browser',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            if (!mainWindow || mainWindow.isDestroyed()) return
            openExternal(mainWindow.webContents.getURL())
          },
        },
        {
          label: 'Sign In in Browser…',
          click: () => startBrowserSignIn(),
        },
        { type: 'separator' },
        {
          label: 'Open Downloads Folder',
          click: () => shell.openPath(app.getPath('downloads')),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => {
            if (!mainWindow || mainWindow.isDestroyed()) return
            const history = mainWindow.webContents.navigationHistory
            if (history.canGoBack()) history.goBack()
          },
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: () => {
            if (!mainWindow || mainWindow.isDestroyed()) return
            const history = mainWindow.webContents.navigationHistory
            if (history.canGoForward()) history.goForward()
          },
        },
        { type: 'separator' },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow && mainWindow.reload(),
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => mainWindow && mainWindow.webContents.reloadIgnoringCache(),
        },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => setZoom((config.zoomFactor || 1) + 0.1),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => setZoom((config.zoomFactor || 1) - 0.1),
        },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => setZoom(1),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => mainWindow && mainWindow.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Stram Website',
          click: () => openExternal(DEFAULT_SITE_URL),
        },
        {
          label: 'Report a Problem',
          click: () => openExternal('https://github.com/negrosuck45-bit/unc-gpt-new-/issues'),
        },
        { type: 'separator' },
        { label: 'About Stram', click: showAbout },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function setupSession(ses) {
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details && details.requestingUrl ? details.requestingUrl : webContents.getURL()
    const trusted = isInternalUrl(requestingUrl) || isAuthDomain(requestingUrl)
    if (!trusted) return callback(false)

    switch (permission) {
      case 'media': {
        const types = (details && details.mediaTypes) || []
        // Microphone for voice chat. The site's own policy disables the camera.
        return callback(types.length === 0 || types.every((type) => type === 'audio'))
      }
      case 'notifications':
      case 'clipboard-sanitized-write':
      case 'fullscreen':
      case 'pointerLock':
      case 'mediaKeySystem':
      case 'openExternal':
        return callback(true)
      default:
        return callback(false)
    }
  })

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (!isInternalUrl(requestingOrigin) && !isAuthDomain(requestingOrigin)) return false
    return [
      'media',
      'notifications',
      'clipboard-sanitized-write',
      'fullscreen',
      'pointerLock',
      'mediaKeySystem',
    ].includes(permission)
  })

  // Screen sharing uses the Windows picker when it is available. The site
  // disables display capture in its CSP, so this is just a safe fallback.
  if (typeof ses.setDisplayMediaRequestHandler === 'function') {
    ses.setDisplayMediaRequestHandler(
      (_request, callback) => callback({}),
      { useSystemPicker: true },
    )
  }

  ses.setSpellCheckerLanguages(['en-US', 'en-GB'])

  ses.on('will-download', (_event, item, webContents) => {
    const win = BrowserWindow.fromWebContents(webContents) || mainWindow
    const filename = item.getFilename() || 'download'
    const defaultPath = path.join(app.getPath('downloads'), filename)

    item.setSaveDialogOptions({
      title: 'Save download',
      defaultPath,
      buttonLabel: 'Save',
    })

    item.on('updated', (_event, state) => {
      if (!win || win.isDestroyed()) return
      if (state === 'progressing' && item.getTotalBytes() > 0) {
        win.setProgressBar(item.getReceivedBytes() / item.getTotalBytes())
      } else if (state === 'interrupted') {
        win.setProgressBar(-1)
      }
    })

    item.on('done', (_event, state) => {
      if (win && !win.isDestroyed()) win.setProgressBar(-1)

      if (state === 'completed') {
        const savedPath = item.getSavePath()
        if (win && !win.isDestroyed() && !win.isFocused() && Notification.isSupported()) {
          const notification = new Notification({
            title: 'Download complete',
            body: filename,
            icon: ICON_PATH,
          })
          notification.on('click', () => {
            win.show()
            win.focus()
            shell.showItemInFolder(savedPath)
          })
          notification.show()
        }
      } else if (state === 'interrupted' && win && !win.isDestroyed()) {
        dialog.showMessageBox(win, {
          type: 'error',
          title: 'Download failed',
          message: `Could not download ${filename}.`,
          buttons: ['OK'],
        })
      }
    })
  })
}

function setupWebContents() {
  app.on('web-contents-created', (_event, contents) => {
    const popupOptions = {
      width: 560,
      height: 760,
      parent: BrowserWindow.fromWebContents(contents) || undefined,
      autoHideMenuBar: true,
      backgroundColor: '#292929',
      icon: ICON_PATH,
      title: APP_NAME,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
        navigateOnDragDrop: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    }

    contents.setWindowOpenHandler(({ url }) => {
      // about:blank is how the site opens connector/OAuth popups before it
      // knows the provider URL.
      if (url === 'about:blank' || isInternalUrl(url) || isAuthDomain(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: popupOptions }
      }

      // From the chat or an in-app tab, https links open as Stram tabs —
      // the user stays in the app instead of bouncing to an external browser.
      const isAppSurface = (mainWindow && contents === mainWindow.webContents) || siteTabContents.has(contents)
      if (isAppSurface && /^https:\/\//i.test(url)) {
        openSiteTab(url, { activate: true })
        return { action: 'deny' }
      }

      openExternal(url)
      return { action: 'deny' }
    })

    contents.on('did-create-window', (child) => {
      popupContents.add(child.webContents)
    })

    const allowNavigation = (url) => {
      // Once a window was opened as a popup, let it follow its sign-in chain.
      if (popupContents.has(contents)) return /^https?:/i.test(url) || url === 'about:blank'
      // Sidebar tabs are a real browser: links followed inside the page stay
      // in the sidebar instead of jumping to the system browser.
      if (siteTabContents.has(contents)) return /^https?:\/\//i.test(url) || url === 'about:blank'
      return isInternalUrl(url) || isAuthDomain(url)
    }

    contents.on('will-navigate', (event, url) => {
      if (allowNavigation(url)) return
      event.preventDefault()
      openExternal(url)
    })

    // Redirects do not always emit will-navigate. Keep the same allow-list so
    // a remote page cannot redirect the main window onto file:// or another
    // untrusted origin.
    contents.on('will-redirect', (event, url) => {
      if (allowNavigation(url)) return
      event.preventDefault()
      openExternal(url)
    })

    contents.on('will-attach-webview', (event) => event.preventDefault())

    contents.on('context-menu', (_event, params) => {
      const win = BrowserWindow.fromWebContents(contents)
      const template = []

      if (params.linkURL) {
        template.push(
          { label: 'Open Link in Browser', click: () => openExternal(params.linkURL) },
          { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
          { type: 'separator' },
        )
      }

      if (params.misspelledWord) {
        const suggestions = (params.dictionarySuggestions || []).slice(0, 5)
        for (const suggestion of suggestions) {
          template.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) })
        }
        if (suggestions.length > 0) template.push({ type: 'separator' })
        template.push(
          {
            label: 'Add to Dictionary',
            click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
          },
          { type: 'separator' },
        )
      }

      if (params.isEditable) {
        template.push(
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { type: 'separator' },
          { role: 'selectAll' },
        )
      } else if (params.selectionText && params.selectionText.trim()) {
        template.push({ role: 'copy' })
      } else {
        template.push({ role: 'selectAll' })
      }

      template.push(
        { type: 'separator' },
        { label: 'Open Page in Browser', click: () => openExternal(contents.getURL()) },
        { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
        { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
        { label: 'Reload', click: () => contents.reload() },
      )

      Menu.buildFromTemplate(template).popup({ window: win || undefined })
    })
  })
}

function isLocalSender(event) {
  try {
    const frameUrl = event.senderFrame ? event.senderFrame.url : event.sender.getURL()
    return typeof frameUrl === 'string' && frameUrl.startsWith('file://')
  } catch {
    return false
  }
}

function registerIpc() {
  ipcMain.handle('stram:info', (event) => {
    if (!isLocalSender(event)) return null
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
      siteUrl: config.siteUrl,
      defaultSiteUrl: DEFAULT_SITE_URL,
      isPackaged: app.isPackaged,
    }
  })

  ipcMain.handle('stram:retry', (event) => {
    if (!isLocalSender(event)) return false
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(config.siteUrl)
    }
    return true
  })

  ipcMain.handle('stram:open-external', (event, url) => {
    if (!isLocalSender(event)) return false
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
    openExternal(url)
    return true
  })

  ipcMain.handle('stram:open-settings', (event) => {
    if (!isLocalSender(event)) return false
    openSettings()
    return true
  })

  ipcMain.handle('stram:get-settings', (event) => {
    if (!isLocalSender(event)) return null
    return {
      siteUrl: config.siteUrl,
      defaultSiteUrl: DEFAULT_SITE_URL,
    }
  })

  ipcMain.handle('stram:save-settings', (event, rawUrl) => {
    if (!isLocalSender(event)) return { ok: false, error: 'Not allowed.' }
    const normalized = normalizeSiteUrl(rawUrl)
    if (!normalized) {
      return { ok: false, error: 'Enter a valid address, like https://stram.lol' }
    }

    config.siteUrl = normalized
    saveConfig()

    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(normalized).catch(() => {
        showOfflinePage(mainWindow, {
          code: '',
          description: 'Could not reach the site.',
          url: normalized,
        })
      })
    } else {
      createWindow()
    }

    return { ok: true, siteUrl: normalized }
  })

  ipcMain.handle('stram:reset-settings', (event) => {
    if (!isLocalSender(event)) return { ok: false, error: 'Not allowed.' }
    config.siteUrl = DEFAULT_SITE_URL
    saveConfig()
    return { ok: true, siteUrl: DEFAULT_SITE_URL }
  })

  ipcMain.handle('stram:close-settings', (event) => {
    if (!isLocalSender(event)) return false
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close()
    return true
  })

  ipcMain.handle('stram:start-sign-in', (event) => {
    if (!isLocalSender(event)) return false
    startBrowserSignIn()
    return true
  })

  ipcMain.handle('stram:continue-to-site', (event) => {
    if (!isLocalSender(event)) return false
    if (!mainWindow || mainWindow.isDestroyed()) return false
    mainWindow.loadURL(config.siteUrl).catch(() => {
      showOfflinePage(mainWindow, {
        code: '',
        description: 'Could not reach the site.',
        url: config.siteUrl,
      })
    })
    return true
  })

  // ============================================================
  // STRAM COMPUTER TOOLS
  // ============================================================
  // The site hosted inside this window may drive a small set of computer
  // actions: shell commands, file reads/lists/writes and screen capture. Every
  // handler verifies that the calling frame is the configured Stram site (never
  // an auth domain or local page) before touching anything.
  // ============================================================
  const COMPUTER_OUTPUT_LIMIT = 60 * 1024
  const SYSTEM_BLOCKED_PREFIXES_WIN = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata\\microsoft']

  function isSiteSender(event) {
    try {
      const frameUrl = event.senderFrame && !event.senderFrame.destroyed ? event.senderFrame.url : event.sender.getURL()
      if (typeof frameUrl !== 'string' || !frameUrl) return false
      const origin = new URL(frameUrl).origin
      return origin === siteOrigin() || origin === new URL(DEFAULT_SITE_URL).origin
    } catch {
      return false
    }
  }

  // The docked browser's own local page. It only drives the tab surface; it
  // never gets the computer/file APIs above.
  function isSidebarSender(event) {
    try {
      return Boolean(sidebarChrome && !sidebarChrome.webContents.isDestroyed() && event.sender === sidebarChrome.webContents)
    } catch {
      return false
    }
  }

  function normaliseCommandOutput(stdout, stderr) {
    let output = (stdout || '').toString()
    const error = (stderr || '').toString() || null
    if (output.length > COMPUTER_OUTPUT_LIMIT) output = `${output.slice(0, COMPUTER_OUTPUT_LIMIT)}\n… output truncated (${COMPUTER_OUTPUT_LIMIT} bytes shown)`
    return { output: output || '', error }
  }

  function runShellCommand(command, timeoutMs = 120000) {
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let child
      try {
        child = child_process.spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
        ], { windowsHide: true })
      } catch (error) {
        resolve({ ok: true, output: '', error: error?.message || 'Could not start the shell.', timedOut: false })
        return
      }
      const timer = setTimeout(() => {
        timedOut = true
        try { child.kill() } catch {}
      }, timeoutMs)
      child.stdout.on('data', (chunk) => {
        if (stdout.length < COMPUTER_OUTPUT_LIMIT * 2) stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        if (stderr.length < COMPUTER_OUTPUT_LIMIT * 2) stderr += chunk.toString()
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ ok: true, output: stdout, error: error?.message || 'Command failed.', timedOut })
      })
      child.on('close', () => {
        clearTimeout(timer)
        const trimmed = normaliseCommandOutput(stdout, stderr)
        resolve({ ok: true, ...trimmed, timedOut })
      })
    })
  }

  function resolveHomePath() {
    try { return os.homedir() } catch { return '' }
  }

  /** Filesystem paths must stay on this computer and out of Windows system areas. */
  function isSafeWritePath(input) {
    if (typeof input !== 'string' || !input.trim()) return false
    const candidate = path.resolve(input.trim())
    const lowered = candidate.toLowerCase()
    if (SYSTEM_BLOCKED_PREFIXES_WIN.some((blocked) => lowered.startsWith(blocked + '\\') || lowered === blocked)) return false
    return /^[a-z]:\\|^\\\\/.test(lowered) || lowered.startsWith('/')
  }

  // ---------- Real desktop app launch + control ----------
  const APP_ALIASES = {
    notepad: 'notepad.exe',
    'note pad': 'notepad.exe',
    calculator: 'calc.exe',
    calc: 'calc.exe',
    paint: 'mspaint.exe',
    'file explorer': 'explorer.exe',
    explorer: 'explorer.exe',
    files: 'explorer.exe',
    cmd: 'cmd.exe',
    'command prompt': 'cmd.exe',
    powershell: 'powershell.exe',
    'task manager': 'taskmgr.exe',
    taskmgr: 'taskmgr.exe',
    'control panel': 'control.exe',
    'registry editor': 'regedit.exe',
    'snipping tool': 'snippingtool.exe',
    wordpad: 'write.exe',
    'character map': 'charmap.exe',
    'device manager': 'devmgmt.msc',
    'disk management': 'diskmgmt.msc',
  }
  const APP_URIS = {
    settings: 'ms-settings:',
    'windows settings': 'ms-settings:',
    store: 'ms-windows-store:',
    'microsoft store': 'ms-windows-store:',
  }
  let lastOpenedApp = null

  function psQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`
  }

  function appNameAllowed(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 300 && /^[A-Za-z0-9 _.\-+():\\]+$/.test(value)
  }

  /** Launch a Windows app by friendly name, exe, or Start-menu entry. */
  async function launchDesktopApp(input) {
    const requested = String(input || '').trim()
    if (!appNameAllowed(requested)) return { ok: false, error: 'That app name is not allowed.' }
    const lower = requested.toLowerCase()

    if (APP_URIS[lower]) {
      await shell.openExternal(APP_URIS[lower])
      lastOpenedApp = lower
      return { ok: true, output: `Opened ${requested}` }
    }

    const executable = APP_ALIASES[lower] || requested
    const script = `
$ErrorActionPreference = 'Stop'
$target = ${psQuote(requested)}
$resolved = ${psQuote(executable)}
$started = $null
try {
  $started = Start-Process -FilePath $resolved -PassThru -ErrorAction Stop
} catch {
  $app = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq $target } | Select-Object -First 1
  if (-not $app) { $app = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.Name -ilike "*$target*" } | Select-Object -First 1 }
  if (-not $app) { throw "No app named '$target' was found on this computer." }
  Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\\$($app.AppID)"
  $resolved = $app.Name
}
Start-Sleep -Milliseconds 900
if ($started) { Write-Output ("Launched " + $started.ProcessName) } else { Write-Output ("Launched " + $resolved) }
`
    const outcome = await runShellCommand(script, 30000)
    if (outcome.error && !outcome.output) return { ok: false, error: String(outcome.error).slice(0, 500) }
    if (!outcome.output.trim()) return { ok: false, error: `Could not launch ${requested}.` }
    lastOpenedApp = path.basename(executable).replace(/\.exe$/i, '').replace(/\.msc$/i, '') || requested
    return { ok: true, output: outcome.output.trim() }
  }

  const WINDOW_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class StramWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(int attach, int attachTo, bool attachFlag);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
function Get-StramWindow([string]$needle) {
  $lower = $needle.ToLowerInvariant()
  $windows = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object Id -Descending
  # Prefer an exact process or title match so "code" cannot accidentally
  # land in "OpenCode" (or any other app whose name merely contains it).
  $exactName = $windows | Where-Object { $_.ProcessName.ToLowerInvariant() -eq $lower } | Select-Object -First 1
  if ($exactName) { return $exactName }
  $exactTitle = $windows | Where-Object { $_.MainWindowTitle.ToLowerInvariant() -eq $lower } | Select-Object -First 1
  if ($exactTitle) { return $exactTitle }
  foreach ($process in $windows) {
    try {
      $name = $process.ProcessName.ToLowerInvariant()
      $title = $process.MainWindowTitle.ToLowerInvariant()
      if ($name.Contains($lower) -or $title.Contains($lower)) { return $process }
    } catch {}
  }
  return $null
}
function Get-StramForegroundTitle {
  $handle = [StramWin]::GetForegroundWindow()
  $builder = New-Object System.Text.StringBuilder 512
  [void][StramWin]::GetWindowText($handle, $builder, 512)
  return $builder.ToString()
}
function Focus-StramWindow([string]$needle) {
  $window = Get-StramWindow $needle
  if (-not $window) { return $null }
  $handle = $window.MainWindowHandle
  [StramWin]::ShowWindow($handle, 9) | Out-Null
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shell.AppActivate($window.Id) | Out-Null
  } catch {}
  [StramWin]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 500
  if ([StramWin]::GetForegroundWindow() -ne $handle) {
    $foreground = [StramWin]::GetForegroundWindow()
    $foregroundPid = 0
    $targetPid = 0
    $foregroundThread = [StramWin]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
    $targetThread = [StramWin]::GetWindowThreadProcessId($handle, [ref]$targetPid)
    [StramWin]::AttachThreadInput($foregroundThread, $targetThread, $true) | Out-Null
    [StramWin]::SetForegroundWindow($handle) | Out-Null
    [StramWin]::AttachThreadInput($foregroundThread, $targetThread, $false) | Out-Null
    Start-Sleep -Milliseconds 400
  }
  if ([StramWin]::GetForegroundWindow() -ne $handle) {
    $actual = Get-StramForegroundTitle
    Write-Error "Could not bring '$needle' to the foreground. The active window is '$actual'."
  }
  return $window
}
`

  async function focusDesktopApp(input, launchIfMissing = false) {
    const target = String(input || lastOpenedApp || '').trim()
    if (!target) return { ok: false, error: 'Name an app or window to control first.' }
    if (!appNameAllowed(target)) return { ok: false, error: 'That app name is not allowed.' }

    const attempt = async () => runShellCommand(`
${WINDOW_PRELUDE}
$target = ${psQuote(target)}
$window = Focus-StramWindow $target
if (-not $window) { Write-Error "No open window matches '$target'."; exit 1 }
Write-Output ("Focused " + $window.ProcessName + " - " + $window.MainWindowTitle)
`, 20000)

    let outcome = await attempt()
    if ((outcome.error || !outcome.output.trim()) && launchIfMissing) {
      const launched = await launchDesktopApp(target)
      if (!launched.ok) return launched
      outcome = await attempt()
    }
    if (outcome.error || !outcome.output.trim()) {
      return { ok: false, error: String(outcome.error || `No open window matches '${target}'.`).trim().slice(0, 500) }
    }
    lastOpenedApp = target
    return { ok: true, output: outcome.output.trim() }
  }

  async function runDesktopAppAction(action, payload) {
    const args = payload && typeof payload === 'object' ? payload : {}
    const target = typeof args.target === 'string' ? args.target.trim() : ''

    if (action === 'list') {
      const outcome = await runShellCommand(`
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 40 | ForEach-Object { "{0} | {1}" -f $_.ProcessName, $_.MainWindowTitle }
`, 20000)
      return { ok: true, output: outcome.output.trim() || 'No app windows are open.' }
    }

    if (action === 'launch') {
      if (!target) return { ok: false, error: 'Name the app to launch.' }
      return launchDesktopApp(target)
    }

    if (action === 'focus') {
      return focusDesktopApp(target, true)
    }

    if (action === 'type') {
      const text = typeof args.text === 'string' ? args.text : ''
      if (!text) return { ok: false, error: 'There is no text to type.' }
      if (text.length > 20000) return { ok: false, error: 'That text is too long to type at once.' }
      const targetName = String(target || lastOpenedApp || '').trim()
      if (!targetName) return { ok: false, error: 'Open the app first, then type into it.' }
      if (!appNameAllowed(targetName)) return { ok: false, error: 'That app name is not allowed.' }
      const encoded = Buffer.from(text, 'utf8').toString('base64')
      const encodedTarget = Buffer.from(targetName, 'utf8').toString('base64')
      // Focus and type inside one PowerShell session so the foreground check
      // and the keystrokes happen back to back, never in a different app.
      const outcome = await runShellCommand(`
${WINDOW_PRELUDE}
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTarget}'))
$window = Focus-StramWindow $target
if (-not $window) { Write-Error "Could not bring '$target' to the foreground."; exit 1 }
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
Set-Clipboard -Value $text
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('^v')
${args.submit === true ? "Start-Sleep -Milliseconds 200\n[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')" : ''}
Start-Sleep -Milliseconds 250
Write-Output ("Typed " + $text.Length + " characters into " + $window.ProcessName + " - " + $window.MainWindowTitle)
`, 30000)
      if (outcome.error) return { ok: false, error: String(outcome.error).slice(0, 500) }
      return { ok: true, output: outcome.output.trim() || 'Text typed.' }
    }

    if (action === 'keys') {
      const keys = typeof args.keys === 'string' ? args.keys : ''
      if (!keys) return { ok: false, error: 'There are no keys to press.' }
      if (!/^[A-Za-z0-9\s{}()^%~+_.-]{1,120}$/.test(keys)) return { ok: false, error: 'Those key presses are not allowed.' }
      const targetName = String(target || lastOpenedApp || '').trim()
      if (!targetName) return { ok: false, error: 'Open the app first, then press keys in it.' }
      if (!appNameAllowed(targetName)) return { ok: false, error: 'That app name is not allowed.' }
      const encoded = Buffer.from(keys, 'utf8').toString('base64')
      const encodedTarget = Buffer.from(targetName, 'utf8').toString('base64')
      const outcome = await runShellCommand(`
${WINDOW_PRELUDE}
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTarget}'))
$window = Focus-StramWindow $target
if (-not $window) { Write-Error "Could not bring '$target' to the foreground."; exit 1 }
$keys = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
[System.Windows.Forms.SendKeys]::SendWait($keys)
Start-Sleep -Milliseconds 200
Write-Output ("Pressed " + $keys + " in " + $window.ProcessName + " - " + $window.MainWindowTitle)
`, 30000)
      if (outcome.error) return { ok: false, error: String(outcome.error).slice(0, 500) }
      return { ok: true, output: outcome.output.trim() || 'Keys pressed.' }
    }

    if (action === 'click') {
      const x = Number(args.x)
      const y = Number(args.y)
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) {
        return { ok: false, error: 'Click needs valid screen coordinates.' }
      }
      const focused = target ? await focusDesktopApp(target, false) : { ok: true }
      if (!focused.ok) return focused
      const outcome = await runShellCommand(`
${WINDOW_PRELUDE}
[StramWin]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
Start-Sleep -Milliseconds 120
[StramWin]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[StramWin]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
Write-Output "Clicked at ${Math.round(x)}, ${Math.round(y)}."
`, 20000)
      if (outcome.error && !outcome.output) return { ok: false, error: String(outcome.error).slice(0, 500) }
      return { ok: true, output: outcome.output.trim() || 'Clicked.' }
    }

    return { ok: false, error: `Unknown app action "${action}".` }
  }

  ipcMain.handle('stram:computer-app', async (event, action, payload) => {
    if (!isSiteSender(event) || typeof action !== 'string') return { ok: false, error: 'App control not allowed.' }
    try {
      return await runDesktopAppAction(action.toLowerCase(), payload)
    } catch (error) {
      return { ok: false, error: error?.message || 'The app action failed.' }
    }
  })

  ipcMain.handle('stram:computer-run', async (event, command) => {
    if (!isSiteSender(event) || typeof command !== 'string' || !command.trim()) {
      return { ok: false, error: 'Command not allowed.' }
    }
    if (command.length > 4000) return { ok: false, error: 'That command is too long.' }
    return runShellCommand(command.trim(), 120000)
  })

  ipcMain.handle('stram:computer-fs', async (event, op, payload) => {
    if (!isSiteSender(event) || !payload || typeof payload !== 'object') return { ok: false, error: 'File operation not allowed.' }
    const target = typeof payload.path === 'string' ? payload.path.trim() : ''
    if (!target) return { ok: false, error: 'A file or folder path is required.' }
    try {
      if (op === 'read') {
        const stat = fs.statSync(target)
        if (stat.isDirectory()) return { ok: false, error: 'That is a folder; use the list operation.' }
        if (stat.size > 512 * 1024) return { ok: false, error: 'That file is larger than the 512 KB read limit.' }
        return { ok: true, output: fs.readFileSync(target, 'utf8') }
      }
      if (op === 'list') {
        const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, 400).map((entry) => `${entry.isDirectory() ? '%FOLDER%' : '%FILE%'} ${entry.name}`)
        return { ok: true, output: entries.join('\n') || '(the folder is empty)' }
      }
      if (op === 'write' || op === 'append') {
        if (!isSafeWritePath(target)) return { ok: false, error: 'That path is not allowed (system areas are protected).' }
        if (typeof payload.content !== 'string') return { ok: false, error: 'File content is required.' }
        if (payload.content.length > 1024 * 1024) return { ok: false, error: 'File content exceeds the 1 MB write limit.' }
        fs.mkdirSync(path.dirname(target), { recursive: true })
        if (op === 'append') fs.appendFileSync(target, payload.content, 'utf8')
        else fs.writeFileSync(target, payload.content, 'utf8')
        return { ok: true, output: `Saved ${path.resolve(target)}` }
      }
      return { ok: false, error: 'Unknown file operation.' }
    } catch (error) {
      return { ok: false, error: error?.message || 'The file operation failed.' }
    }
  })

  ipcMain.handle('stram:computer-screen', async (event) => {
    if (!isSiteSender(event)) return { ok: false, error: 'Screen capture not allowed.' }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1600, height: 900 } })
      const primary = sources.find((entry) => entry.thumbnail && !entry.thumbnail.isEmpty())
      if (!primary) return { ok: false, error: 'No screen was available to capture.' }
      const image = primary.thumbnail.toDataURL().replace(/^data:image\/png;base64,/, '')
      return { ok: true, image }
    } catch (error) {
      return { ok: false, error: error?.message || 'Screen capture failed.' }
    }
  })

  // Read a webpage from this computer: fetch the URL (https only, capped) and
  // hand the page's readable text back to the assistant.
  ipcMain.handle('stram:computer-browse', async (event, url) => {
    if (!isSiteSender(event) || typeof url !== 'string' || !url.trim()) {
      return { ok: false, error: 'Browse action not allowed.' }
    }
    const requested = url.trim().slice(0, 2000)
    try {
      const parsed = new URL(/^https?:\/\//i.test(requested) ? requested : `https://${requested}`)
      if (parsed.protocol !== 'https:') return { ok: false, error: 'Only https pages can be read.' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 25000)
      const response = await fetch(parsed.href, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) StramDesktop', 'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
        redirect: 'follow',
      })
      clearTimeout(timer)
      const contentType = String(response.headers.get('content-type') || '')
      const raw = (await response.text()).slice(0, 512 * 1024)
      if (!response.ok) return { ok: false, error: `The page responded ${response.status}.` }
      let text = raw
      if (/html|xml|svg/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw)) {
        text = raw
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
          .replace(/<head[\s\S]*?<\/head>/gi, ' ')
          .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, ' ')
          .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/\s+\n/g, '\n')
          .trim()
      }
      if (text.length > 60 * 1024) text = `${text.slice(0, 60 * 1024)}\n… page text truncated`
      if (!text) return { ok: false, error: 'The page had no readable text.' }
      return { ok: true, output: `URL: ${parsed.href}\n\n${text}` }
    } catch (error) {
      return { ok: false, error: error?.message || 'The page could not be loaded.' }
    }
  })

  ipcMain.handle('stram:computer-info', async (event) => {
    if (!isSiteSender(event)) return { ok: false, error: 'Not allowed.' }
    return {
      ok: true,
      info: {
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        home: resolveHomePath(),
        hostname: os.hostname(),
        username: (process.env.USERNAME || process.env.USER || '').trim(),
        workspace: workspaceFolderPath(),
      },
    }
  })

  // Open a website or an app for the user ("open Google Calendar", "open
  // notepad"). URLs and known URI schemes go through shell.openExternal; app
  // names are resolved through the Start menu and launched as real processes.
  ipcMain.handle('stram:computer-open', async (event, target) => {
    if (!isSiteSender(event) || typeof target !== 'string' || !target.trim()) {
      return { ok: false, error: 'Open action not allowed.' }
    }
    const requested = target.trim().slice(0, 300)
    try {
      if (/^https?:\/\/[^\s]+$/i.test(requested)) {
        const parsed = new URL(requested)
        await shell.openExternal(parsed.href)
        return { ok: true, output: `Opened ${parsed.hostname}${parsed.pathname.replace(/\/$/, '')}` }
      }
      if (/^[a-z][a-z0-9+.-]{1,30}:\/{0,2}[^\s"'<>|;&`$\\]*$/i.test(requested)) {
        await shell.openExternal(requested)
        return { ok: true, output: `Opened ${requested}` }
      }
      return await launchDesktopApp(requested)
    } catch (error) {
      return { ok: false, error: error?.message || 'That could not be opened.' }
    }
  })

  ipcMain.handle('stram:open-downloads', (event) => {
    if (!isLocalSender(event)) return false
    shell.openPath(app.getPath('downloads'))
    return true
  })

  // ---------- In-app browser tabs / docked sidebar ----------
  const canDriveTabs = (event) => isSiteSender(event) || isSidebarSender(event)

  ipcMain.handle('stram:tab-open', (event, rawUrl) => {
    if (!canDriveTabs(event)) return { ok: false, error: 'Tab action not allowed.' }
    return openSiteTab(String(rawUrl || ''), { activate: true })
  })

  ipcMain.handle('stram:tab-new', (event) => {
    if (!canDriveTabs(event)) return { ok: false, error: 'Tab action not allowed.' }
    return openBlankTab()
  })

  ipcMain.handle('stram:tab-close', (event, id) => {
    if (!canDriveTabs(event)) return { ok: false, error: 'Tab action not allowed.' }
    closeSiteTab(String(id || ''))
    return { ok: true }
  })

  ipcMain.handle('stram:tab-activate', (event, id) => {
    if (!canDriveTabs(event)) return { ok: false, error: 'Tab action not allowed.' }
    const key = String(id || '')
    if (key === 'chat') activateChat()
    else activateSiteTab(key)
    return { ok: true }
  })

  ipcMain.handle('stram:tab-list', (event) => {
    if (!canDriveTabs(event)) return { ok: false, error: 'Tab action not allowed.' }
    return { ok: true, ...tabStatePayload() }
  })

  ipcMain.handle('stram:sidebar-open', (event) => {
    if (!isSiteSender(event)) return { ok: false, error: 'Not allowed.' }
    return showSidebar()
  })

  ipcMain.handle('stram:sidebar-hide', (event) => {
    if (!canDriveTabs(event)) return { ok: false, error: 'Not allowed.' }
    activateChat()
    return { ok: true }
  })

  ipcMain.handle('stram:tab-command', async (event, rawAction, payload) => {
    if (!canDriveTabs(event)) return { ok: false, error: 'Not allowed.' }
    if (!rawAction || typeof rawAction !== 'string') return { ok: false, error: 'A browser action is required.' }
    if (payload && typeof payload !== 'object') return { ok: false, error: 'Invalid browser action.' }
    try {
      return await runBrowserCommand(rawAction, payload || {})
    } catch (error) {
      return { ok: false, error: error?.message || 'The browser action failed.' }
    }
  })

  // ---------- Local MCP servers ----------
  ipcMain.handle('stram:mcp-list', (event) => {
    if (!isSiteSender(event)) return { ok: false, error: 'Not allowed.' }
    return { ok: true, servers: mcpStateList() }
  })

  ipcMain.handle('stram:mcp-link', async (event, raw) => {
    if (!isSiteSender(event) || !raw || typeof raw !== 'object') return { ok: false, error: 'Not allowed.' }
    const name = sanitizeMcpServerName(raw.name)
    const command = String(raw.command || '').trim().slice(0, 500)
    const args = Array.isArray(raw.args) ? raw.args.slice(0, 24).map((arg) => String(arg).slice(0, 400)) : []
    if (!name) return { ok: false, error: 'A server name is required.', servers: mcpStateList() }
    if (!command || /[\r\n]/.test(command)) return { ok: false, error: 'A valid start command is required.', servers: mcpStateList() }
    const outcome = await startMcpServer({ name, command, args })
    if (outcome.ok) {
      const list = readMcpConfig().filter((entry) => sanitizeMcpServerName(entry.name) !== name)
      list.push({ name, command, args })
      writeMcpConfig(list.slice(-8))
    } else {
      // A preset that cannot start (uv missing, app not installed yet) should
      // show its hint without leaving a dead server in the Workspace list.
      const failed = mcpServers.get(name)
      if (failed) {
        stopMcpServer(failed, true)
        mcpServers.delete(name)
      }
      refreshMcpPlannerIndex()
    }
    return { ok: outcome.ok, error: outcome.error || null, servers: mcpStateList() }
  })

  ipcMain.handle('stram:mcp-unlink', (event, raw) => {
    if (!isSiteSender(event) || !raw || typeof raw !== 'object') return { ok: false, error: 'Not allowed.' }
    const name = sanitizeMcpServerName(raw && raw.name)
    const server = mcpServers.get(name)
    if (server) stopMcpServer(server, true)
    mcpServers.delete(name)
    writeMcpConfig(readMcpConfig().filter((entry) => sanitizeMcpServerName(entry.name) !== name))
    refreshMcpPlannerIndex()
    return { ok: true, servers: mcpStateList() }
  })

  ipcMain.handle('stram:mcp-restart', async (event, raw) => {
    if (!isSiteSender(event) || !raw || typeof raw !== 'object') return { ok: false, error: 'Not allowed.' }
    const name = sanitizeMcpServerName(raw && raw.name)
    const record = readMcpConfig().find((entry) => sanitizeMcpServerName(entry.name) === name)
    if (!record) return { ok: false, error: 'That server is not linked.', servers: mcpStateList() }
    const outcome = await startMcpServer(record)
    return { ok: outcome.ok, error: outcome.error || null, servers: mcpStateList() }
  })

  ipcMain.handle('stram:mcp-call', (event, raw) => {
    if (!isSiteSender(event) || !raw || typeof raw !== 'object') return { ok: false, error: 'Not allowed.' }
    const tool = String(raw.tool || '')
    const args = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args : {}
    return callMcpTool(tool, args)
  })
}

const hasSingleInstanceLock = (() => {
  // Development/testing override: a second copy must not steal the real
  // instance's profile or single-instance lock.
  if (process.env.STRAM_USER_DATA_DIR) {
    try { app.setPath('userData', path.resolve(process.env.STRAM_USER_DATA_DIR)) } catch {}
  }
  return app.requestSingleInstanceLock()
})()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  let pendingProtocolUrl = findProtocolUrl(process.argv)

  app.on('second-instance', (_event, commandLine) => {
    const protocolUrl = findProtocolUrl(commandLine)
    if (protocolUrl) {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow()
      void handleProtocolUrl(protocolUrl)
      return
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  // macOS delivers protocol links through open-url rather than argv.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (app.isReady()) void handleProtocolUrl(url)
    else pendingProtocolUrl = url
  })

  app.setAppUserModelId('com.stram.desktop')

  app.whenReady().then(() => {
    configPath = path.join(app.getPath('userData'), 'settings.json')
    readConfig()

    // The file explorer, the filesystem MCP preset, and the AI's file tools all
    // share this folder; create it before any server or panel asks for it.
    try { fs.mkdirSync(workspaceFolderPath(), { recursive: true }) } catch {}

    const cliUrl = parseCliUrl()
    if (cliUrl) {
      config.siteUrl = cliUrl
      saveConfig()
    }

    // Present as a normal Chrome build. Some OAuth providers refuse a UA that
    // advertises Electron.
    app.userAgentFallback = app.userAgentFallback
      .replace(/\sElectron\/[\d.]+/i, '')
      .replace(/\sStram\/[\d.]+/i, '')
      .replace(/\sstram-desktop\/[\d.]+/i, '')

    ensureProtocolRegistered()
    setupSession(session.defaultSession)
    setupWebContents()
    registerIpc()
    buildMenu()
    createWindow()

    // Restart any MCP servers the user linked earlier.
    for (const record of readMcpConfig().slice(0, 8)) {
      void startMcpServer(record).catch(() => {})
    }

    if (pendingProtocolUrl) {
      const protocolUrl = pendingProtocolUrl
      pendingProtocolUrl = ''
      setTimeout(() => void handleProtocolUrl(protocolUrl), 500)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    closeAuthFlow()
    app.quit()
  })

  app.on('will-quit', () => {
    closeAuthFlow()
  })
}
