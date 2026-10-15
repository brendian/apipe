import { realpathSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import type { PushChannel, PushPayloads } from '@advpipe/contracts';
import { UserError } from './ipc.js';
import type { PrefsStore } from './prefs.js';
import { isDirectory } from './repo.js';
import { watchRepo } from './watch.js';

type Entry = { win: BrowserWindow; repo: string | null; stopWatching: (() => void) | null };

export type WindowsOptions = {
  prefs: PrefsStore;
  /** Absolute path of the built preload (CommonJS). */
  preload: string;
  /** Where the renderer is served from: the dev server, or the app:// origin. */
  url: string;
  devTools: boolean;
  /** Keep windows hidden (the Playwright build). */
  hidden: boolean;
  log: (message: string, err?: unknown) => void;
};

const real = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

/**
 * One window per repo (docs/05 §2). A window is bound to its repo here, in main: handlers learn the
 * repo from the sending window and never from anything the window says.
 */
export class Windows {
  private readonly entries = new Map<number, Entry>(); // keyed by webContents id

  constructor(private readonly o: WindowsOptions) {}

  /** The window's repo (null: the welcome window), or undefined if `id` isn't one of ours. */
  repoOf(webContentsId: number): { repo: string | null; windowId: number } | undefined {
    const entry = this.entries.get(webContentsId);
    return entry ? { repo: entry.repo, windowId: webContentsId } : undefined;
  }

  openRepos(): string[] {
    return [...this.entries.values()].flatMap((e) => (e.repo === null ? [] : [e.repo]));
  }

  focused(): BrowserWindow | null {
    return BrowserWindow.getFocusedWindow() ?? this.entries.values().next().value?.win ?? null;
  }

  /** Tell the focused window to navigate (a native menu item). */
  menu(action: PushPayloads['app.menu']['action']): void {
    this.focused()?.webContents.send('app.menu' satisfies PushChannel, { action });
  }

  /** Open `repoInput`, or the welcome window if null. A repo that is open already is focused. */
  async open(repoInput: string | null, fromWindowId?: number): Promise<boolean> {
    if (repoInput === null) {
      const welcome = [...this.entries.values()].find((e) => e.repo === null);
      if (welcome) return this.focus(welcome.win);
      this.create(null);
      return true;
    }
    if (!isDirectory(repoInput)) throw new UserError("That folder doesn't exist any more.");
    const repo = real(repoInput);
    const existing = [...this.entries.values()].find((e) => e.repo === repo);
    if (existing) return this.focus(existing.win);
    this.o.prefs.addRecent(repo);
    const from = fromWindowId === undefined ? undefined : this.entries.get(fromWindowId);
    if (from && from.repo === null) {
      this.bind(from, repo); // the welcome window becomes this repo's window
      return true;
    }
    this.create(repo);
    return true;
  }

  /** The native folder dialog, run here so the window never sees an arbitrary path. */
  async pick(fromWindowId: number): Promise<boolean> {
    const parent = this.entries.get(fromWindowId)?.win;
    const options = {
      title: 'Open a git repo',
      properties: ['openDirectory' as const],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const dir = result.filePaths[0];
    if (result.canceled || dir === undefined) return false;
    return this.open(dir, fromWindowId);
  }

  private focus(win: BrowserWindow): boolean {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  }

  private bind(entry: Entry, repo: string): void {
    entry.repo = repo;
    entry.stopWatching?.();
    entry.stopWatching = this.watch(entry.win, repo);
    entry.win.setTitle(`advpipe — ${path.basename(repo) || repo}`);
    entry.win.webContents.reload(); // the page asks main who it is on load
  }

  private watch(win: BrowserWindow, repo: string): () => void {
    const watcher = watchRepo(repo, (channel, payload) => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    });
    return () => watcher.close();
  }

  private create(repo: string | null): void {
    const saved = repo === null ? undefined : this.o.prefs.get().windows[repo];
    const title = repo === null ? 'advpipe' : `advpipe — ${path.basename(repo) || repo}`;
    const win = new BrowserWindow({
      width: saved?.width ?? 1100,
      height: saved?.height ?? 760,
      ...(saved?.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
      minWidth: 640,
      minHeight: 480,
      title,
      show: !this.o.hidden,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: this.o.preload,
        spellcheck: false,
        devTools: this.o.devTools,
        // The theme is applied before first paint by the preload (docs/05 §4.3).
        additionalArguments: [`--advpipe-theme=${this.o.prefs.get().theme}`],
      },
    });
    if (saved?.maximized) win.maximize();
    const id = win.webContents.id;
    const entry: Entry = { win, repo, stopWatching: null };
    this.entries.set(id, entry);
    if (repo !== null) entry.stopWatching = this.watch(win, repo);

    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('page-title-updated', (event) => event.preventDefault()); // keep "advpipe — <repo>"
    win.on('close', () => {
      const bound = this.entries.get(id)?.repo;
      if (bound == null || win.isDestroyed()) return;
      const b = win.getNormalBounds();
      this.o.prefs.update((p) => {
        p.windows[bound] = {
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          maximized: win.isMaximized(),
        };
      });
    });
    win.on('closed', () => {
      this.entries.get(id)?.stopWatching?.();
      this.entries.delete(id);
    });
    win.webContents.on('render-process-gone', (_e, details) =>
      this.o.log(`renderer gone: ${details.reason}`),
    );
    void win.loadURL(this.o.url);
  }
}
