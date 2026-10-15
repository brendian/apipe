import { describe, expect, it } from 'vitest';
import { unpackedPath } from '../src/core/asar.js';

describe('unpackedPath', () => {
  it('points a path inside app.asar at app.asar.unpacked, and leaves every other path alone', () => {
    expect(unpackedPath('/opt/advpipe/resources/app.asar/out/main/worker.js')).toBe(
      '/opt/advpipe/resources/app.asar.unpacked/out/main/worker.js',
    );
    expect(unpackedPath('C:\\Program Files\\advpipe\\resources\\app.asar\\node_modules\\x')).toBe(
      'C:\\Program Files\\advpipe\\resources\\app.asar.unpacked\\node_modules\\x',
    );
    expect(unpackedPath('/home/me/app.asar.unpacked/x')).toBe('/home/me/app.asar.unpacked/x');
    expect(unpackedPath('/repo/packages/app/out/main/worker.js')).toBe(
      '/repo/packages/app/out/main/worker.js',
    );
  });
});
