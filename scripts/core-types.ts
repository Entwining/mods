// Writes the plugin API's core declarations, which the pinned engine embeds as
// a zstd frame, to `node_modules/.cache/claude-code-core`, so CI can check the
// mods against them: the engine writes its declarations only when an
// interactive session loads a mod.

import { Glob } from 'bun';

const OUT = new URL(
  '../node_modules/.cache/claude-code-core/claude-code/index.d.ts',
  import.meta.url,
);
const MARK = "declare module 'claude-code'";
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// Bun installs only the platform package that matches this machine.
const [binary] = await Array.fromAsync(
  new Glob('node_modules/@anthropic-ai/claude-code-*/claude{,.exe}').scan(),
);
if (binary === undefined) throw new Error('no Claude Code binary under node_modules');
const bytes = Buffer.from(await Bun.file(binary).arrayBuffer());

// Where the zstd frame that starts at `start` ends, read from its frame and
// block headers (RFC 8878), since the decompressor rejects trailing bytes.
function frameEnd(start: number): number | undefined {
  const descriptor = bytes[start + 4]!;
  if ((descriptor & 0b1000) !== 0) return undefined;
  const singleSegment = (descriptor >> 5) & 1;
  let at =
    start +
    5 +
    (singleSegment ? 0 : 1) +
    [0, 1, 2, 4][descriptor & 0b11]! +
    [singleSegment, 2, 4, 8][descriptor >> 6]!;
  while (at + 3 <= bytes.length) {
    const header = bytes.readUIntLE(at, 3);
    const type = (header >> 1) & 0b11;
    if (type === 3) return undefined;
    at += 3 + (type === 1 ? 1 : header >> 3);
    if ((header & 1) === 1) return at + ((descriptor >> 2) & 1 ? 4 : 0);
  }
  return undefined;
}

function declarations(): string {
  for (let start = bytes.indexOf(MAGIC); start !== -1; start = bytes.indexOf(MAGIC, start + 1)) {
    const end = frameEnd(start);
    if (end === undefined || end > bytes.length) continue;
    let text: string;
    try {
      text = Bun.zstdDecompressSync(bytes.subarray(start, end)).toString();
    } catch {
      continue;
    }
    if (text.includes(MARK)) return text;
  }
  throw new Error(`no zstd frame in ${binary} declares 'claude-code'`);
}

await Bun.write(OUT, declarations());
