// Dumps Ruby competence + episode stats as one JSON object on stdout.
// Read-only over the episode store — used by the 50-day trial dashboard
// to capture daily competence-by-category and verification catch rate.
//
// Usage: npx ts-node scripts/dump-ruby-stats.ts [projectRoot]

import { loadEpisodes, getEpisodeStats } from '../src/ruby/index.js';
import { getCompetenceReport } from '../src/ruby/competence.js';

async function main(): Promise<void> {
  const projectRoot = process.argv[2] ?? process.cwd();

  const episodes = await loadEpisodes(projectRoot);
  const competence = getCompetenceReport(episodes);
  const episodeStats = await getEpisodeStats(projectRoot);

  const rubyAttempts = episodeStats.rubySuccesses + episodeStats.rubyFailures;
  const verificationCatchRate = rubyAttempts === 0
    ? 0
    : episodeStats.rubyFailures / rubyAttempts;

  const out = {
    timestamp: new Date().toISOString(),
    projectRoot,
    competence,
    episodeStats,
    verificationCatchRate,
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
