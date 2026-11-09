#!/usr/bin/env bash
# Staple nightly upgrade: install the latest green, merged ethanmonlux/paperclip master behind safety gates.
# Installed as ~/.local/bin/staple-nightly-upgrade. It is the only Staple install path (FAC-840 C1).
#
# Usage:
#   staple-nightly-upgrade hold              02:30: place the maintenance hold (admission held, wakes queue)
#   staple-nightly-upgrade [--dry-run]       03:30: upgrade under the hold, then release it
#   QUIET_MODE=1 staple-nightly-upgrade      hourly: opportunistic daytime install, only when already quiet
#
# The maintenance hold (FAC-840 C1, STA-182) replaces waiting for a natural zero-run moment, which a
# 16-agent instance never reaches. While it is active the server starts no new run; every wake,
# assignment and comment is still recorded and stays queued. Runs still running at the drain deadline
# (02:30 + 45 min) are parked with a queued continuation, never cancelled, so the upgrade sees zero
# running runs by construction. After success or rollback this script releases the hold and held
# work starts in priority order. The hold lifts by itself at its expiry even if this script dies.
#
# Bootstrap: a server without the hold API (404) gets the older process-local task drain instead.
# It holds admission the same way but cannot park stragglers and does not survive the restart.
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
MODE=upgrade; DRY=0
for a in "$@"; do
  case "$a" in
    hold) MODE=hold ;;
    --dry-run) DRY=1 ;;
  esac
