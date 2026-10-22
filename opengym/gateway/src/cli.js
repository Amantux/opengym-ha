// node /opt/gateway/src/cli.js <resolve|discovery>
//
// resolve    RESOLVED_<NAME>=<value> lines for the entrypoint (no secrets; every value is in
//            [A-Za-z0-9._:/@-]). Invalid options: every problem on stderr, exit 1.
// discovery  Supervisor discovery (contract §8). Always exits 0; says why when it skips.
import { runDiscovery } from './discovery.js';
import { formatResolved, resolveOptionsFile } from './options.js';

const cmd = process.argv[2];

if (cmd === 'resolve') {
  const { resolved, problems } = resolveOptionsFile(process.env.OPENGYM_OPTIONS_FILE || '/data/options.json');
  if (!resolved) {
    for (const p of problems) process.stderr.write(`openGym options: ${p}\n`);
    process.exit(1);
  }
  process.stdout.write(formatResolved(resolved));
} else if (cmd === 'discovery') {
  await runDiscovery();
  process.exit(0);
} else {
  process.stderr.write('usage: cli.js resolve | discovery\n');
  process.exit(2);
}
