import type { LogPush } from '@advpipe/contracts';

// The live log's host side (docs/04 §5.2, §6): a window subscribes to a run's events.jsonl from a
// byte offset, and every time the watcher says that run changed, whatever is new is pushed as
// `run.log`. The window keeps nothing but the offset it was last sent, so a reconnect resumes
// exactly where it left off.

export type Tail = Pick<LogPush, 'lines' | 'next_offset' | 'ended'>;

export type LogSubsDeps = {
  /** `tailEvents` for one run of `repo`. */
  tail(repo: string, runId: string, offset: number): Tail;
  /** Send a `run.log` push to a window. */
  send(windowId: number, push: LogPush): void;
};

type Sub = { repo: string; runId: string; offset: number; ended: boolean };

export class LogSubscriptions {
  private readonly subs = new Map<string, Sub>(); // `${windowId}:${runId}`

  constructor(private readonly deps: LogSubsDeps) {}

  /** Start (or restart from `offset`) a window's subscription, and send what is already there. */
  subscribe(windowId: number, repo: string, runId: string, offset: number): void {
    const sub: Sub = { repo, runId, offset, ended: false };
    this.subs.set(`${windowId}:${runId}`, sub);
    this.drain(windowId, sub, true);
  }

  unsubscribe(windowId: number, runId: string): void {
    this.subs.delete(`${windowId}:${runId}`);
  }

  /** A window closed: forget all of its subscriptions. */
  drop(windowId: number): void {
    for (const key of this.subs.keys()) if (key.startsWith(`${windowId}:`)) this.subs.delete(key);
  }

  /** `runId`'s files changed (in `windowId`'s repo): push what is new to its subscriber, if any. */
  poke(windowId: number, runId: string): void {
    const sub = this.subs.get(`${windowId}:${runId}`);
    if (sub) this.drain(windowId, sub, false);
  }

  private drain(windowId: number, sub: Sub, first: boolean): void {
    for (;;) {
      let tail: Tail;
      try {
        tail = this.deps.tail(sub.repo, sub.runId, sub.offset);
      } catch {
        return; // the run vanished (cleaned up): nothing to push
      }
      const progressed = tail.next_offset > sub.offset;
      if (progressed || first || tail.ended !== sub.ended) {
        this.deps.send(windowId, {
          runId: sub.runId,
          lines: tail.lines,
          next_offset: tail.next_offset,
          ended: tail.ended,
        });
      }
      sub.offset = Math.max(sub.offset, tail.next_offset);
      sub.ended = tail.ended;
      first = false;
      if (!progressed) return; // caught up (a long log is sent in chunks)
    }
  }
}
