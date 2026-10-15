import { describe, expect, it } from 'vitest';
import { IPC_TABLE } from '../src/index.js';

describe('IPC table', () => {
  it('app.ping accepts a message and rejects extra fields', () => {
    const { input } = IPC_TABLE['app.ping'];
    expect(input.safeParse({ message: 'hi' }).success).toBe(true);
    expect(input.safeParse({ message: 'hi', extra: 1 }).success).toBe(false);
    expect(input.safeParse({ message: 3 }).success).toBe(false);
  });
});
