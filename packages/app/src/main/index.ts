import { readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import { IPC_TABLE } from '@advpipe/contracts';
import { loadContext, loadDetail, loadRuns, loadUsage, preflight } from '@advpipe/engine';
import { APP_ORIGIN, createHandlers, dispatch } from './ipc.js';
import { createLogger } from './log.js';
import { installMenu } from './menu.js';
import { PrefsStore } from './prefs.js';
import { isDirectory, repoArg } from './repo.js';
import { Windows } from './windows.js';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = resolve(here, '../renderer');
const devUrl = process.env['ELECTRON_RENDERER_URL'] ?? null;
const e2e = process.env['ADVPIPE_E2E'] === '1';

// Tests give the app their own user-data folder, so preferences never leak between runs.
if (process.env['ADVPIPE_USER_DATA']) app.setPath('userData', process.env['ADVPIPE_USER_DATA']);

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

const openFromArgs = (argv: readonly string[], cwd: string, windows: Windows): void => {
  const repo = repoArg(argv, cwd, process.defaultApp === true);
  void windows.open(repo !== null && isDirectory(repo) ? repo : null).catch(() => undefined);
};

// One instance: a second `advpipe <repo>` asks the first to open that repo in a new window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    const userData = app.getPath('userData');
    const log = createLogger(join(userData, 'logs'));
    const prefs = new PrefsStore(join(userData, 'preferences.json'));
    const windows = new Windows({
      prefs,
      preload: join(here, '../preload/index.cjs'),
      url: devUrl ?? `${APP_ORIGIN}/index.html`,
      devTools: devUrl !== null,
      hidden: e2e,
      log,
    });

    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    registerAppProtocol();

    const handlers = createHandlers({
      prefs,
      engine: { loadRuns, loadDetail, loadContext, loadUsage, preflight },
      logs: windows.logs,
      windows,
      exists: isDirectory,
      defaultItemsDir: 'work-items',
    });
    for (const channel of Object.keys(IPC_TABLE)) {
      ipcMain.handle(channel, (event, raw: unknown) => {
        const known = windows.repoOf(event.sender.id);
        return dispatch(
          handlers,
          channel,
          raw,
          {
            frameUrl: event.senderFrame?.url ?? '',
            isOurWindow:
              known !== undefined && BrowserWindow.fromWebContents(event.sender) !== null,
            repo: known?.repo ?? null,
            windowId: known?.windowId ?? 0,
          },
          devUrl,
          log,
        );
      });
    }

    installMenu(windows, devUrl !== null);
    app.on('second-instance', (_event, argv, cwd) => openFromArgs(argv, cwd, windows));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void windows.open(null);
    });

    // Quitting never stops a run (workers are detached), but say so (docs/04 §3.6).
    let confirmed = e2e;
    app.on('before-quit', (event) => {
      if (confirmed) return;
      let running = 0;
      for (const repo of windows.openRepos()) running += loadRuns(repo, 'all').counts.running;
      if (running === 0) return;
      event.preventDefault();
      const noun = running === 1 ? '1 run is' : `${running} runs are`;
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `${noun} still working.`,
        detail: 'They keep going in the background; reopen advpipe to follow them. Quit?',
      });
      if (choice === 0) {
        confirmed = true;
        app.quit();
      }
    });

    openFromArgs(process.argv, process.cwd(), windows);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
