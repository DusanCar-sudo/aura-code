Fix scripts/dump-ruby-stats.mjs to read archimedesAttempted/archimedesSucceeded field names instead of the old rubyAttempted/rubySucceeded names.

Steps:
1. Find the file: find /mnt/bigdata/aura/aura-code/scripts -name "*.mjs"
2. Read it in full
3. Replace all occurrences of:
   - rubyAttempted → archimedesAttempted
   - rubySucceeded → archimedesSucceeded
   - rubySuccesses → archimedesSuccesses (if present)
   - rubyFailures → archimedesFailures (if present)
   - getEpisodeStats — check if this function still exists in dist/archimedes/ or was renamed; use the correct import path
4. Also update the episode directory glob — episodes are currently stored under ~/.aura/episodes/L3J1bi9t/ (hash of /run/media/dusan/DATA1/Aura_Benchmark), not the aura-code hash. The script should accept an optional --root argument to specify which project's episodes to read, defaulting to process.cwd()
5. Test: node scripts/dump-ruby-stats.mjs --root /run/media/dusan/DATA1/Aura_Benchmark
   Should output non-zero totals (57 episodes, 8 successes, 8 failures)
6. tsc --noEmit, npm run build
7. Commit: "fix dump-ruby-stats: read archimedes field names, add --root flag"
Do not commit until the test shows real non-zero numbers.
