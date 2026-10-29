// Facts the judge asks for when a call's recoverability turns on the state
// of files or git refs: a fixed set of read-only queries. The judge's
// strings reach git only as absolute paths or as checked ref names, so it
// chooses what to look at, never what runs.

import type { Run } from './git.ts';
import { iso, pathFacts } from './paths.ts';
import { refFacts } from './refs.ts';

export type FactRequest = { path: string } | { repo: string; ref: string };

export type Host = {
  run: Run;
  exists: (path: string) => Promise<boolean>;
  stat: (path: string) => Promise<{ kind: string; mtimeMs: number; isLink: boolean }>;
  list: (path: string) => Promise<Array<{ name: string; kind: string; mtimeMs: number }>>;
  // The directory relative paths resolve from, and `~`.
  cwd: string;
  home: string | undefined;
  // When the session began: a file changed before then predates the task.
  startedAt: number;
};

export const MAX_REQUESTS = 4;

// Rejects when any query cannot run, so the judge never decides on half the
// facts it asked for.
export async function gatherFacts(host: Host, requests: readonly FactRequest[]) {
  return {
    sessionStartedAt: iso(host.startedAt),
    answers: await Promise.all(
      requests.map((request) =>
        'path' in request
          ? pathFacts(host, request.path)
          : refFacts(host, request.repo, request.ref),
      ),
    ),
  };
}
