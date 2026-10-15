import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@advpipe/engine';
import { Prefs, type FilterKey, type PrefsView } from '@advpipe/contracts';

// `<userData>/preferences.json` (docs/03 §11): theme, recent repos, window bounds, per-repo
// choices. A missing or damaged file is the defaults; saving never throws into the caller.

export const MAX_RECENT = 10;

export class PrefsStore {
  private data: Prefs;

  constructor(private readonly file: string) {
    this.data = PrefsStore.load(file);
  }

  private static load(file: string): Prefs {
    try {
      return Prefs.parse(JSON.parse(readFileSync(file, 'utf-8')));
    } catch {
      return Prefs.parse({});
    }
  }

  get(): Prefs {
    return this.data;
  }

  update(change: (prefs: Prefs) => void): Prefs {
    const next = structuredClone(this.data);
    change(next);
    this.data = Prefs.parse(next);
    try {
      writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      // a preference that can't be saved is not worth an error dialog
    }
    return this.data;
  }

  /** `repo` becomes the most recent repo (once, at the front, at most ten). */
  addRecent(repo: string): void {
    this.update((p) => {
      p.recent_repos = [repo, ...p.recent_repos.filter((r) => r !== repo)].slice(0, MAX_RECENT);
    });
  }

  forgetRecent(index: number): void {
    this.update((p) => {
      p.recent_repos = p.recent_repos.filter((_, i) => i !== index);
    });
  }
}

/** What a window may see of the preferences for `repo` (null: a window with no repo). */
export function prefsView(
  prefs: Prefs,
  repo: string | null,
  exists: (dir: string) => boolean = existsSync,
): PrefsView {
  return {
    theme: prefs.theme,
    notifications: prefs.notifications,
    run_filter: (repo !== null ? prefs.run_filter[repo] : undefined) ?? ('all' satisfies FilterKey),
    recent: prefs.recent_repos.map((p, index) => ({
      index,
      name: path.basename(p) || p,
      path: p,
      exists: exists(p),
    })),
  };
}
