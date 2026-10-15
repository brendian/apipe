import path from 'node:path';
import {
  IPC_TABLE,
  type FilterKey,
  type IpcChannel,
  type IpcInput,
  type IpcOutput,
  type Prefs,
  type PrefsView,
  type Result,
  type ContextView,
  type RunDetailOut,
  type RunList,
  type UsageView,
  type Preflight,
  type DeleteInfo,
  type DraftChecks,
  type DraftInput,
  type DraftView,
  type ItemList,
  type RunForm,
  type RunPlan,
  WorkItemError,
} from '@advpipe/contracts';
import { ItemError, NewRunError } from '@advpipe/engine';
import { prefsView } from './prefs.js';

/** Where a call came from: checked before a handler runs, resolved by main, never by the window. */
export interface SenderInfo {
  /** URL of the frame that sent the message. */
  frameUrl: string;
  /** True only for a web contents belonging to a window we created. */
  isOurWindow: boolean;
  /** The repo that window is bound to (null: the welcome window). The window can't choose it. */
  repo?: string | null;
  windowId?: number;
}

/** What a handler knows about its caller. */
export type Ctx = { repo: string | null; windowId: number };

/** An error whose message is meant for a person and is safe to render (as text, never HTML). */
export class UserError extends Error {
  override name = 'UserError';
}

export type Handlers = {
  [C in IpcChannel]: (input: IpcInput<C>, ctx: Ctx) => Promise<IpcOutput<C>>;
};

export const APP_ORIGIN = 'app://renderer';

/** What the handlers need from the rest of the host; tests pass fakes. */
export interface Deps {
  prefs: {
    get(): Prefs;
    update(change: (prefs: Prefs) => void): Prefs;
    forgetRecent(index: number): void;
  };
  engine: {
    loadRuns(repo: string, show: FilterKey): RunList;
    loadDetail(repo: string, runId: string): RunDetailOut;
    loadContext(repo: string, runId: string): Promise<ContextView | null>;
    loadUsage(repo: string): UsageView;
    preflight(repo: string, itemsDir: string): Promise<Preflight>;
    /** The work-items folder as an absolute path inside the repo; throws ItemPathError. */
    resolveItemsDir(repo: string, rel: string): string;
    loadItems(repo: string, itemsDir: string): Promise<ItemList>;
    readDraft(repo: string, itemsDir: string, rel: string): DraftView;
    checkDraft(repo: string, input: DraftInput): Promise<DraftChecks>;
    createItem(repo: string, itemsDir: string, input: DraftInput): Promise<string>;
    saveItem(repo: string, itemsDir: string, input: DraftInput): Promise<boolean>;
    renameItem(itemsDir: string, rel: string, newRel: string): string;
    itemDeleteInfo(repo: string, itemsDir: string, rel: string): Promise<DeleteInfo>;
    deleteItem(itemsDir: string, rel: string): void;
    planRun(repo: string, itemsDir: string, form: RunForm): Promise<RunPlan>;
    startNewRun(
      repo: string,
      itemsDir: string,
      form: RunForm,
      shown: string,
      budgetShown: string,
    ): Promise<{ runId: string }>;
  };
  logs: {
    subscribe(windowId: number, repo: string, runId: string, offset: number): void;
    unsubscribe(windowId: number, runId: string): void;
  };
  windows: {
    /** Show the folder dialog (in main) and open what was picked. */
    pick(windowId: number): Promise<boolean>;
    /** Open `repo` (focusing its window if it's open already). Throws UserError if it can't. */
    open(repo: string, fromWindowId: number): Promise<boolean>;
  };
  exists(dir: string): boolean;
  defaultItemsDir: string;
}

