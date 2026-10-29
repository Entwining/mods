// Fails when preallow's output scan finds a credential in one of the
// plugin's own files: reading the plugin's source, as an agent changing it
// does, would have the output redacted.

import { $ } from 'bun';

import { findSecrets } from '../plugins/preallow/hooks/withhold.ts';

const root = `${import.meta.dir}/../`;
const files = (await $`git ls-files -z plugins/preallow`.cwd(root).text())
  .split('\0')
  .filter(Boolean);

const found: string[] = [];
for (const file of files) {
  const kind = findSecrets(await Bun.file(`${root}${file}`).text())[0]?.kind;
  if (kind !== undefined) found.push(`${file}: ${kind}`);
}
if (found.length > 0) {
  console.error(`preallow's scan would redact these files:\n${found.join('\n')}`);
  process.exit(1);
}
