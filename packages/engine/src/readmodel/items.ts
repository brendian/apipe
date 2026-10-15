import { createHash } from 'node:crypto';
import {
  type Dirent,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  BRANCH_PREFIX,
  formatWorkItem,
  KEY_NAMES,
  MAX_ITEM_BYTES,
  MAX_ITEM_DEPTH,
  parseLevel,
  parseWorkItem,
  RUN_KEYS,
  salvageWorkItem,
  SCAN_FAILURES,
  slugify,
  switchValue,
  titleOf,
  WorkItemError,
  type DeleteInfo,
  type DraftChecks,
  type DraftInput,
  type DraftView,
  type GitStateKey,
  type ItemList,
  type ItemRow,
  type WorkItem,
} from '@advpipe/contracts';
import { ConfigError, loadConfig } from '../core/config.js';
import { git } from '../core/git.js';
import { branchExists, excludeFromGit } from '../core/workspace.js';
import { markdown } from './render.js';
import { loadRuns } from './runs.js';

// Work items for the window: the `.md` files in the work-items folder, read, checked and changed on
// disk. Files are the source of truth; nothing here commits to git. Port of `ui/items.py`.
//
// Every path comes from the window, so `itemPath` is the only way in: a relative path of plain
// names ending in `.md` that stays inside the folder once symlinks are resolved (docs/08 §5).

const SUFFIX = '.md';
// One path part: no leading dot (no "..", no hidden files), no separators or odd characters.
const PART = /^[A-Za-z0-9_][A-Za-z0-9_.+ -]*$/;
export const FIX_FIRST = 'Not saved: fix the problems marked below first.';

/** The request can't be done; the message is for a person and is shown as is. */
export class ItemError extends Error {
  override name = 'ItemError';
}
/** The path isn't an allowed work-item path. */
export class ItemPathError extends ItemError {
  override name = 'ItemPathError';
}
/** The file changed on disk since the editor loaded it. */
export class ItemConflict extends ItemError {
  override name = 'ItemConflict';
}

// ── paths ───────────────────────────────────────────────────────────────────────────────────────

