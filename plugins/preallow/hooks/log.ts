import type { EngineInterface } from 'claude-code';

const LOGGED_INPUT_CHARS = 2000;

let logTail: Promise<void> = Promise.resolve();

// `$.fs` has no append and refuses files over 4 MiB, so a session's log
// rolls over to a numbered part once a part passes this size.
const LOG_PART_BYTES = 1_000_000;

// One JSON line per event, under ~/.claude/preallow, one file per
// session and part. Each line names the engine version, so a change in what
// the plugin decides can be matched to an engine update.
export function record($: EngineInterface, entry: Record<string, unknown>): void {
  logTail = logTail
    .then(async () => {
      // Without HOME the path would be relative, inside the user's project.
      const home = await $.env.get('HOME');
      if (home === undefined) return;
      const base = `${home}/.claude/preallow/${await $.session.id()}`;
      let part = 0;
      let path = `${base}.jsonl`;
      while ((await $.fs.exists(path)) && (await $.fs.stat(path)).size > LOG_PART_BYTES) {
        part += 1;
        path = `${base}.${part}.jsonl`;
      }
      const previous = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
      const { version } = await $.session.version();
      await $.fs.write(
        path,
        `${previous}${JSON.stringify({ at: new Date().toISOString(), engine: version, ...entry })}\n`,
      );
    })
    // A write that fails, as on a full disk, must not stop the lines after it.
    .catch(() => {});
}

export const loggedInput = (input: unknown) =>
  (JSON.stringify(input) ?? '').slice(0, LOGGED_INPUT_CHARS);
