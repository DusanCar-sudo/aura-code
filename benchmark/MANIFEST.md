# Benchmark Manifest

Every fixture in this benchmark, its question count, and the last commit that
touched it. The purpose is rot visibility: if a fixture drifts silently, the
last column makes the drift attributable.

## Status of tiering

There is **no tier structure** in this benchmark. The set is flat: seven
`task-00N-*` fixtures, all equivalent in weight. This is a verified fact, not
an omission:

- `git log --all -- benchmark/` shows only three commits ever touched this
  directory (`af116eb` harness + task-001, `e78f678` fixtures 002–007,
  `4094638` scratch-dir isolation). No tier directory or tier-named file has
  ever existed in history.
- No fixture README, task.json, or result file references tiers.

Nothing was renamed or renumbered to manufacture a tiered appearance. The
total question count below is exactly what exists.

## Fixtures

| Fixture | Domain | Questions (test cases) | Last commit | Files |
|---|---|---|---|---|
| `task-001-off-by-one` | General JS / Algorithms | 4 | `af116eb` | `src/utils/pagination.js`, `.test.js`, `task.json` |
| `task-002-sql-injection` | Security + Database | 3 | `e78f678` | `src/db/build-user-query.js`, `.test.js`, `task.json` |
| `task-003-xss-sanitize` | Frontend + Security | 5 | `e78f678` | `src/ui/sanitize-html.js`, `.test.js`, `task.json` |
| `task-004-rate-limiter` | Backend API | 4 | `e78f678` | `src/middleware/rate-limiter.js`, `.test.js`, `task.json` |
| `task-005-dockerfile-fix` | DevOps | 7 | `e78f678` | `src/ci/validate-dockerfile.js`, `.test.js`, `task.json` |
| `task-006-mock-leak` | Testing | 6 | `e78f678` | `src/testing/mock-fetch.js`, `.test.js`, `task.json` |
| `task-007-lru-cache` | Algorithms | 6 | `e78f678` | `src/data-structures/lru-cache.js`, `.test.js`, `task.json` |

**Total questions: 35** across 7 fixtures. Question count = number of
`test()` declarations in the fixture's verify suite.

## Refresh

The "last commit" column goes stale as fixtures are edited. Re-check it after
any fixture change with:

```bash
for d in benchmark/fixtures/task-*; do
  echo "$d  $(git log --oneline -1 -- "$d")"
done
```

(One line per fixture; the table above is authoritative only until the next
fixture edit.)
