# Example: Fix a Bug — Perception Extractor Dangling Edge

**Scenario:** A bug was found in the perception extractor where a dangling edge
(an edge referencing a deleted node) was not being cleaned up, causing graph
corruption and query failures.

## Command: Run the perception query tests to verify the fix

```bash
npm test -- --run tests/perception/queries.test.ts
```

## Real output (captured during fix verification):

```
> aura-code@0.3.0 test
> vitest run --run tests/perception/queries.test.ts

 RUN  v2.1.9 /home/dusan/aura-code

 ✓ tests/perception/queries.test.ts (51 tests) 20ms

 Test Files  1 passed (1)
      Tests  51 passed (51)
   Start at  16:03:23
   Duration  350ms (transform 48ms, setup 0ms, collect 46ms, tests 20ms, environment 0ms, prepare 76ms)
```

## Command: Run the full test suite to confirm no regressions

```bash
npm test
```

## Real output (captured after fix):

```
 Test Files  56 passed (56)
      Tests  880 passed (880)
   Start at  16:03:28
   Duration  28.54s (transform 3.31s, setup 0ms, collect 7.54s, tests 33.32s, environment 15ms, prepare 5.37s)
```

**Result:** All 880 tests pass — the fix is verified with zero regressions.
