import { closeSync, openSync, readSync, statSync } from "node:fs";

export function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function readRange(path: string, start: number, end: number): Uint8Array {
  const len = Math.max(0, end - start);
  if (len === 0) return new Uint8Array();
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return new Uint8Array();
  }
  try {
    const buf = new Uint8Array(len);
    const n = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Bytes [start, end) of the log, keeping `head` from the start and `tail` from the end when it is longer. */
export function excerpt(
  path: string,
  start: number,
  end: number,
  head: number,
  tail: number,
): { text: string; omitted: number } {
  if (end - start <= head + tail) return { text: text(readRange(path, start, end)), omitted: 0 };
  const omitted = end - start - head - tail;
  const top = text(readRange(path, start, start + head));
  const bottom = text(readRange(path, end - tail, end));
  return {
    text: `${top}\n[... ${omitted} bytes omitted (bytes ${start + head}-${end - tail}); read them with process log ...]\n${bottom}`,
    omitted,
  };
}