/** `p` with symlinks resolved as far as it exists (the rest, which may not exist yet, appended). */
export function realish(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** `child` is `parent` or inside it (both as given: resolve symlinks first where it matters). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The work-items folder for `repo`, from the person's setting (relative to the repo): an absolute,
 * symlink-resolved path that is inside the repo and is not the repo itself or a hidden folder.
 */
export function resolveItemsDir(repo: string, rel: string): string {
  const bad = new ItemPathError(
    'The work-items folder must be a folder inside this repo, like work-items.',
  );
  if (
    !rel.trim() ||
    rel.includes('\0') ||
    rel.includes('\\') ||
    path.isAbsolute(rel) ||
    rel.split('/').some((part) => part === '' || part.startsWith('.'))
  ) {
    throw bad;
  }
  const root = realish(repo);
  const dir = realish(path.resolve(root, rel));
  if (dir === root || !isInside(root, dir)) throw bad;
  return dir;
}

/** `itemsDir` as the person would write it: relative to the repo. */
export function itemsDirLabel(repo: string, itemsDir: string): string {
  const rel = path.relative(realish(repo), itemsDir);
  return rel.split(path.sep).join('/');
}

/**
 * `itemsDir/rel` if `rel` names a `.md` file that stays in `itemsDir`. `itemsDir` must be resolved
 * (`resolveItemsDir`). Rejects empty, absolute and backslash paths, `..` and hidden parts, odd
 * characters, deep nesting, other suffixes, and symlinks that lead out.
 */
export function itemPath(itemsDir: string, rel: string): string {
  if (!rel || rel.includes('\\') || rel.startsWith('/') || rel.length > 300) {
    throw new ItemPathError('use a path inside the work-items folder, like server/my-task.md');
  }
  const parts = rel.split('/');
  for (const part of parts) {
    if (!PART.test(part) || part.endsWith(' ') || part.endsWith('.')) {
      throw new ItemPathError(
        `'${part}' isn't allowed in a path: use letters, digits, '-', '_', '.' and ` +
          "spaces, not starting with '.'",
      );
    }
  }
  if (parts.length > MAX_ITEM_DEPTH + 1) {
    throw new ItemPathError(`folders can be at most ${MAX_ITEM_DEPTH} deep`);
  }
  const last = parts[parts.length - 1] ?? '';
  if (!last.endsWith(SUFFIX) || last === SUFFIX) {
    throw new ItemPathError('work items are markdown files: the name must end in .md');
  }
  const file = path.join(itemsDir, ...parts);
  if (!isInside(itemsDir, realish(file))) {
    throw new ItemPathError('that path leads outside the work-items folder (a symlink?)');
  }
  return file;
}

/** A name typed into a form, with `.md` added if it was left off. */
export function withSuffix(rel: string): string {
  const text = rel.trim();
  return text.endsWith(SUFFIX) ? text : text + SUFFIX;
}

const relOf = (itemsDir: string, file: string): string =>
  path.relative(itemsDir, file).split(path.sep).join('/');

/** Identifies a version of a file, so a save can tell if it changed underneath. */
export const digest = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

export const isFileAt = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

const missing = (rel: string): ItemError => new ItemError(`There's no work item ${rel} any more.`);

function decode(data: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

// ── git status ──────────────────────────────────────────────────────────────────────────────────

/**
 * The git state per changed path under `itemsDir` (a folder's path covers the files in it). Clean
 * files aren't listed. Null if git can't tell (not a git repo, or the folder is outside it).
 */
export async function gitChanges(
  repo: string,
  itemsDir: string,
): Promise<Map<string, Exclude<GitStateKey, ''>> | null> {
  let out: string;
  let top: string;
  try {
    top = realish((await git(repo, 'rev-parse', '--show-toplevel')).trim());
    if (!isInside(top, itemsDir)) return null;
    out = await git(
      top,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
      '--',
      itemsDir,
    );
  } catch {
    return null;
  }
  const changes = new Map<string, Exclude<GitStateKey, ''>>();
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? '';
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const name = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i += 1; // the rename's source path follows
    const kind = code === '??' ? 'untracked' : code === '!!' ? 'ignored' : 'modified';
    changes.set(realish(path.join(top, name.replace(/\/+$/, ''))), kind);
  }
  return changes;
}

/** The git state of `file` ('' if it's committed and unchanged). */
export function gitState(
  changes: Map<string, Exclude<GitStateKey, ''>>,
  file: string,
): GitStateKey {
  let cur = realish(file);
  for (;;) {
    const found = changes.get(cur);
    if (found !== undefined) return found;
    const parent = path.dirname(cur);
    if (parent === cur) return '';
    cur = parent;
  }
}

// ── the list ────────────────────────────────────────────────────────────────────────────────────

type LastRun = NonNullable<ItemRow['last_run']>;

/** The newest run started from each work-item file. */
function lastRuns(repo: string): Map<string, LastRun> {
  const latest = new Map<string, LastRun>();
  for (const row of loadRuns(repo, 'all').rows) {
    // newest first
    if (!row.work_item_file) continue;
    const key = realish(row.work_item_file);
    if (!latest.has(key)) {
      latest.set(key, { run_id: row.run_id, status: row.status, started_at: row.started_at });
    }
  }
  return latest;
}

function rowOf(
  file: string,
  rel: string,
  runs: Map<string, LastRun>,
  changes: Map<string, Exclude<GitStateKey, ''>> | null,
): ItemRow {
  let title: string;
  let name: string | null = null;
  let config: string | null = null;
  let problem: string | null = null;
  let text = '';
  try {
    const decoded = decode(readFileSync(file));
    if (decoded === null) {
      title = '(not UTF-8 text)';
      problem = "the file isn't UTF-8 text";
    } else {
      text = decoded;
      const item = parseWorkItem(text, rel);
      title = titleOf(item.body);
      name = item.name ?? null;
      config = item.config ?? null;
    }
  } catch (e) {
    if (e instanceof WorkItemError) {
      const { fields, body } = salvageWorkItem(text);
      title = titleOf(body);
      problem = e.message;
      name = fields.name ?? null;
      config = fields.config ?? null;
    } else {
      title = "(can't read)";
      problem = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    rel,
    title,
    name,
    config,
    problem,
    last_run: runs.get(realish(file)) ?? null,
    git: changes ? gitState(changes, file) : '',
  };
}

/** Every `.md` file under `itemsDir`, found without following symlinked folders or hidden ones. */
function walk(dir: string, found: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return found;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) walk(file, found);
    } else if (entry.name.endsWith(SUFFIX) && !entry.name.startsWith('.')) {
      // A symlinked folder is neither a directory entry here nor a file: skip it.
      if (entry.isFile() || (entry.isSymbolicLink() && isFileAt(file))) found.push(file);
    }
  }
  return found;
}

