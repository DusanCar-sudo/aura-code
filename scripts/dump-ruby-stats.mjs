// scripts/dump-ruby-stats.mjs
// Plain JS, imports from the already-compiled dist output — avoids
// ts-node's ESM/CJS extension-resolution headaches entirely.
// Run with: node scripts/dump-ruby-stats.mjs [--root /path/to/project]
// --root selects which project's episodes to read (episodes live under
// ~/.aura/episodes/{hash-of-project-root}/); defaults to cwd.
// Requires a fresh `npm run build` first.

import { loadEpisodes, getEpisodeStats } from '../dist/archimedes/index.js';
import { getCompetenceReport } from '../dist/archimedes/competence.js';

function parseRoot(argv) {
  const i = argv.indexOf('--root');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.cwd();
}

const projectRoot = parseRoot(process.argv.slice(2));

async function main() {
  const episodes = await loadEpisodes(projectRoot);
  const episodeStats = await getEpisodeStats(projectRoot);
  const competence = getCompetenceReport(episodes);

  const verificationCatchRate =
    (episodeStats.archimedesSuccesses + episodeStats.archimedesFailures) > 0
      ? episodeStats.archimedesFailures / (episodeStats.archimedesSuccesses + episodeStats.archimedesFailures)
      : null;

  const output = {
    timestamp: new Date().toISOString(),
    projectRoot,
    episodeStats: {
      total: episodeStats.total,
      archimedesSuccesses: episodeStats.archimedesSuccesses,
      archimedesFailures: episodeStats.archimedesFailures,
      largeModelInterventions: episodeStats.largeModelInterventions,
      readyForFineTune: episodeStats.readyForFineTune,
    },
    competence,
    verificationCatchRate,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error('Error dumping ruby stats:', err);
  process.exit(1);
});
