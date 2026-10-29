// Fails when preallow's withholding scan finds a credential in one of the
// plugin's own files: reading the plugin's source, as an agent changing it
// does, would have the output withheld.

import { $ } from 'bun';

import { findSecret } from '../plugins/preallow/hooks/withhold.ts';

const root = `${import.meta.dir}/../`;
const files = (await $`git ls-files -z plugins/preallow`.cwd(root).text())
  .split('\0')
  .filter(Boolean);

const found: string[] = [];
for (const file of files) {
  const kind = findSecret(await Bun.file(`${root}${file}`).text());
  if (kind !== undefined) found.push(`${file}: ${kind}`);
}
if (found.length > 0) {
  console.error(`preallow's scan would withhold these files:\n${found.join('\n')}`);
  process.exit(1);
}