export async function loadItems(repo: string, itemsDir: string): Promise<ItemList> {
  const label = itemsDirLabel(repo, itemsDir);
  let isDir = false;
  try {
    isDir = statSync(itemsDir).isDirectory();
  } catch {
    // no folder yet
  }
  if (!isDir) {
    return { items_dir: label, folder_exists: false, groups: [], skipped: [], git_known: true };
  }
  const runs = lastRuns(repo);
  const changes = await gitChanges(repo, itemsDir);
  const groups = new Map<string, ItemRow[]>();
  const skipped: string[] = [];
  for (const file of walk(itemsDir)) {
    const rel = relOf(itemsDir, file);
    try {
      itemPath(itemsDir, rel);
    } catch {
      skipped.push(rel);
      continue;
    }
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const rows = groups.get(folder) ?? [];
    rows.push(rowOf(file, rel, runs, changes));
    groups.set(folder, rows);
  }
  const ordered = [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map(([folder, items]) => ({ folder, items }));
  return {
    items_dir: label,
    folder_exists: true,
    groups: ordered,
    skipped,
    git_known: changes !== null,
  };
}

// ── the editor ──────────────────────────────────────────────────────────────────────────────────

/**
 * What the editor shows. A run setting (`RUN_KEYS`) is `''` when the file leaves it out (the run
 * inherits it from the config) and `undefined` when the form didn't carry it at all: saving then
 * keeps whatever the file has.
 */
type Draft = {
  rel: string;
  name: string;
  config: string;
  body: string;
  base: string;
  level: string | undefined;
  security_scan: string | undefined;
  scan_failures: string | undefined;
  bypass_questions: string | undefined;
};

/** A draft from form fields. Textareas send CRLF; the file gets LF. */
function fromForm(input: DraftInput): Draft {
  const setting = (value: string | undefined): string | undefined => value?.trim();
  return {
    rel: (input.rel ?? '').trim(),
    name: (input.name ?? '').trim(),
    config: (input.config ?? '').trim(),
    body: (input.body ?? '').replace(/\r\n|\r/g, '\n').trim(),
    base: input.base ?? '',
    level: setting(input.level),
    security_scan: setting(input.security_scan),
    scan_failures: setting(input.scan_failures),
    bypass_questions: setting(input.bypass_questions),
  };
}

function itemOf(draft: Draft): WorkItem {
  const item: WorkItem = { body: draft.body };
  if (draft.name) item.name = draft.name;
  if (draft.config) item.config = draft.config;
  for (const key of RUN_KEYS) {
    const value = draft[key];
    if (value) item[key] = value;
  }
  return item;
}

function readFileFor(itemsDir: string, rel: string): { file: string; data: Buffer } {
  const file = itemPath(itemsDir, rel);
  if (!isFileAt(file)) throw missing(rel);
  const data = readFileSync(file);
  if (data.length > MAX_ITEM_BYTES) {
    throw new ItemError(
      `${rel}: the file is over ${MAX_ITEM_BYTES / 1000} kB; edit it in a text editor`,
    );
  }
  return { file, data };
}

/** Load a file for the editor. A file that doesn't parse still opens, with what could be read. */
export function readDraft(repo: string, itemsDir: string, rel: string): DraftView {
  const { file, data } = readFileFor(itemsDir, rel);
  const text = decode(data);
  if (text === null) throw new ItemError(`${rel}: the file isn't UTF-8 text`);
  const last_run = lastRuns(repo).get(realish(file)) ?? null;
  const settings = (from: Partial<Record<(typeof RUN_KEYS)[number], string>>) => ({
    level: from.level ?? '',
    security_scan: from.security_scan ?? '',
    scan_failures: from.scan_failures ?? '',
    bypass_questions: from.bypass_questions ?? '',
  });
  try {
    const item = parseWorkItem(text, rel);
    return {
      rel,
      name: item.name ?? '',
      config: item.config ?? '',
      body: item.body,
      base: digest(data),
      problem: null,
      ...settings(item),
      last_run,
    };
  } catch (e) {
    if (!(e instanceof WorkItemError)) throw e;
    const { fields, body } = salvageWorkItem(text);
    return {
      rel,
      name: fields.name ?? '',
      config: fields.config ?? '',
      body,
      base: digest(data),
      problem: e.message,
      ...settings(fields),
      last_run,
    };
  }
}

type Check = DraftChecks['checks'][number];

const scanFailures = (value: string): void => {
  if (!(SCAN_FAILURES as readonly string[]).includes(value)) {
    throw new Error(`expected one of ${SCAN_FAILURES.join(', ')}, got '${value}'`);
  }
};

/** The run settings must be values a run accepts (it would reject the file otherwise). */
function settingChecks(draft: Draft): Check[] {
  const checks: Check[] = [];
  const rules: [(typeof RUN_KEYS)[number], string, (value: string) => unknown][] = [
    ['level', 'level', parseLevel],
    ['security_scan', 'security scan', switchValue],
    ['scan_failures', 'scan policy', scanFailures],
    ['bypass_questions', "don't-stop-for-questions setting", switchValue],
  ];
  for (const [key, label, valid] of rules) {
    const value = draft[key];
    if (!value) continue;
    try {
      valid(value);
    } catch (e) {
      checks.push({ level: 'error', text: `The ${label}: ${e instanceof Error ? e.message : e}.` });
    }
  }
  const bypass = draft.bypass_questions;
  if (bypass) {
    let yes = false;
    try {
      yes = switchValue(bypass);
    } catch {
      // already reported above
    }
    if (yes) {
      checks.push({
        level: 'warning',
        text:
          'Runs of this item never stop for blocking questions: the agent answers them ' +
          'itself. Rarely the right choice.',
      });
    }
  }
  return checks;
}

function configChecks(repo: string, config: string): Check[] {
  if (!config) {
    const has = isFileAt(path.join(repo, 'pipeline.toml'));
    const which = has ? 'pipeline.toml' : "advpipe's defaults";
    return [{ level: 'info', text: `No config set: runs use ${which}.` }];
  }
  const file = realish(path.resolve(repo, config));
  if (!isInside(realish(repo), file)) {
    return [{ level: 'warning', text: `Config ${config} is outside the repo; it wasn't checked.` }];
  }
  if (!isFileAt(file)) {
    return [
      { level: 'warning', text: `Config file ${config} doesn't exist: a run would refuse it.` },
    ];
  }
  try {
    loadConfig({ file });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    const first = e.message.trim().split('\n')[0] || 'ConfigError';
    return [{ level: 'warning', text: `Config file ${config} has errors: ${first}` }];
  }
  return [];
}

async function checkOf(repo: string, draft: Draft): Promise<DraftChecks> {
  const checks: Check[] = [];
  if (!draft.body) {
    checks.push({ level: 'error', text: 'The body is empty: a run would have nothing to build.' });
  }
  for (const [key, value] of [
    ['branch name', draft.name],
    ['config', draft.config],
  ] as const) {
    if (value.includes('\n') || value.includes('\r')) {
      checks.push({ level: 'error', text: `The ${key} must be a single line.` });
    }
  }
  checks.push(...settingChecks(draft));
  const branch = draft.name || draft.body ? BRANCH_PREFIX + slugify(draft.name || draft.body) : '';
  if (branch && (await branchExists(repo, branch))) {
    checks.push({
      level: 'warning',
      text:
        `Branch ${branch} already exists, so a run would make ${branch}-2 instead. ` +
        'Pick another branch name to tell them apart.',
    });
  }
  checks.push(...configChecks(repo, draft.config));
  return {
    checks,
    branch,
    ok: !checks.some((c) => c.level === 'error'),
    preview_html: draft.body ? markdown(draft.body) : null,
  };
}

/** The editor's inline checks: errors stop a save, warnings are things a run would trip over. */
export function checkDraft(repo: string, input: DraftInput): Promise<DraftChecks> {
  return checkOf(repo, fromForm(input));
}

// ── changes on disk ─────────────────────────────────────────────────────────────────────────────

function encode(item: WorkItem): Buffer {
  const data = Buffer.from(formatWorkItem(item), 'utf-8');
  if (data.length > MAX_ITEM_BYTES) {
    throw new WorkItemError(`the work item is over ${MAX_ITEM_BYTES / 1000} kB`);
  }
  return data;
}

/** Write a new file; never overwrites. Returns its path relative to the folder. */
export async function createItem(
  repo: string,
  itemsDir: string,
  input: DraftInput,
): Promise<string> {
  const draft = fromForm(input);
  if (!draft.rel) throw new ItemError('File name: give the work item a file name.');
  draft.rel = withSuffix(draft.rel);
  if (!(await checkOf(repo, draft)).ok) throw new ItemError(FIX_FIRST);
  let file: string;
  try {
    file = itemPath(itemsDir, draft.rel);
  } catch (e) {
    throw e instanceof ItemPathError ? new ItemPathError(`File name: ${e.message}`) : e;
  }
  const data = encode(itemOf(draft));
  mkdirSync(path.dirname(file), { recursive: true });
  // Work items are the owner's local task files: git-ignored (in .git/info/exclude, so no tracked
  // file changes), like .advpipe/. A folder that git can't place in this repo is left alone.
  await excludeFromGit(repo, `/${itemsDirLabel(repo, itemsDir)}/`).catch(() => undefined);
  try {
    writeFileSync(file, data, { flag: 'wx' }); // never overwrite
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ItemError(
        `${draft.rel} already exists. Pick another name, or edit that item instead.`,
      );
    }
    throw e;
  }
  return draft.rel;
}

