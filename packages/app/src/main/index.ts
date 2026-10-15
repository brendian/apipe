import { readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { IPC_TABLE } from '@advpipe/contracts';
import { APP_ORIGIN, createHandlers, dispatch } from './ipc.js';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = resolve(here, '../renderer');
const devUrl = process.env['ELECTRON_RENDERER_URL'] ?? null;

// docs/08 §2: no unsafe-inline, no unsafe-eval.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = resolve(rendererDir, `.${rel}`);
    const inside = relative(rendererDir, file);
    if (url.host !== 'renderer' || inside.startsWith('..') || resolve(inside) === inside) {
      return new Response('Not found', { status: 404 });
    }
    try {
      const body = await readFile(file);
      return new Response(new Uint8Array(body), {
        headers: {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          'content-security-policy': CSP,
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function registerIpc(): void {
  const handlers = createHandlers();
  for (const channel of Object.keys(IPC_TABLE)) {
    ipcMain.handle(channel, (event, raw: unknown) =>
      dispatch(
        handlers,
        channel,
        raw,
        {
          frameUrl: event.senderFrame?.url ?? '',
          isOurWindow: BrowserWindow.fromWebContents(event.sender) !== null,
        },
        devUrl,
      ),
    );
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    title: 'advpipe',
    show: process.env['ADVPIPE_E2E'] !== '1',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: join(here, '../preload/index.cjs'),
      spellcheck: false,
      devTools: devUrl !== null,
    },
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void win.loadURL(devUrl ?? `${APP_ORIGIN}/index.html`);
}

void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  registerAppProtocol();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
