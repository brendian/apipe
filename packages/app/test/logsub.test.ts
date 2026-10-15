import { describe, expect, it, vi } from 'vitest';
import { LogSubscriptions, type Tail } from '../src/main/logsub.js';

/** A fake events file: `tail` returns what is past `offset`, in chunks of at most `chunk` lines. */
function setup(chunk = 100) {
  const lines: string[] = [];
  let ended = false;
  const send = vi.fn();
  const tail = vi.fn((_repo: string, _run: string, offset: number): Tail => {
    const fresh = lines.slice(offset, offset + chunk);
    return {
      lines: fresh.map((message) => ({
        ts: '',
        kind: 'agent_done',
        stage: 'CODE',
        round: 1,
        message,
      })),
      next_offset: offset + fresh.length,
      ended: ended && offset + fresh.length >= lines.length,
    };
  });
  const subs = new LogSubscriptions({ tail, send });
  return { subs, send, tail, lines, end: () => (ended = true) };
}

describe('log subscriptions', () => {
  it('sends what is there on subscribing, then only what is new when the run changes', () => {
    const t = setup();
    t.lines.push('a', 'b');
    t.subs.subscribe(7, '/repo', 'r1', 0);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send.mock.calls[0]?.[1]).toMatchObject({ runId: 'r1', next_offset: 2, ended: false });
    t.subs.poke(7, 'r1'); // nothing new: nothing sent
    expect(t.send).toHaveBeenCalledTimes(1);
    t.lines.push('c');
    t.subs.poke(7, 'r1');
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(t.send.mock.calls[1]?.[1].lines.map((l: { message: string }) => l.message)).toEqual([
      'c',
    ]);
  });

  it('sends a long log in chunks, announces the end once, and resumes from a given offset', () => {
    const t = setup(2);
    t.lines.push('a', 'b', 'c', 'd', 'e');
    t.subs.subscribe(1, '/repo', 'r1', 2);
    expect(t.send.mock.calls.map((c) => c[1].next_offset)).toEqual([4, 5]);
    t.end();
    t.subs.poke(1, 'r1');
    t.subs.poke(1, 'r1');
    expect(t.send.mock.calls.filter((c) => c[1].ended)).toHaveLength(1);
  });

  it('keeps windows apart, stops on unsubscribe and when a window closes', () => {
    const t = setup();
    t.subs.subscribe(1, '/repo', 'r1', 0);
    t.subs.subscribe(2, '/repo', 'r1', 0);
    t.send.mockClear();
    t.lines.push('x');
    t.subs.poke(1, 'r1');
    expect(t.send.mock.calls.map((c) => c[0])).toEqual([1]);
    t.subs.unsubscribe(1, 'r1');
    t.subs.drop(2);
    t.subs.poke(1, 'r1');
    t.subs.poke(2, 'r1');
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it('a run that vanished is not an error', () => {
    const t = setup();
    t.tail.mockImplementation(() => {
      throw new Error('gone');
    });
    expect(() => t.subs.subscribe(1, '/repo', 'r1', 0)).not.toThrow();
    expect(t.send).not.toHaveBeenCalled();
  });
});
