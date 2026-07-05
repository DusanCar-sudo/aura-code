# AI Battle Arena — Hard Question Prompt

Use this to pit two AI engines against each other. Give both the same question, then compare.

---

## The Prompt

```
You are competing in an AI benchmark battle. Another AI is answering the exact same question.
Your goal: give the BEST possible answer — the one that would be judged clearer, deeper, more
useful, and more correct. Be thorough but precise. Show your reasoning.

---

### The Question

A software company has 12 engineers. Each engineer can write 20 lines of code per hour.
However, due to technical debt, 15% of all code written must be rewritten the next day.
On day 1, all 12 engineers work for 8 hours. On day 2, one engineer is pulled into
meetings for 3 hours. On day 3, a new engineer joins at lunch (noon) and works at
half speed for the first 4 hours because they lack context.

The project requires 7,500 net lines of code (lines that survive after technical debt
rewrites are accounted for). Work continues 24/7 — engineers work in shifts, always
12 engineers (after day 3, 13) except when pulled for meetings.

Assume:
- "Net lines" = lines written minus lines that get rewritten the next day.
- The 15% rewrite happens at the START of each day, consuming time from that day's work.
- Rewritten lines do NOT count toward the net total — they are lost effort.
- An engineer's "half speed" means 10 lines/hour instead of 20.
- Each engineer works at most 8 hours per day (meetings reduce that).

Question 1: On which day does the team reach 7,500 net lines of code?
Question 2: How many total engineer-hours were spent (including time spent rewriting)?

Show your step-by-step reasoning with a day-by-day table before giving the final answer.
```

---

### Why this is a hard question

| Dimension | Why it's hard |
|---|---|
| **Multi-step math** | Not a single formula — requires day-by-day simulation |
| **State tracking** | The 15% rewrite on day N depends on what was written on day N-1 |
| **Edge cases** | Half-speed, partial-day joining, meeting pull-out |
| **Two answers** | Both the day AND total hours must be correct |
| **Definition trap** | "Net lines" definition is critical — rewritten lines are lost, not just delayed |
| **No shortcuts** | You can't just sum gross lines * 0.85; the rewrite consumes time each day |

---

### Scoring Rubric (compare both answers)

| Criterion | Points | What to look for |
|---|---|---|
| **Correct day** | 30 | Exact day number |
| **Correct total hours** | 15 | Engineer-hours match |
| **Day-by-day table** | 20 | Clear, correct day-by-day breakdown |
| **Shows reasoning** | 15 | Each step explained, assumptions stated |
| **Handles the 15% trap** | 10 | Correctly models rewrite consuming next day's time |
| **Format clarity** | 10 | Easy to read, well-structured |

**Total:** 100 points

---

### How to run the battle

```
Option A — Manual:
  Send the prompt to Engine 1 → save answer
  Send the prompt to Engine 2 → save answer
  Compare using the rubric above

Option B — With Aura:
  aura -m claude-sonnet-4-5-20251001 --once "<paste prompt>"
  aura -m gpt-4o --once "<paste prompt>"
  (compare outputs)

Option C — One-shot comparison prompt:
  "I will give you a question. Answer it as thoroughly as possible.
   Then I will ask the same question to another AI. After both answer,
   I will ask you to evaluate both answers using this rubric: [paste rubric]"
```

---

### Alternative hard questions (swap in if you want variety)

**Physics / estimation:**
> "Estimate how many piano tuners exist in London. Show every assumption, calculation,
> and margin of error. Then explain which single assumption most affects the result."

**Logic / paradox:**
> "A guard always lies. A prisoner always tells the truth. You meet one of them
> but don't know which. You may ask one yes/no question to determine which door
> leads to freedom. What question do you ask? Prove your answer works for both cases."

**Code review:**
> [paste a 50-line piece of buggy code]
> "Find all bugs, explain why each is a bug, rank them by severity, and rewrite correctly."

**Strategy:**
> "You are CEO of a company with 3 months of runway. You have 50 engineers,
> a product with 10,000 users, and a competitor who just raised $50M.
> Outline your exact plan for each of the next 12 weeks. Be specific — headcount,
> features, pricing, marketing. Defend your top priority."
