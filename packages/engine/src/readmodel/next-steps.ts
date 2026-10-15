import type { NextStep, DisplayStatus, RunState } from '@advpipe/contracts';

// Commands for what to do next, ready to paste into the person's own terminal (docs/05 §5.2.7).
// Port of `ui/detail.next_steps` with every `advpipe …` command removed (the window has buttons
// for those; docs/02 §19): what is left is git and shell. Every value is quoted: run.json is a
// file on disk, not something to trust in a shell. The app never runs these.

export type Shell = 'posix' | 'powershell';

/** The shell the person most likely uses: PowerShell on Windows, else a POSIX shell. */
export const defaultShell = (): Shell => (process.platform === 'win32' ? 'powershell' : 'posix');

/**
 * `value` as one word in `shell`. POSIX: the single-quote rule of Python's `shlex.quote` (safe
 * words stay bare). PowerShell: a single-quoted string with `'` doubled (nothing is expanded in
 * one).
 */
export function quote(value: string, shell: Shell = defaultShell()): string {
  if (shell === 'powershell') return `'${value.replaceAll("'", "''")}'`;
  if (value === '') return "''";
  if (/^[\w@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function nextSteps(
  state: RunState,
  status: DisplayStatus,
  repo: string,
  shell: Shell = defaultShell(),
): NextStep[] {
  const q = (v: string): string => quote(v, shell);
  const git = `git -C ${q(repo)}`;
  const branch = state.branch ? q(state.branch) : '';
  const base = state.base_commit ? q(state.base_commit.slice(0, 12)) : '';
  const worktree = state.worktree && !state.worktree_removed ? state.worktree : '';
  const readChange: NextStep | null =
    branch && base
      ? {
          label: 'Read the change, one commit per stage',
          command: `${git} log -p --reverse ${base}..${branch}`,
        }
      : null;
  const steps: NextStep[] = [];

  if (status === 'complete') {
    if (readChange) {
      steps.push(readChange, {
        label: 'List the files it changed',
        command: `${git} diff --stat ${base}...${branch}`,
      });
    }
    if (branch) {
      steps.push(
        { label: 'Merge it, from the branch you want it on', command: `${git} merge ${branch}` },
        { label: 'Then delete the branch', command: `${git} branch -d ${branch}` },
      );
    }
    if (worktree) {
      steps.push({
        label: 'Remove the working copy it kept',
        command: `${git} worktree remove ${q(worktree)}`,
      });
    }
  } else if (status === 'finished') {
    if (worktree) {
      steps.push(
        {
          label: 'Look at the work, uncommitted, in its working copy',
          command: `cd ${q(worktree)}`,
        },
        { label: 'See what changed', command: `git -C ${q(worktree)} status` },
      );
    }
  } else if (status === 'needs_decision' || status === 'paused') {
    if (readChange) steps.push({ label: 'See what it did so far', command: readChange.command });
    if (worktree) {
      steps.push({ label: 'Look at the work in its working copy', command: `cd ${q(worktree)}` });
    }
  } else if (status === 'handed_over') {
    if (branch) {
      steps.push({
        label: 'Check the branch out and finish it by hand',
        command: `${git} switch ${branch}`,
      });
    }
    if (readChange) steps.push({ label: 'Read what it did', command: readChange.command });
  } else if (status === 'needs_human') {
    if (readChange) steps.push({ label: 'See what it did so far', command: readChange.command });
    if (worktree) {
      steps.push({ label: 'Finish it by hand in its working copy', command: `cd ${q(worktree)}` });
    }
  }
  // running, stopped, error, over budget, needs answers, ended: the buttons cover everything.
  return steps;
}