/**
 * Write an edited file; false if nothing changed (the file is left byte for byte as it was, front
 * matter layout included). Refuses if the file changed since `base` was read.
 */
export async function saveItem(
  repo: string,
  itemsDir: string,
  input: DraftInput,
): Promise<boolean> {
  const draft = fromForm(input);
  const file = itemPath(itemsDir, draft.rel);
  if (!(await checkOf(repo, draft)).ok) throw new ItemError(FIX_FIRST);
  let current: Buffer;
  try {
    current = readFileSync(file);
  } catch {
    throw new ItemError(
      `${draft.rel} was deleted or moved since you opened it. Copy your text first.`,
    );
  }
  if (!draft.base || digest(current) !== draft.base) {
    throw new ItemConflict(
      `${draft.rel} was changed on disk since you opened it, so saving would overwrite ` +
        'those changes. Copy your text, reload the page, and merge by hand.',
    );
  }
  const item = itemOf(draft);
  const text = decode(current);
  if (text !== null) {
    try {
      const onDisk = parseWorkItem(text);
      // A form that didn't carry a run setting keeps the file's.
      for (const key of RUN_KEYS) {
        if (draft[key] === undefined && onDisk[key] !== undefined) item[key] = onDisk[key];
      }
      if (KEY_NAMES.every((k) => onDisk[k] === item[k]) && onDisk.body === item.body) return false;
    } catch (e) {
      if (!(e instanceof WorkItemError)) throw e;
    }
  }
  writeFileSync(file, encode(item));
  return true;
}

