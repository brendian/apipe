# 08 · Security and safety

advpipe can spend money and make an AI run shell commands on the user's machine. The Python version
protected a localhost web server with a token, CSRF tokens, a Host check and a CSP. A desktop app has
no server, so most of that disappears, **but the equivalent discipline is not optional**: the threat
moves to the Electron IPC boundary, untrusted agent text in the renderer, and file paths that arrive
from the UI. Port of `docs/reference/python-original/docs/UI_PLAN.md` §5 and `ui/security.py`, plus the
README's *Safety* section.

## 1. Threat model

| Asset | Threat | Defence |
|---|---|---|
| The user's machine and money | A compromised or buggy renderer starts runs, runs commands, reads files | Renderer has no Node, no fs, no shell; only an allow-listed, zod-validated IPC surface; every start is confirmed against what was *shown* |
| The user's files outside the repo | A path from the UI escapes the work-items folder or `.advpipe/` | One path gate per kind (§5); resolve, then `path.relative` check; reject symlinks that lead out |
| Run data integrity | A UI action corrupts or deletes someone else's run, or a branch that isn't ours | Run-id validation; `clean` only touches `.advpipe/worktrees/` and `advpipe/*` branches; host re-checks validity of every action |
| Confidentiality of the code | Code or agent output leaks over the network from the app | The app makes **no** network requests of its own. Only the Claude Code child talks to Anthropic; the only URLs the UI ever opens are two constants (§3) |
| The user's screen | Agent output is rendered as HTML/script | Agent/file text is never HTML; markdown is sanitised (§4) |
| Git history | The app pushes, merges or opens PRs | It never does; no code path calls `git push|merge|pull|fetch|remote`. A lint test greps for these verbs |

Out of scope (state this plainly in the Help page): **agents run shell commands with the user's
permissions, with no sandbox** (the test author, coder and solo roles have `Bash`). advpipe is for
code you trust, on a machine where that is acceptable. Your code is sent to the Claude API as part of
the agents' work.

## 2. Electron hardening (all mandatory)

```ts
new BrowserWindow({ webPreferences: {
  contextIsolation: true,  nodeIntegration: false,  nodeIntegrationInWorker: false,
  sandbox: true,           webSecurity: true,       allowRunningInsecureContent: false,
  preload: <abs path to the built preload>,  spellcheck: false } });
```

- **Content-Security-Policy** on the renderer document (a `<meta>` plus a response header for the
  `app://` protocol): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none';
  form-action 'none'`. **No `unsafe-inline`, no `unsafe-eval`.** Styles are files (CSS custom
  properties and classes; the markdown renderer turns table alignment into classes, never `style=`).
  Vite/React in production emits no inline script; verify in the e2e suite by checking the page for
  CSP violations.
- Load the renderer from a **custom protocol** (`app://`) in production (`protocol.handle`), or `file://`
  restricted by `will-navigate`; **deny all navigation** (`will-navigate` → `preventDefault`), deny
  `window.open` (`setWindowOpenHandler(() => ({action:'deny'}))`), deny all permission requests
  (`session.setPermissionRequestHandler((_,__,cb)=>cb(false))`), disable remote content.
- **`shell.openExternal`** is called **only** from `run.openLink` with a *key* (`'add_usage'` |
  `'add_credits'`) that main maps to the two constant URLs in `usage.ts`; the renderer can never supply
  a URL. `shell.showItemInFolder` only with a path **main** derived from run state and verified to lie
  under `<repo>/.advpipe/` (or the repo itself for the report/work item).
- **`ipcMain.handle` only**; no `ipcMain.on` with callbacks that take renderer-supplied channels. Every
  handler checks `event.senderFrame.url` is the app's own origin and that the sender is a window we
  created (`BrowserWindow.fromWebContents`).
- Disable `devtools` in production builds unless a "Developer" preference is on.
- Keep Electron on the current stable major; fail CI on `npm audit --omit=dev` high/critical.
- `app.setAsDefaultProtocolClient` is **not** used. No deep links, no auto-update in v1.

## 3. The IPC rules ([04-ARCHITECTURE](04-ARCHITECTURE.md) §5)

1. **Allow-list, not pass-through.** The preload exposes named methods generated from one table; never
   `ipcRenderer`, never a generic `invoke(channel)`/`send`.
2. **Everything is parsed.** Each handler `schema.parse`s its input (reject → `{ok:false}`), and parses
   its own output (so a bug can't leak a field the UI shouldn't see).
3. **The renderer never supplies a repo path.** The repo is the window's repo. The folder picker runs in
   main.
4. **Ids are validated, then trusted only as ids.** Run ids pass `checkRunId` before any path is built;
   question ids `Q\d+` and must be in the run's pending set; decision choices must be in
   `CHOICES[kind]` for the run's *open* decision; notes and answers have length caps (8 000 each,
   24 000 total).
5. **Destructive actions need `confirm: true`** that only the confirmation page's control sends; the
   host refuses without it. (`takeover`, `stop`, `finish`, `clean`, item `delete`.)
6. **Start is double-checked.** `newrun.start` recomputes the plan and refuses if `shown`/`budget_shown`
   don't match (05 §5.4). The level, scan, policy and bypass come from the *validated plan*, never raw
   from the form.
7. **Nothing from the renderer reaches a shell.** Processes are spawned with `execFile`/`spawn` and
   **argument arrays**, never `shell: true`; the worker gets only `--start <path>`; branch names come from
   `slugify`; commits use fixed messages.
