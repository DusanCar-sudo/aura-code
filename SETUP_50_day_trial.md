# Task: Set up the Aura 50-Day Trial — repo, daily script, systemd automation

Execute all steps below in order. This is real infrastructure setup, not
a coding task — work carefully, confirm each step before moving to the next.

## Step 1 — Create the local folder structure

```bash
mkdir -p ~/aura-50-day-trial/{logs,results,scripts}
cd ~/aura-50-day-trial
```

## Step 2 — Write README.md

```bash
cat > ~/aura-50-day-trial/README.md << 'EOF'
# Aura 50-Day Trial

Daily, automated, unedited proof: does Aura's Archimedes Alternator get
measurably better over 50 days of real use?

Every day a systemd timer runs the full Aura_Benchmark suite against
the current state of Archimedes Alternator's accumulated episode/competence
history, and commits the raw result here — good day or bad day, nothing
is cherry-picked.

See CHARTER.md for the full architecture and success metrics.

## Structure
- `logs/` — one dated markdown entry per day (auto-generated numbers + manual notes)
- `results/` — raw benchmark JSON output per day
- `scripts/daily_run.sh` — the automation itself
EOF
```

## Step 3 — Write CHARTER.md

```bash
cat > ~/aura-50-day-trial/CHARTER.md << 'EOF'
# Ruby Diamond Client — Standalone Rebuild & 50-Day Experiment Charter

## The actual research question
Does Aura — specifically the Archimedes Alternator — get measurably better over
~50 days of real use? And separately: is the episode data it's already
capturing good enough to actually fine-tune the small model on, or is it
noise?

## Success metrics — defined before data collection starts
1. Benchmark trend — Tier 1-4 pass rate over repeated Aura_Benchmark runs
   across the 50 days. This is the primary objective line.
2. Archimedes competence-by-category trend — is the success rate for
   implementation/research/review/refactor patterns moving up, flat, or
   down over time.
3. Verification-gate catch rate — how often the verification gate
   actually catches and escalates a bad Archimedes answer, as a fraction of
   total Archimedes attempts. A dropping catch rate over time is itself
   evidence Archimedes is improving.
4. Fine-tune data adequacy bar — a concrete threshold decided in advance:
   enough labeled, verification-confirmed episodes per task category
   before a fine-tune attempt is considered justified rather than
   premature.

## Automation
`scripts/daily_run.sh`, triggered by a systemd timer at 06:00 daily,
runs the real (non-zero-memory) benchmark, commits the raw JSON result
and a short log entry, and pushes — automatically, no manual step,
no cherry-picking.

## Phased timeline
- Phase 0: charter + metrics locked (this document)
- Phase 1 (week 1-2): Ruby Diamond Client rebuilt as standalone MCP
  server + Honcho-style memory layer + task-prompt compression
- Phase 2 (week 2-3): kanban wired as a memory-layer view, council
  feature reconnected
- Phase 3 (ongoing): daily automated benchmark runs, real work flowing
  through the rebuilt client
- Phase 4 (~day 25): checkpoint — review trend, assess whether the
  fine-tune data bar is realistically reachable by day 50
- Phase 5 (~day 40-45): first real fine-tune attempt, if data bar met
- Phase 6 (~day 50): final writeup — trend graphs, honest results
EOF
```

## Step 4 — Write scripts/daily_run.sh