export function createHandlers(deps: Deps): Handlers {
  const need = (ctx: Ctx): string => {
    if (ctx.repo === null) throw new UserError('No repo is open in this window.');
    return ctx.repo;
  };
  /** A run.json that can't be read is "Can't read this run", never "No such run". */
  const unreadable = async <T>(read: () => T | Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(`Can't read this run: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const view = (ctx: Ctx): PrefsView =>
    prefsView(deps.prefs.get(), ctx.repo, deps.exists, deps.defaultItemsDir);
  /** Engine errors that are written for a person pass through as the message; others don't. */
  const person = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof ItemError || e instanceof NewRunError || e instanceof WorkItemError) {
        throw new UserError(e.message);
      }
      throw e;
    }
  };
  /** This window's work-items folder: its setting, checked to be inside the repo every time. */
  const itemsDirOf = (ctx: Ctx): string => {
    const repo = need(ctx);
    const rel = deps.prefs.get().items_dir[repo] ?? deps.defaultItemsDir;
    return deps.engine.resolveItemsDir(repo, rel);
  };

  return {
    'app.window.info': async (_in, ctx) => ({
      repo:
        ctx.repo === null ? null : { name: path.basename(ctx.repo) || ctx.repo, path: ctx.repo },
    }),
    'app.prefs.get': async (_in, ctx) => view(ctx),
    'app.prefs.set': async (change, ctx) => {
      deps.prefs.update((p) => {
        if (change.theme !== undefined) p.theme = change.theme;
        if (change.notifications !== undefined) p.notifications = change.notifications;
        if (change.run_filter !== undefined) p.run_filter[need(ctx)] = change.run_filter;
      });
      if (change.items_dir !== undefined) {
        const repo = need(ctx);
        // Checked before it is stored: a folder outside the repo is never kept.
        await person(() => deps.engine.resolveItemsDir(repo, change.items_dir as string));
        deps.prefs.update((p) => {
          p.items_dir[repo] = (change.items_dir as string).trim();
        });
      }
      return view(ctx);
    },
    'app.repo.pick': async (_in, ctx) => ({ opened: await deps.windows.pick(ctx.windowId) }),
    'app.repo.openRecent': async ({ index }, ctx) => {
      const repo = deps.prefs.get().recent_repos[index];
      if (repo === undefined) throw new UserError('That repo is not in the recent list any more.');
      return { opened: await deps.windows.open(repo, ctx.windowId) };
    },
    'app.repo.forgetRecent': async ({ index }, ctx) => {
      deps.prefs.forgetRecent(index);
      return view(ctx);
    },
    'app.preflight': async (_in, ctx) => {
      const repo = need(ctx);
      const dir = deps.prefs.get().items_dir[repo] ?? deps.defaultItemsDir;
      return deps.engine.preflight(repo, dir);
    },
    'runs.list': async ({ show }, ctx) => deps.engine.loadRuns(need(ctx), show),
    'runs.detail': async ({ runId }, ctx) =>
      unreadable(() => deps.engine.loadDetail(need(ctx), runId)),
    'runs.context': async ({ runId }, ctx) =>
      unreadable(() => deps.engine.loadContext(need(ctx), runId)),
    'runs.log.subscribe': async ({ runId, offset }, ctx) => {
      deps.logs.subscribe(ctx.windowId, need(ctx), runId, offset);
      return { ok: true };
    },
    'runs.log.unsubscribe': async ({ runId }, ctx) => {
      deps.logs.unsubscribe(ctx.windowId, runId);
      return { ok: true };
    },
    'usage.get': async (_in, ctx) => deps.engine.loadUsage(need(ctx)),
    'items.list': (_in, ctx) => person(() => deps.engine.loadItems(need(ctx), itemsDirOf(ctx))),
    'items.read': ({ rel }, ctx) =>
      person(() => deps.engine.readDraft(need(ctx), itemsDirOf(ctx), rel)),
    'items.check': (draft, ctx) => person(() => deps.engine.checkDraft(need(ctx), draft)),
    'items.create': async (draft, ctx) => ({
      rel: await person(() => deps.engine.createItem(need(ctx), itemsDirOf(ctx), draft)),
    }),
    'items.save': async (draft, ctx) => ({
      changed: await person(() => deps.engine.saveItem(need(ctx), itemsDirOf(ctx), draft)),
    }),
    'items.rename': async ({ rel, new_rel }, ctx) => ({
      rel: await person(() => deps.engine.renameItem(itemsDirOf(ctx), rel, new_rel)),
    }),
    'items.deleteInfo': ({ rel }, ctx) =>
      person(() => deps.engine.itemDeleteInfo(need(ctx), itemsDirOf(ctx), rel)),
    // `confirm: true` is in the input schema: only the confirmation page's button sends it.
    'items.delete': async ({ rel }, ctx) => {
      await person(() => deps.engine.deleteItem(itemsDirOf(ctx), rel));
      return { deleted: rel };
    },
    'newrun.plan': (form, ctx) =>
      person(() => deps.engine.planRun(need(ctx), itemsDirOf(ctx), form)),
    'newrun.start': async ({ shown, budget_shown, ...form }, ctx) => {
      const repo = need(ctx);
      // A working copy needs git and a first commit; say so before anything is made.
      const checks = await deps.engine.preflight(repo, deps.defaultItemsDir);
      if (!checks.git.ok) throw new UserError(checks.git.text);
      if (!checks.repo.ok) throw new UserError(checks.repo.text);
      return person(() =>
        deps.engine.startNewRun(repo, itemsDirOf(ctx), form, shown, budget_shown),
      );
    },
  };
}

function senderAllowed(sender: SenderInfo, devOrigin: string | null): boolean {
  if (!sender.isOurWindow) return false;
  return (
    sender.frameUrl.startsWith(`${APP_ORIGIN}/`) ||
    (devOrigin !== null && sender.frameUrl.startsWith(devOrigin))
  );
}

/**
 * The one entry point for every invoke channel: check the sender, parse the input, run the handler,
 * parse the output. Errors are values, never thrown across IPC (docs/04 §5.1, docs/08 §3).
 */
export async function dispatch(
  handlers: Handlers,
  channel: string,
  raw: unknown,
  sender: SenderInfo,
  devOrigin: string | null = null,
  onError: (message: string, err: unknown) => void = () => undefined,
): Promise<Result<unknown>> {
  if (!senderAllowed(sender, devOrigin)) return { ok: false, error: 'Request refused.' };
  if (!Object.hasOwn(IPC_TABLE, channel)) return { ok: false, error: 'Unknown request.' };
  const name = channel as IpcChannel;
  const spec = IPC_TABLE[name];
  const input = spec.input.safeParse(raw === undefined ? {} : raw);
  if (!input.success) return { ok: false, error: 'Invalid request.' };
  try {
    const handler = handlers[name] as (i: unknown, ctx: Ctx) => Promise<unknown>;
    const ctx: Ctx = { repo: sender.repo ?? null, windowId: sender.windowId ?? 0 };
    const output = spec.output.parse(await handler(input.data, ctx));
    return { ok: true, value: output };
  } catch (err) {
    if (err instanceof UserError) return { ok: false, error: err.message };
    onError(`ipc ${channel} failed`, err);
    return {
      ok: false,
      error: 'Something went wrong. The details are in the log (Help → Open log folder).',
    };
  }
}