/** Move a file within the folder. Never overwrites. Returns its new relative path. */
export function renameItem(itemsDir: string, rel: string, newInput: string): string {
  const source = itemPath(itemsDir, rel);
  if (!isFileAt(source)) throw missing(rel);
  const newRel = withSuffix(newInput);
  if (newRel === rel) throw new ItemError("That's its name already.");
  let target: string;
  try {
    target = itemPath(itemsDir, newRel);
  } catch (e) {
    throw e instanceof ItemPathError ? new ItemPathError(`New name: ${e.message}`) : e;
  }
  try {
    lstatSync(target);
    throw new ItemError(`${newRel} already exists.`);
  } catch (e) {
    if (e instanceof ItemError) throw e;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(source, target);
  return newRel;
}

/** What the delete confirmation page says about git (docs/05 §5.7). */
export async function itemDeleteInfo(
  repo: string,
  itemsDir: string,
  rel: string,
): Promise<DeleteInfo> {
  const file = itemPath(itemsDir, rel);
  if (!isFileAt(file)) throw missing(rel);
  const changes = await gitChanges(repo, itemsDir);
  return {
    rel,
    git: changes === null ? 'unknown' : gitState(changes, file),
    items_dir: itemsDirLabel(repo, itemsDir),
  };
}

export function deleteItem(itemsDir: string, rel: string): void {
  const file = itemPath(itemsDir, rel);
  if (!isFileAt(file)) throw missing(rel);
  unlinkSync(file);
}