8. **Errors are values and are rendered as text.**

## 4. Untrusted text in the renderer

Everything an agent wrote, a work item contains, a file holds or git printed is **untrusted input** (an
agent can be prompt-injected by the repo it reads).

- Plain text (replies, evidence, notes, answers, questions, log lines, console tail, diffs): React text
  nodes only. **Never `dangerouslySetInnerHTML` except in the one `<Markdown>` component.**
- `<Markdown>`: `markdown-it` with `html: false` (raw HTML is escaped, not passed), `linkify` off, a
  link-scheme allow-list (`http`, `https`, `mailto`; others are dropped to plain text), then **DOMPurify**
  with a strict profile (no `style`, no event handlers, no `target` without `rel="noopener noreferrer"`)
  as a second layer. Links are **inert** in the renderer (click → ignored; offer *Copy link*), since there
  is no browser; the only openable links are the constants in §2.
- The `task.md` renderer adds classes through a markdown-it **core rule** (a token transform), never by
  building HTML strings.
- Table alignment becomes CSS classes (`align-left|center|right`), not inline styles (the CSP forbids them).
- Commands shown for copying are text in a `<code>`; **the app never executes them**.
- Test: a battery of hostile strings (`<script>`, `<img onerror>`, `javascript:` links, markdown that
  tries `<iframe>`, enormous lines, NUL, RTL overrides) passes through **every** surface that shows agent
  text, and the DOM contains no element or attribute created from them (port the original's
  "agent text containing HTML is escaped on every page" tests).

## 5. Paths and identifiers (one gate each; test every traversal form)

| Kind | Gate | Rules |
|---|---|---|
| Run id | `checkRunId` | `^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$`, no `..`. Applied to every id from the UI, from `readdir`, and from `run.json` before it becomes a path |
| Work-item path | `itemPath(itemsDir, rel)` | `itemsDir` already resolved. Non-empty, ≤ 300 chars, no backslash, not absolute; each `/`-part matches `^[A-Za-z0-9_][A-Za-z0-9_.+ -]*$` and doesn't end in space or `.`; ≤ **4** folders deep; last part ends `.md` and isn't just `.md`; and `path.resolve(joined)` is inside `itemsDir` (symlinks resolved). Messages are shown to the user as is |
| Items directory | preference | Must resolve **inside the repo**; never outside |
| Config path | `planRun` | Relative to the repo, must resolve inside the repo and be an existing file |
| Standards doc | `loadContext` | Revision matches `^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$` (**no leading `-`**) and the path is relative without `..`, passed to `git cat-file blob <rev>:<path>` as arguments |
| Worktree to remove/reveal | `cleanRun`/`run.reveal` | Must be under `<repo>/.advpipe/worktrees/` (checked with `path.relative`), whatever `run.json` says; branches deleted only if they start with `advpipe/` |
| Reveal paths | `run.reveal` | Derived by main from run state; must be under `<repo>/.advpipe/` |

Never build a path by string concatenation with an externally supplied part; never use a *prefix* string
comparison for "inside" (use `path.relative` and reject results starting with `..` or absolute).
Test: `../`, absolute, `%2e%2e`, backslashes, NUL, very long, leading-dot, symlink-out, Windows drive
letters, UNC paths, trailing dots/spaces.

## 6. Running processes

- **Gates** run the configured command (an argv array from `pipeline.toml`: **user-trusted
  configuration**, same trust as the repo) with `execFile`, `cwd` = the worktree, `timeout`, no shell. If a
  user wants shell features they configure `["sh","-c","…"]` themselves.
- **Agents** run through the SDK with `permissionMode: 'dontAsk'` and a fixed per-role tool list
  (read-only roles genuinely cannot edit). The Bash tool in writer roles is **unsandboxed** — documented.
- **Environment scrubbing**: the worker's children (gates, SDK) get `process.env` minus
  `ELECTRON_RUN_AS_NODE` and other Electron-internal variables. Never log environment variables.
- **No secrets handled.** advpipe never asks for, reads or stores an API key or token and has no login
  flow of its own; it uses whatever login the bundled Claude Code uses. Don't read Claude's credential
  files. Don't call undocumented endpoints.
- The worker validates `start.json` with zod and refuses to start otherwise.

## 7. Data the app writes

- Inside a repo: only `.advpipe/` (and work items via the editor, and nothing else). `.advpipe/` is added
  to `.git/info/exclude`.
- Per user: `preferences.json` and logs under `userData`. Logs never contain agent output or file
  contents.
- Nothing is uploaded. No telemetry. No crash reporter that uploads.

## 8. Checklist per milestone

Every milestone that adds an IPC channel, a path, a process, or a renderer surface ends with:

- [ ] input schema + output schema for each new channel; unknown channel/field rejected
- [ ] a test for each hostile input class that channel can receive (bad id, traversal, over-length,
      wrong status, wrong choice kind, missing `confirm`)
- [ ] no new `dangerouslySetInnerHTML`; hostile-string test extended to any new text surface
- [ ] no `shell: true`, no string-built command, no `eval`/`new Function` (ESLint rules on)
- [ ] CSP still has no `unsafe-*`; the e2e CSP-violation check is green
- [ ] `npm run lint` import-boundary rules green
- [ ] the Help page's safety text is still true