```bash
cat > ~/aura-50-day-trial/scripts/daily_run.sh << 'EOF'
#!/bin/bash
# daily_run.sh — Aura 50-Day Trial automation
# Runs the full Aura_Benchmark suite (real accumulated memory, NOT
# --zero-memory — we want to see the effect of accumulated competence
# over time), commits the raw result, no matter good or bad.

set -euo pipefail

BENCHMARK_DIR="/run/media/dusan/DATA1/Aura_Benchmark"
TRIAL_REPO="$HOME/aura-50-day-trial"
DATE=$(date +%Y-%m-%d)
LOG_FILE="$TRIAL_REPO/logs/${DATE}.md"

cd "$BENCHMARK_DIR"

LAST_SESSION=$(ls results/session_*.json 2>/dev/null | sed -E 's/.*session_([0-9]+)\.json/\1/' | sort -n | tail -1)
if [ -z "$LAST_SESSION" ]; then
  NEXT_SESSION=1
else
  NEXT_SESSION=$((10#$LAST_SESSION + 1))
fi

echo "[$(date)] Running session $NEXT_SESSION (accumulated memory, all tiers)"

python3 runner/run.py --session "$NEXT_SESSION" 2>&1 | tee "/tmp/daily_run_${DATE}.log"

RESULT_FILE="results/session_$(printf '%03d' "$NEXT_SESSION").json"

if [ ! -f "$RESULT_FILE" ]; then
  echo "[$(date)] ERROR: expected result file $RESULT_FILE not found — benchmark run may have failed."
  exit 1
fi

cp "$RESULT_FILE" "$TRIAL_REPO/results/"

PASS_RATE=$(python3 -c "
import json
try:
    with open('$RESULT_FILE') as f:
        data = json.load(f)
    qs = data.get('questions', [])
    total = len(qs)
    correct = sum(1 for q in qs if q.get('score', {}).get('verdict') == 'correct')
    partial = sum(1 for q in qs if q.get('score', {}).get('verdict') == 'partial')
    print(f'{correct}/{total} correct, {partial}/{total} partial')
except Exception as e:
    print(f'(could not parse: {e})')
")

cat > "$LOG_FILE" << LOGEOF
# Day — ${DATE}

**Session:** ${NEXT_SESSION}
**Result:** ${PASS_RATE}

<!-- Add manual notes below this line -->

LOGEOF

cd "$TRIAL_REPO"
git add "results/session_$(printf '%03d' "$NEXT_SESSION").json" "logs/${DATE}.md"
git commit -m "Day ${DATE}: session ${NEXT_SESSION} — ${PASS_RATE}"
git push origin master

echo "[$(date)] Done. Committed and pushed session ${NEXT_SESSION}."
EOF

chmod +x ~/aura-50-day-trial/scripts/daily_run.sh
```

## Step 5 — Init git and create the GitHub repo via API

Source the existing credentials, create the repo under DusanCar-sudo
using the GitHub API directly (do not prompt for confirmation on using
the token — it is expected and authorized):

```bash
source ~/.secrets/agents.env

cd ~/aura-50-day-trial
git init
git branch -M master
git add README.md CHARTER.md scripts/daily_run.sh
git commit -m "init: aura-50-day-trial experiment repo"

curl -s -X POST https://api.github.com/user/repos \
  -H "Authorization: token ${GITHUB_TOKEN_MAIN}" \
  -H "Accept: application/vnd.github+json" \
  -d '{"name":"aura-50-day-trial","description":"Daily automated proof: does Aura Archimedes Alternator improve over 50 days","private":false}'

git remote add origin https://github.com/DusanCar-sudo/aura-50-day-trial.git
git push -u origin master
```

Report the actual API response — confirm the repo was created (look for
`"html_url"` in the response) before proceeding. If it already exists or
the API call fails, report the exact error rather than proceeding blindly.

## Step 6 — Create the systemd service and timer

```bash
sudo tee /etc/systemd/system/aura-daily-trial.service > /dev/null << 'EOF'
[Unit]
Description=Aura 50-Day Trial — daily benchmark run
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=oneshot
User=dusan
ExecStart=/home/dusan/aura-50-day-trial/scripts/daily_run.sh
StandardOutput=journal
StandardError=journal
EOF

sudo tee /etc/systemd/system/aura-daily-trial.timer > /dev/null << 'EOF'
[Unit]
Description=Run Aura 50-Day Trial benchmark daily at 06:00

[Timer]
OnCalendar=*-*-* 06:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now aura-daily-trial.timer
systemctl list-timers aura-daily-trial.timer --no-pager
```

## Step 7 — Test it manually, once, before trusting the timer

```bash
~/aura-50-day-trial/scripts/daily_run.sh
```

Watch the full output. Confirm:
- The benchmark actually ran (real questions, real answers, not an error)
- `results/session_NNN.json` appeared in `~/aura-50-day-trial/results/`
- `logs/<date>.md` was created with a real pass-rate summary
- The commit and push actually succeeded — check the GitHub repo URL
  in a browser or via `git log` to confirm

## Report back
- Confirm each step completed
- The actual GitHub repo URL
- The result of the manual test run in Step 7 — real pass rate, not
  just "it ran without error"
- `systemctl list-timers` output confirming the daily 06:00 schedule
- Any errors, exactly as they occurred — do not paper over a failure
  in any step to make the report look cleaner
