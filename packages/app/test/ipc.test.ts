import { describe, expect, it, vi } from 'vitest';
import { createHandlers, dispatch, type SenderInfo } from '../src/main/ipc.js';

const ours: SenderInfo = { frameUrl: 'app://renderer/index.html', isOurWindow: true };

describe('IPC dispatch', () => {
  it('answers app.ping with a validated reply', async () => {
    const r = await dispatch(createHandlers(), 'app.ping', { message: 'x' }, ours);
    expect(r).toEqual({ ok: true, value: { reply: 'pong: x' } });
  });

  it('refuses bad input, unknown channels and foreign senders without calling the handler', async () => {
    const ping = vi.fn(async () => ({ reply: 'no' }));
    const handlers = { 'app.ping': ping };
    expect((await dispatch(handlers, 'app.ping', { message: 1 }, ours)).ok).toBe(false);
    expect((await dispatch(handlers, 'app.ping', { message: 'a', extra: 1 }, ours)).ok).toBe(false);
    expect((await dispatch(handlers, 'app.nope', {}, ours)).ok).toBe(false);
    expect((await dispatch(handlers, 'constructor', {}, ours)).ok).toBe(false);
    const foreign = { frameUrl: 'https://evil.example/', isOurWindow: true };
    expect((await dispatch(handlers, 'app.ping', { message: 'a' }, foreign)).ok).toBe(false);
    expect(
      (await dispatch(handlers, 'app.ping', { message: 'a' }, { ...ours, isOurWindow: false })).ok,
    ).toBe(false);
    expect(ping).not.toHaveBeenCalled();
  });
});