done
API=${STAPLE_API:-http://127.0.0.1:3100}
CID=${STAPLE_COMPANY_ID:-ad240b50-ded9-43bd-b052-da137d595161}
REPO=${STAPLE_REPO:-ethanmonlux/paperclip}
LOGDIR=$HOME/.paperclip/nightly; mkdir -p "$LOGDIR"
QUIET_MODE=${QUIET_MODE:-0}   # 1 = opportunistic daytime install: only act if Staple is already quiet; stay silent otherwise
HOLD_DRAIN_MIN=${HOLD_DRAIN_MIN:-45}   # nightly: runs get this long to finish before they are parked
HOLD_MAX_MIN=${HOLD_MAX_MIN:-90}       # auto-release after this long without a renewal
if [ "$MODE" = hold ]; then LOG=$LOGDIR/hold-$(date +%Y%m%d-%H%M).log
elif [ "$QUIET_MODE" = 1 ]; then LOG=$LOGDIR/quiet-window.log
else LOG=$LOGDIR/upgrade-$(date +%Y%m%d-%H%M).log; fi
exec > >(tee -a "$LOG") 2>&1
say() { echo "[$(date '+%F %T')] $*"; }
TOK=$(python3 - <<'PY'
import json,os
a=json.load(open(os.path.expanduser("~/.paperclip/auth.json")))
def f(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if isinstance(v,str) and k.lower() in ("token","apikey","api_key","accesstoken","bearer","key"): return v
            r=f(v)
            if r: return r
    if isinstance(o,list):
        for v in o:
            r=f(v)
            if r: return r
print(f(a) or "")
PY
)
api() { curl -s -m 30 -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" "$@"; }
# Prints the HTTP status, writes the body to $HOLD_BODY.
HOLD_BODY=$(mktemp); trap 'rm -f "$HOLD_BODY"' EXIT
api_status() { curl -s -m 30 -o "$HOLD_BODY" -w '%{http_code}' -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" "$@"; }
json_get() { python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
for k in sys.argv[2].split("."):
    d=d.get(k) if isinstance(d,dict) else None
print("" if d is None else d)' "$HOLD_BODY" "$1"; }

# --- maintenance hold -------------------------------------------------------------------------
HOLD_KIND=none   # maintenance | task_drain | none
place_hold() {  # $1 = drain minutes, $2 = max minutes, $3 = reason
  local code
  code=$(api_status -X POST "$API/api/instance/maintenance-hold" \
    -d "{\"drainMinutes\":$1,\"maxMinutes\":$2,\"reason\":\"$3\"}")
  if [ "$code" = 200 ] || [ "$code" = 201 ]; then
    HOLD_KIND=maintenance
    say "maintenance hold active since $(json_get hold.startedAt); park at $(json_get hold.drainDeadlineAt); auto-release by $(json_get hold.expiresAt); queued=$(json_get queuedRuns) running=$(json_get runningRuns)"
    return 0
  fi
  if [ "$code" = 404 ]; then
    # Bootstrap only: the installed server predates the hold API.
    code=$(api_status -X POST "$API/api/instance/task-drain" -d "{\"ttlMs\":$(( $2 * 60000 ))}")
    if [ "$code" = 200 ]; then HOLD_KIND=task_drain; say "server has no maintenance hold API; holding admission with a process-local task drain"; return 0; fi
  fi
  say "could not place the hold (HTTP $code): $(head -c 300 "$HOLD_BODY")"
  return 1
}
release_hold() {  # $1 = reason
  case "$HOLD_KIND" in
    maintenance)
      local code; code=$(api_status -X DELETE -G --data-urlencode "reason=$1" "$API/api/instance/maintenance-hold")
      say "maintenance hold released ($1): HTTP $code wasActive=$(json_get wasActive) queued=$(json_get queuedRuns)" ;;
    task_drain)
      # After the install restart the process-local drain is already gone; this is then a no-op.
      api -X DELETE "$API/api/instance/task-drain" >/dev/null; say "task drain released ($1)" ;;
  esac
  HOLD_KIND=none
}
running() {
  if [ "$HOLD_KIND" = maintenance ]; then
    api_status "$API/api/instance/maintenance-hold" >/dev/null; json_get runningRuns; return
  fi
  api "$API/api/companies/$CID/heartbeat-runs?status=running&limit=50" | python3 -c '
import json,sys
d=json.load(sys.stdin); d=d if isinstance(d,list) else d.get("items",[])
print(len([x for x in d if x.get("status")=="running"]))'
}

if [ "$MODE" = hold ]; then
  exec 9>"$LOGDIR/upgrade.lock"; flock -n 9 || { say "an upgrade run holds the lock; it manages the hold itself"; exit 0; }
  say "== Staple maintenance hold (drain ${HOLD_DRAIN_MIN} min, max ${HOLD_MAX_MIN} min)"
  [ $DRY = 1 ] && { say "DRY RUN: would place the maintenance hold"; exit 0; }
  place_hold "$HOLD_DRAIN_MIN" "$HOLD_MAX_MIN" "nightly maintenance window" || exit 1
  # The 03:30 upgrade releases it; the server's expiry releases it if that never runs.
  exit 0
fi

exec 9>"$LOGDIR/upgrade.lock"; flock -n 9 || { echo "another upgrade run holds the lock; exiting"; exit 0; }
health_commit() { curl -s -m 10 $API/api/health | python3 -c 'import json,sys;print(json.load(sys.stdin).get("commit",""))' 2>/dev/null; }
REPORT_ISSUE_FILE=$LOGDIR/report-issue-id
report() {  # $1 = one-line outcome, $2 = detail
  if [ "$QUIET_MODE" = 1 ] && [[ "$1" == Skipped:* ]]; then say "quiet-mode skip (not reported): $1"; return; fi
  local id; id=$(cat "$REPORT_ISSUE_FILE" 2>/dev/null)
  if [ -z "$id" ]; then
    id=$(api -X POST $API/api/companies/$CID/issues -d "$(python3 -c 'import json;print(json.dumps({"title":"Nightly Staple upgrade log","description":"One comment per nightly run of ~/.local/bin/staple-nightly-upgrade (03:30 MT). Logs: ~/.paperclip/nightly/. Created by Claude for Ethan.","status":"backlog","priority":"low"}))')" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
    [ -n "$id" ] && echo "$id" > "$REPORT_ISSUE_FILE"
  fi
  [ -n "$id" ] && api -X POST $API/api/issues/$id/comments -d "$(python3 -c 'import json,sys;print(json.dumps({"body":"**"+sys.argv[1]+"**\n\n"+sys.argv[2]+"\n\nLog: `"+sys.argv[3]+"`"}))' "$1" "$2" "$LOG")" >/dev/null
  say "REPORT: $1"
}
# Release on every exit path: success, skip, rollback or failure. Work never stays frozen.
trap 'release_hold "upgrade run ended"; rm -f "$HOLD_BODY"' EXIT

say "== Staple nightly upgrade (dry=$DRY quiet=$QUIET_MODE)"
INSTALLED=$(health_commit)
TARGET=$(git ls-remote https://github.com/$REPO.git refs/heads/master | cut -f1)
say "installed=$INSTALLED target=$TARGET"
# The 02:30 hold is placed before the target is known; the release in the EXIT trap lifts it on every early exit.
if [ "$QUIET_MODE" != 1 ]; then api_status "$API/api/instance/maintenance-hold" >/dev/null && [ "$(json_get active)" = True ] && HOLD_KIND=maintenance; fi
if [ -z "$TARGET" ] || [ -z "$INSTALLED" ]; then report "Skipped: could not read installed or target commit" "installed='$INSTALLED' target='$TARGET'"; exit 1; fi
if [ "$INSTALLED" = "$TARGET" ]; then say "Already on master. Nothing to do."; exit 0; fi

# Gate 0: target commit must have green CI (all check runs success/skipped/neutral, none pending)
CI=$(curl -s -m 30 "https://api.github.com/repos/$REPO/commits/$TARGET/check-runs?per_page=100" | python3 -c '
import json,sys
d=json.load(sys.stdin); r=d.get("check_runs",[])
bad=[x["name"] for x in r if x["status"]!="completed" or x.get("conclusion") not in ("success","skipped","neutral")]
print("green" if r and not bad else ("none" if not r else "red:"+",".join(bad[:5])))')
say "CI on target: $CI"
if [ "$CI" != "green" ]; then report "Skipped: master ${TARGET:0:8} CI is not green ($CI)" "Nothing changed. Installed stays ${INSTALLED:0:8}."; exit 0; fi

# Gate 1: quiet, made by the maintenance hold rather than waited for.
if [ "$QUIET_MODE" = 1 ]; then
  # Daytime bonus path: throttle to one attempt per target per hour, and act only in a settled lull.
  STAMP=$LOGDIR/quiet-attempt-${TARGET:0:12}
  if [ -f "$STAMP" ] && [ $(( $(date +%s) - $(stat -c %Y "$STAMP") )) -lt 3600 ]; then say "quiet-mode: tried ${TARGET:0:8} within the hour; waiting"; exit 0; fi
  for i in 1 2 3; do
    n=$(running); say "quiet-mode check $i: running=$n"
    [ "$n" = "0" ] || { say "quiet-mode: busy, not installing now"; exit 0; }
    [ $i -lt 3 ] && sleep 60
  done
  [ $DRY = 1 ] || touch "$STAMP"
  DRAIN_MIN=10; MAX_MIN=45   # hold the lull through the build and restart
else
  DRAIN_MIN=$HOLD_DRAIN_MIN; MAX_MIN=$HOLD_MAX_MIN
fi
if [ $DRY = 1 ]; then say "DRY RUN: would hold admission (drain ${DRAIN_MIN} min), back up, build ${TARGET:0:8}, restart, verify, release."; HOLD_KIND=none; exit 0; fi
# Places the hold, or renews the 02:30 hold so it covers the build (its drain deadline is unchanged).
place_hold "$DRAIN_MIN" "$MAX_MIN" "managed upgrade to ${TARGET:0:8}" || { report "Skipped: could not hold admission" "Nothing changed. Installed stays ${INSTALLED:0:8}."; exit 1; }
if [ "$HOLD_KIND" = maintenance ]; then
  # The server parks stragglers at the drain deadline; allow a few minutes for the park to settle.
  deadline=$(python3 -c 'import sys,datetime;print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")).timestamp()))' "$(json_get hold.drainDeadlineAt)")
  deadline=$(( deadline + 5*60 ))
else
  deadline=$(( $(date +%s) + DRAIN_MIN*60 ))
fi
while :; do
  n=$(running); say "running runs: $n (queued work is held)"
  [ "$n" = "0" ] && break
  if [ $(date +%s) -ge $deadline ]; then report "Skipped: $n run(s) still running after the drain deadline" "Hold released; held work resumes. Installed stays ${INSTALLED:0:8}."; exit 0; fi
  sleep 60
done

# Gate 2: backup
BK=$(paperclipai db:backup --filename-prefix staple-nightly-pre-${TARGET:0:8} --json 2>/dev/null | tail -1)
say "backup: $BK"
echo "$BK" | grep -q '"path\|"file' || { report "Skipped: database backup failed" "Nothing installed. Hold released."; exit 1; }

# Upgrade
place_hold "$DRAIN_MIN" "$MAX_MIN" "managed upgrade to ${TARGET:0:8}" >/dev/null   # renew before the build
say "installing ${TARGET:0:8}"
if ! paperclipai install --repo $REPO --ref $TARGET --yes; then report "Failed: install of ${TARGET:0:8} did not complete" "Service not restarted; still running ${INSTALLED:0:8}. Hold released."; exit 1; fi
# Gate 1b: the hold keeps new runs from starting during the build; confirm before the restart.
n=$(running)
if [ "$n" != "0" ]; then
  say "busy at restart time ($n running); not restarting under live runs, rolling the payload back"
  paperclipai update --rollback --yes
  report "Skipped: $n run(s) running at restart time" "New payload built but not activated; payload rolled back. Still running ${INSTALLED:0:8}. Hold released."; exit 0
fi
systemctl --user restart paperclipai
ok=0
for i in $(seq 1 60); do
  sleep 5
  if [ "$(health_commit)" = "$TARGET" ] && journalctl --user -u paperclipai --since "-6min" --no-pager | grep -q "startup recovery complete"; then ok=1; break; fi
done
# Gate 3: smoke
if [ $ok = 1 ]; then
  AG=$(api $API/api/companies/$CID/agents | python3 -c 'import json,sys;d=json.load(sys.stdin);d=d if isinstance(d,list) else d.get("items",[]);print(len(d))' 2>/dev/null)
  IS=$(api "$API/api/companies/$CID/issues?limit=1" | python3 -c 'import json,sys;d=json.load(sys.stdin);d=d if isinstance(d,list) else d.get("items",[]);print(len(d))' 2>/dev/null)
  say "smoke: agents=$AG issues=$IS"
  [ "${AG:-0}" -gt 0 ] && [ "${IS:-0}" -gt 0 ] || ok=0
fi
if [ $ok = 1 ]; then
  release_hold "upgraded to ${TARGET:0:8}"
  report "Upgraded Staple ${INSTALLED:0:8} -> ${TARGET:0:8}" "Health ok, startup recovery complete, smoke passed, maintenance hold released (held work resumes in priority order). Backup: $BK"
  exit 0
fi
# Rollback: previous managed payload. DB restore is manual (backup above) because there is no restore command.
say "upgrade failed verification; rolling back"
paperclipai update --rollback --yes; systemctl --user restart paperclipai
for i in $(seq 1 60); do sleep 5; [ "$(health_commit)" = "$INSTALLED" ] && break; done
if [ "$(health_commit)" = "$INSTALLED" ]; then
  release_hold "rolled back to ${INSTALLED:0:8}"
  report "Rolled back: ${TARGET:0:8} failed checks, back on ${INSTALLED:0:8}" "Maintenance hold released. If the new version changed the database, restore manually from: $BK"
else
  report "NEEDS ETHAN: upgrade and rollback both failed" "Service is not healthy. The maintenance hold lifts by itself at its expiry. Backup: $BK. Log: $LOG"
fi
exit 1
