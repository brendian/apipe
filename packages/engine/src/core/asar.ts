// A packaged app keeps its code in `app.asar`; executables and the worker script have to be read
// from the `app.asar.unpacked` folder beside it (electron-builder `asarUnpack`, docs/06 §8).
const ASAR = /([\\/])app\.asar(?=[\\/]|$)/;

/** `p` with an `app.asar` folder in it turned into `app.asar.unpacked`; any other path as it is. */
export function unpackedPath(p: string): string {
  return p.replace(ASAR, '$1app.asar.unpacked');
}
