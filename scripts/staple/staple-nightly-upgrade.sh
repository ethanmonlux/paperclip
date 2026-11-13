#!/usr/bin/env bash
# Staple nightly upgrade: install the newest certified ethanmonlux/paperclip master behind safety gates.
# Installed as ~/.local/bin/staple-nightly-upgrade. It is the only Staple install path (FAC-840 C1).
#
# Usage:
#   staple-nightly-upgrade hold              02:30: place the maintenance hold (admission held, wakes queue),
#                                            only when a certified commit newer than the installed build exists
#   staple-nightly-upgrade [--dry-run]       03:30: upgrade under the hold, then release it
#   QUIET_MODE=1 staple-nightly-upgrade      hourly: opportunistic daytime install, only when already quiet
#   staple-nightly-upgrade ci-state CHECKS WORKFLOWS   print the Gate 0 state for saved GitHub JSON (no side effects)
#   staple-nightly-upgrade certified-pick INSTALLED CHAIN   print the certified target for a saved first-parent chain
#   staple-nightly-upgrade certified-target [INSTALLED]     read GitHub and print the certified target (no side effects)
#   staple-nightly-upgrade certify-report [--dry-run] [RUN] open repair tasks for a red nightly certification
#   staple-nightly-upgrade backup-result OUTPUT RC          print the Gate 2 result for saved db:backup stdout
#   staple-nightly-upgrade startup-logged EPOCH             print whether the service journal shows startup recovery
#
# Certification (STA-223): a push to a pull request runs routine checks only. The nightly staple-certify.yml run
# certifies one master commit with the full suite and records the commit status `staple/certified`.
# Only the newest first-parent master commit certified `success` is installed. A missing, pending,
# failed or unreadable certification blocks that commit, and an older certified one is used instead.
# Nothing older than the installed build is ever installed. A red nightly becomes urgent-lane repair
# tasks (certify-report, which every upgrade and quiet-window check runs first).
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

# Gate 0 state for one commit (STA-224). $1 = GitHub check-runs JSON, $2 = workflow-runs JSON.
# Prints one line; names are separated by "; " because job names can contain commas:
#   green              every check run and workflow run completed success/skipped/neutral
#   pending:<names>    nothing failed yet, but a check or workflow run is queued or in progress: retry later
#   red:<names>        a check or workflow run completed otherwise (failure, cancelled, timed_out,
#                      startup_failure, action_required, ...): wins over pending
#   none               no check runs at all
#   error:<reason>     the GitHub response is unreadable or truncated
# Everything except green blocks the install.
ci_state() {
  python3 - "$1" "$2" <<'PY'
import json,sys
OK=("success","skipped","neutral")
def load(path, key):
    try: d=json.load(open(path))
    except Exception: d=None
    if not isinstance(d,dict) or not isinstance(d.get(key),list):
        msg=d.get("message","") if isinstance(d,dict) else ""
        print("error:%s unreadable%s" % (key.replace("_","-"), (" ("+str(msg)[:80]+")") if msg else "")); sys.exit()
    items=d[key]
    if isinstance(d.get("total_count"),int) and d["total_count"]>len(items):
        print("error:%s truncated (%d of %d)" % (key.replace("_","-"), len(items), d["total_count"])); sys.exit()
    return items
checks=load(sys.argv[1],"check_runs"); runs=load(sys.argv[2],"workflow_runs")
red=[]; pending=[]
for kind,items in (("workflow ",runs),("",checks)):
    for x in items:
        name=kind+str(x.get("name") or "?")
        if x.get("status")!="completed": pending.append(name)
        elif x.get("conclusion") not in OK: red.append("%s (%s)" % (name, x.get("conclusion")))
if red: print("red:"+"; ".join(red[:5]))
elif pending: print("pending:"+"; ".join(pending[:5]))
elif not checks: print("none")
else: print("green")
PY
}

backup_result() {
  python3 - "$1" "$2" <<'PY'
import json,os,re,sys
path,rc=sys.argv[1],sys.argv[2]
if rc!="0": print("error:db:backup exited %s"%rc); sys.exit()
try: text=re.sub(r"\x1b\[[0-9;?]*[A-Za-z]","",open(path,encoding="utf-8",errors="replace").read())
except OSError as e: print("error:db:backup output unreadable (%s)"%str(e)[:80]); sys.exit()
def extent(i):
    depth,quoted,esc=0,False,False
    for j in range(i,len(text)):
        c=text[j]
        if quoted:
            if esc: esc=False
            elif c=="\\": esc=True
            elif c=='"': quoted=False
        elif c=='"': quoted=True
        elif c=="{": depth+=1
        elif c=="}":
            depth-=1
            if depth==0: return j+1
    return len(text)
dec=json.JSONDecoder(); found=[]; i=text.find("{")
while i>=0:
    try: obj,end=dec.raw_decode(text,i)
    except ValueError:
        end=extent(i)
        if '"backupFile"' in text[i:end]: print("error:incomplete backup metadata in db:backup output"); sys.exit()
    else:
        if isinstance(obj,dict) and "backupFile" in obj: found.append(obj)
    i=text.find("{",end)
if not found: print("error:no backup metadata in db:backup output"); sys.exit()
if len(found)>1: print("error:%d backup metadata records in db:backup output"%len(found)); sys.exit()
meta=found[0]
f=meta.get("backupFile")
if not isinstance(f,str) or not os.path.isabs(f): print("error:backupFile is not an absolute path (%r)"%(f,)); sys.exit()
want=meta.get("sizeBytes")
if "sizeBytes" in meta and (type(want) is not int or want<0): print("error:sizeBytes is not a byte count (%r)"%(want,)); sys.exit()
if not os.path.isfile(f): print("error:backup file missing (%s)"%f); sys.exit()
size=os.path.getsize(f)
if size<=0: print("error:backup file empty (%s)"%f); sys.exit()
if want is not None and want!=size:
    print("error:backup file is %d bytes, db:backup reported %d (%s)"%(size,want,f)); sys.exit()
print("file:%s"%f)
PY
}

REPO=${STAPLE_REPO:-ethanmonlux/paperclip}
BRANCH=${STAPLE_BRANCH:-master}
CERT_CONTEXT=staple/certified
CERT_WINDOW=${STAPLE_CERT_WINDOW:-40}   # first-parent commits searched for a certified one

# Certified target (STA-223). $1 = installed SHA, $2 = file of first-parent SHAs, newest first.
# Reads each commit's current staple/certified status, newest first, and prints one line:
#   target:<sha> installed-in-chain:<yes|no>   the newest commit certified success
#   installed-newest                           reached the installed commit first: nothing newer is certified
#   none                                       no certified commit in the chain: fail closed
#   error:<reason>                             a status read failed: fail closed
# Each newer, uncertified commit is logged to stderr with its state. Statuses come from GitHub, or
# from $STAPLE_GITHUB_FIXTURES/statuses-<sha>.json when that is set (tests).
certified_pick() {
  REPO="$REPO" CERT_CONTEXT="$CERT_CONTEXT" python3 - "$1" "$2" <<'PY'
import json,os,sys,urllib.request
installed=sys.argv[1]; chain=[l.strip() for l in open(sys.argv[2]) if l.strip()]
fx=os.environ.get("STAPLE_GITHUB_FIXTURES")
def get(path):
    h={"Accept":"application/vnd.github+json"}
    if os.environ.get("STAPLE_GITHUB_TOKEN"): h["Authorization"]="Bearer "+os.environ["STAPLE_GITHUB_TOKEN"]
    url="https://api.github.com/repos/%s/%s"%(os.environ["REPO"],path)
    with urllib.request.urlopen(urllib.request.Request(url,headers=h),timeout=30) as r: return json.load(r)
def statuses(sha):
    if fx:
        p=os.path.join(fx,"statuses-%s.json"%sha)
        return json.load(open(p)) if os.path.exists(p) else []
    return get("commits/%s/statuses?per_page=100"%sha)
if not chain: print("error:empty history"); sys.exit()
# One call names the commits a certification run passed on; only those need a status read (the
# status stays authoritative). Fixtures without certify-runs.json read every commit's status.
passed=None
try:
    if not fx: passed=get("actions/workflows/staple-certify.yml/runs?status=success&per_page=100")
    elif os.path.exists(os.path.join(fx,"certify-runs.json")): passed=json.load(open(os.path.join(fx,"certify-runs.json")))
    if passed is not None: passed={r["head_sha"] for r in passed["workflow_runs"] if r.get("conclusion")=="success"}
except Exception as e: print("error:certification runs unreadable (%s)"%str(e)[:80]); sys.exit()
for sha in chain:
    if sha==installed: print("installed-newest"); sys.exit()
    if passed is not None and sha not in passed:
        print("  %s %s=missing (no passing certification run)"%(sha[:8],os.environ["CERT_CONTEXT"]),file=sys.stderr); continue
    try: d=statuses(sha)
    except Exception as e: print("error:status read for %s failed (%s)"%(sha[:8],str(e)[:80])); sys.exit()
    if not isinstance(d,list): print("error:status read for %s unreadable"%sha[:8]); sys.exit()
    # GitHub lists statuses newest first, so the first one for the context is current.
    state=next((x.get("state") for x in d if isinstance(x,dict) and x.get("context")==os.environ["CERT_CONTEXT"]),None)
    if state=="success": print("target:%s installed-in-chain:%s"%(sha,"yes" if installed in chain else "no")); sys.exit()
    print("  %s %s=%s"%(sha[:8],os.environ["CERT_CONTEXT"],state or "missing"),file=sys.stderr)
print("none")
PY
}
# Every page (up to 1,000 items) of a GitHub list. $1 = repo API path, $2 = list key. Prints one
# JSON object with total_count and all items, or GitHub's error body so ci_state reports `error`.
gh_pages() {
  REPO="$REPO" python3 - "$1" "$2" <<'PY'
import json,os,sys,urllib.error,urllib.request
path,key=sys.argv[1],sys.argv[2]; items=[]; total=0
h={"Accept":"application/vnd.github+json"}
if os.environ.get("STAPLE_GITHUB_TOKEN"): h["Authorization"]="Bearer "+os.environ["STAPLE_GITHUB_TOKEN"]
for page in range(1,11):
    url="https://api.github.com/repos/%s/%s%sper_page=100&page=%d"%(os.environ["REPO"],path,"&" if "?" in path else "?",page)
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers=h),timeout=30) as r: d=json.load(r)
    except urllib.error.HTTPError as e: print(e.read().decode(errors="replace")[:500]); sys.exit()
    except Exception as e: print(json.dumps({"message":str(e)[:200]})); sys.exit()
    if not isinstance(d,dict) or not isinstance(d.get(key),list): print(json.dumps(d)[:500]); sys.exit()
    items+=d[key]; total=d.get("total_count",len(items))
    if len(items)>=total or len(d[key])<100: break
print(json.dumps({"total_count":total,key:items}))
PY
}
# First-parent history of $BRANCH, newest first, from a commits-only shallow fetch (no API quota).
first_parent_chain() {
  # Tests: $STAPLE_GITHUB_FIXTURES/chain holds the first-parent SHAs, newest first.
  if [ -n "${STAPLE_GITHUB_FIXTURES:-}" ] && [ -f "$STAPLE_GITHUB_FIXTURES/chain" ]; then cat "$STAPLE_GITHUB_FIXTURES/chain"; return; fi
  local dir rc; dir=$(mktemp -d)
  git init -q --bare "$dir" && git -C "$dir" fetch -q --no-tags --filter=tree:0 --depth="$CERT_WINDOW" \
    "https://github.com/$REPO.git" "+refs/heads/$BRANCH:refs/heads/$BRANCH" &&
    git -C "$dir" rev-list --first-parent --max-count="$CERT_WINDOW" "refs/heads/$BRANCH"
  rc=$?; rm -rf "$dir"; return $rc
}

# Repair tasks for a red nightly certification (STA-223). The cloud runner cannot reach Staple, so
# the Staple side reads the result: every upgrade and quiet-window check runs this first. Each
# failing suite of the newest completed staple-certify.yml run on $BRANCH (or of run $1) becomes one
# critical (urgent-lane) task carrying the failing jobs, failed steps, annotation excerpts and the
# commit, assigned to the first idle agent in STAPLE_REPAIR_AGENTS (default: Workflow Engineer, then
# Repair Engineer). Each run is reported once. DRY=1 prints the tasks instead of creating them.
# GitHub reads come from $STAPLE_GITHUB_FIXTURES/<path>.json when that is set (tests).
certification_repairs() {
  REPO="$REPO" BRANCH="$BRANCH" API="${API:-}" CID="${CID:-}" TOK="${TOK:-}" DRY="${DRY:-0}" \
  STATE="${LOGDIR:-/tmp}/certify-reported" RUN_ID="${1:-}" python3 - <<'PY'
import json,os,re,sys,urllib.request
E=os.environ; dry=E["DRY"]=="1"
def gh(path):
    fx=E.get("STAPLE_GITHUB_FIXTURES")
    if fx: return json.load(open(os.path.join(fx,re.sub(r"[^A-Za-z0-9]+","_",path).strip("_")+".json")))
    h={"Accept":"application/vnd.github+json"}
    if E.get("STAPLE_GITHUB_TOKEN"): h["Authorization"]="Bearer "+E["STAPLE_GITHUB_TOKEN"]
    url="https://api.github.com/repos/%s/%s"%(E["REPO"],path)
    with urllib.request.urlopen(urllib.request.Request(url,headers=h),timeout=30) as r: return json.load(r)
def api(method,path,body=None):
    req=urllib.request.Request(E["API"]+path,method=method,data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization":"Bearer "+E["TOK"],"Content-Type":"application/json"})
    # The Staple API is local: never route it through a proxy.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=30) as r: return json.load(r)
items=lambda d: d if isinstance(d,list) else d.get("items",[])
if E["RUN_ID"]: run=gh("actions/runs/%s"%E["RUN_ID"])
else:
    runs=gh("actions/workflows/staple-certify.yml/runs?branch=%s&status=completed&per_page=1"%E["BRANCH"]).get("workflow_runs",[])
    if not runs: print("certification: no completed nightly run on %s yet"%E["BRANCH"]); sys.exit()
    run=runs[0]
rid,sha,concl=str(run["id"]),run["head_sha"],run.get("conclusion")
if concl not in ("failure","timed_out","startup_failure"):
    print("certification: run %s on %s is %s; no repair needed"%(rid,sha[:8],concl)); sys.exit()
key=lambda fam: rid+" "+re.sub(r"\s+","_",fam)
done=set()
if os.path.exists(E["STATE"]): done={" ".join(l.split()[:2]) for l in open(E["STATE"]) if len(l.split())>=2}
if key("*") in done: print("certification: red run %s on %s already reported"%(rid,sha[:8])); sys.exit()
jobs=[]
for page in (1,2):
    d=gh("actions/runs/%s/jobs?filter=latest&per_page=100&page=%d"%(rid,page)); jobs+=d.get("jobs",[])
    if len(jobs)>=d.get("total_count",0): break
bad=[j for j in jobs if j.get("conclusion") in ("failure","timed_out","startup_failure","cancelled")]
# Aggregates fail because a suite failed; report them only when nothing else did.
leaf=[j for j in bad if j["name"].split(" / ")[-1] not in ("verify","e2e","Record certification")] or bad
if not leaf: leaf=[{"id":0,"name":"Staple certification","conclusion":concl,"html_url":run.get("html_url",""),"steps":[]}]
family=lambda name: re.sub(r" \(.*\)$","",re.sub(r"^ci / ","",name))
fams={}
for j in leaf: fams.setdefault(family(j["name"]),[]).append(j)
def excerpt(j):
    lines=["- **%s** (%s): %s"%(j["name"],j["conclusion"],j.get("html_url",""))]
    steps=[s["name"] for s in j.get("steps",[]) if s.get("conclusion") in ("failure","timed_out")]
    if steps: lines.append("  - Failed step: "+", ".join(steps[:3]))
    try: notes=gh("check-runs/%s/annotations?per_page=20"%j["id"]) if j["id"] else []
    except Exception: notes=[]
    for a in [a for a in notes if a.get("annotation_level")=="failure"][:4]:
        lines.append("  - `%s`: %s"%(a.get("path",""),re.sub(r"\s+"," ",str(a.get("message","")))[:400]))
    return "\n".join(lines)
assignee=None; who="nobody"
try:
    agents=items(api("GET","/api/companies/%s/agents"%E["CID"]))
    busy={}
    for r in items(api("GET","/api/companies/%s/heartbeat-runs?status=running&limit=200"%E["CID"])):
        busy[r.get("agentId")]=busy.get(r.get("agentId"),0)+1
    names=[n.strip() for n in E.get("STAPLE_REPAIR_AGENTS","Workflow Engineer,Repair Engineer").split(",") if n.strip()]
    cands=[a for n in names for a in agents if a.get("name")==n and a.get("status") not in ("paused","terminated","error")]
    idle=[a for a in cands if not busy.get(a["id"])]
    pick=idle[0] if idle else min(cands,key=lambda a:busy.get(a["id"],0),default=None)
    if pick: assignee=pick["id"]; who="%s (%d running)"%(pick["name"],busy.get(pick["id"],0))
except Exception as e: print("certification: could not choose an assignee (%s)"%str(e)[:120])
for fam,js in sorted(fams.items()):
    if key(fam) in done: continue
    title="Nightly certification red: %s on master %s"%(fam,sha[:8])
    body="\n".join(["The nightly full-suite certification failed, so `%s` is not `staple/certified` and will not be installed."%sha,
        "","Run: %s"%run.get("html_url",""),"","Failing jobs (%d):"%len(js),""]+[excerpt(j) for j in js[:3]]+
        (["- and %d more"%(len(js)-3)] if len(js)>3 else [])+
        ["","**Repair:** merge the fix under the normal bar with its own routine checks. Then run `staple-certify.yml`",
         "with `workflow_dispatch` on master to certify the new head. Until a newer commit is certified, the installer keeps",
         "the last certified build.","","Opened by `staple-nightly-upgrade certify-report` (STA-223)."])
    if dry: print("DRY RUN: would open critical task %r for %s\n%s\n"%(title,who,body)); continue
    payload={"title":title,"description":body,"status":"todo","priority":"critical"}
    if assignee: payload["assigneeAgentId"]=assignee
    created=api("POST","/api/companies/%s/issues"%E["CID"],payload)
    if not created.get("id"): print("certification: task creation failed for %s: %s"%(fam,json.dumps(created)[:200])); sys.exit(1)
    ref=created.get("identifier") or created["id"]
    open(E["STATE"],"a").write("%s %s\n"%(key(fam),ref))
    print("certification: opened %s for %s on %s, assigned to %s"%(ref,fam,sha[:8],who))
if not dry: open(E["STATE"],"a").write("%s %s\n"%(key("*"),sha))
PY
}

startup_logged() {
  local out err rc
  err=$(mktemp)
  [[ "$1" =~ ^[0-9]+(\.[0-9]{1,6})?$ ]] || { echo "error:restart time is not epoch seconds ($1)"; rm -f "$err"; return 2; }
  out=$(journalctl --user -u paperclipai --since "@$1" --no-pager 2>"$err"); rc=$?
  if [ $rc != 0 ]; then echo "error:journalctl exited $rc ($(head -c 200 "$err" | tr '\n' ' ' | sed 's/ *$//'))"; rm -f "$err"; return 2; fi
  rm -f "$err"
  if grep -qF "startup recovery complete" <<<"$out"; then echo logged; else echo waiting; return 1; fi
}

case "${1:-}" in
  ci-state) ci_state "${2:?check-runs JSON}" "${3:?workflow-runs JSON}"; exit $? ;;
  certified-pick) certified_pick "${2:?installed SHA}" "${3:?first-parent chain file}"; exit $? ;;
  backup-result) backup_result "${2:?db:backup output file}" "${3:?db:backup exit code}"; exit $? ;;
  startup-logged) startup_logged "${2:?restart time, epoch seconds}"; exit $? ;;
  certified-target)
    CHAIN=$(mktemp); trap 'rm -f "$CHAIN"' EXIT
    first_parent_chain > "$CHAIN" || { echo "error:could not read $BRANCH history"; exit 1; }
    certified_pick "${2:--}" "$CHAIN"; exit $? ;;
esac

MODE=upgrade; DRY=0; CERT_RUN=
for a in "$@"; do
  case "$a" in
    hold) MODE=hold ;;
    certify-report) MODE=certify-report ;;
    --dry-run) DRY=1 ;;
    [0-9]*) CERT_RUN=$a ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done
API=${STAPLE_API:-http://127.0.0.1:3100}
CID=${STAPLE_COMPANY_ID:-ad240b50-ded9-43bd-b052-da137d595161}
LOGDIR=$HOME/.paperclip/nightly; mkdir -p "$LOGDIR"
QUIET_MODE=${QUIET_MODE:-0}   # 1 = opportunistic daytime install: only act if Staple is already quiet; stay silent otherwise
HOLD_DRAIN_MIN=${HOLD_DRAIN_MIN:-45}   # nightly: runs get this long to finish before they are parked
HOLD_MAX_MIN=${HOLD_MAX_MIN:-90}       # auto-release after this long without a renewal
if [ "$MODE" = hold ]; then LOG=$LOGDIR/hold-$(date +%Y%m%d-%H%M).log
elif [ "$MODE" = certify-report ]; then LOG=$LOGDIR/certify-report.log
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
running() {  # work an install would cut short: 0 only at real quiet
  if [ "$HOLD_KIND" = maintenance ]; then
    # blockingWork also counts stops still settling and parked runs whose continuation is not yet queued.
    api_status "$API/api/instance/maintenance-hold" >/dev/null
    local b; b=$(json_get blockingWork); [ -n "$b" ] && echo "$b" || json_get runningRuns; return
  fi
  api "$API/api/companies/$CID/heartbeat-runs?status=running&limit=50" | python3 -c '
import json,sys
d=json.load(sys.stdin); d=d if isinstance(d,list) else d.get("items",[])
print(len([x for x in d if x.get("status")=="running"]))'
}

health_commit() { curl -s -m 10 $API/api/health | python3 -c 'import json,sys;print(json.load(sys.stdin).get("commit",""))' 2>/dev/null; }

if [ "$MODE" = certify-report ]; then certification_repairs "$CERT_RUN"; exit $?; fi

if [ "$MODE" = hold ]; then
  exec 9>"$LOGDIR/upgrade.lock"; flock -n 9 || { say "an upgrade run holds the lock; it manages the hold itself"; exit 0; }
  say "== Staple maintenance hold (drain ${HOLD_DRAIN_MIN} min, max ${HOLD_MAX_MIN} min)"
  # Hold only when there is a certified commit to install. Without one the 03:30 run skips, so a
  # hold would drain and park work for nothing. If a commit is certified after this check, the
  # 03:30 run places its own hold with the same drain before installing.
  INSTALLED=$(health_commit); CHAIN=$(mktemp)
  if [ -z "$INSTALLED" ]; then PICK="error:installed build unreadable"
  elif ! first_parent_chain > "$CHAIN" || [ ! -s "$CHAIN" ]; then PICK="error:could not read $BRANCH history"
  else PICK=$(certified_pick "$INSTALLED" "$CHAIN"); fi
  rm -f "$CHAIN"
  case "$PICK" in
    target:*) say "certified target: $PICK" ;;
    *) say "no certified commit to install ($PICK); not placing the hold. Installed stays ${INSTALLED:0:8}."; exit 0 ;;
  esac
  [ $DRY = 1 ] && { say "DRY RUN: would place the maintenance hold"; exit 0; }
  place_hold "$HOLD_DRAIN_MIN" "$HOLD_MAX_MIN" "nightly maintenance window" || exit 1
  # The 03:30 upgrade releases it; the server's expiry releases it if that never runs.
  exit 0
fi

exec 9>"$LOGDIR/upgrade.lock"; flock -n 9 || { echo "another upgrade run holds the lock; exiting"; exit 0; }
REPORT_ISSUE_FILE=$LOGDIR/report-issue-id
report() {  # $1 = one-line outcome, $2 = detail
  if [ "$QUIET_MODE" = 1 ] && [[ "$1" == Skipped:* || "$1" == Waiting:* ]]; then say "quiet-mode skip (not reported): $1"; return; fi
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
# A red nightly certification becomes repair tasks first; a failure here never blocks the run.
certification_repairs || say "certification report failed; the next check retries"
INSTALLED=$(health_commit)
MASTER=$(git ls-remote https://github.com/$REPO.git refs/heads/$BRANCH | cut -f1)
say "installed=$INSTALLED master=$MASTER"
# The 02:30 hold is placed before the target is known; the release in the EXIT trap lifts it on every early exit.
if [ "$QUIET_MODE" != 1 ]; then api_status "$API/api/instance/maintenance-hold" >/dev/null && [ "$(json_get active)" = True ] && HOLD_KIND=maintenance; fi
if [ -z "$MASTER" ] || [ -z "$INSTALLED" ]; then report "Skipped: could not read installed or master commit" "installed='$INSTALLED' master='$MASTER'"; exit 1; fi
if [ "$INSTALLED" = "$MASTER" ]; then say "Already on master. Nothing to do."; exit 0; fi

# Gate C: install only the newest master commit the nightly full suite certified (STA-223).
CHAIN=$(mktemp)
if ! first_parent_chain > "$CHAIN" || [ ! -s "$CHAIN" ]; then
  rm -f "$CHAIN"; report "Skipped: could not read master history" "Certification cannot be checked. Installed stays ${INSTALLED:0:8}."; exit 1
fi
PICK=$(certified_pick "$INSTALLED" "$CHAIN"); rm -f "$CHAIN"
say "certified target: $PICK"
case "$PICK" in
  target:*) TARGET=${PICK#target:}; TARGET=${TARGET%% *} ;;
  installed-newest) report "Waiting: no certified master commit newer than installed ${INSTALLED:0:8}" "Master ${MASTER:0:8} is not $CERT_CONTEXT yet. Installed stays ${INSTALLED:0:8}."; exit 0 ;;
  none) report "Skipped: no $CERT_CONTEXT commit in the last $CERT_WINDOW master commits" "Fail closed: certification is missing. Installed stays ${INSTALLED:0:8}."; exit 0 ;;
  *) report "Skipped: certification unreadable (${PICK#error:})" "Fail closed. Installed stays ${INSTALLED:0:8}."; exit 0 ;;
esac
if [[ "$PICK" == *installed-in-chain:no ]]; then
  # The installed build is older than the search window or not on master: only move forward.
  ahead=$(curl -s -m 30 "https://api.github.com/repos/$REPO/compare/$INSTALLED...$TARGET" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("status",""))
except Exception: print("")')
  if [ "$ahead" != ahead ]; then report "Skipped: certified ${TARGET:0:8} is not ahead of installed ${INSTALLED:0:8} (${ahead:-unreadable})" "Nothing older than the installed build is installed. Installed stays ${INSTALLED:0:8}."; exit 0; fi
fi
[ "$TARGET" = "$MASTER" ] || say "newest certified commit ${TARGET:0:8} is behind master ${MASTER:0:8}; installing the certified one"

# Gate 0: target commit must have green CI. A run still queued or in progress is pending, not red:
# no install now, and the next watcher check retries (STA-224).
CI_CHECKS=$(mktemp); CI_RUNS=$(mktemp)
# A certified commit carries the nightly suite's check runs too, so read every page.
gh_pages "commits/$TARGET/check-runs" check_runs > "$CI_CHECKS"
gh_pages "actions/runs?head_sha=$TARGET" workflow_runs > "$CI_RUNS"
CI=$(ci_state "$CI_CHECKS" "$CI_RUNS"); rm -f "$CI_CHECKS" "$CI_RUNS"
say "CI on target: $CI"
case "$CI" in
  green) ;;
  pending:*) say "pending, retry: master ${TARGET:0:8} CI still running (${CI#pending:})"
    report "Waiting: master ${TARGET:0:8} CI still running (${CI#pending:})" "Pending, retry at the next watcher check; nothing failed. Installed stays ${INSTALLED:0:8}."; exit 0 ;;
  *) report "Skipped: master ${TARGET:0:8} CI is not green ($CI)" "Nothing changed. Installed stays ${INSTALLED:0:8}."; exit 0 ;;
esac

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
  n=$(running); say "running or settling work: $n (queued work is held)"
  [ "$n" = "0" ] && break
  if [ $(date +%s) -ge $deadline ]; then report "Skipped: $n run(s) still running after the drain deadline" "Hold released; held work resumes. Installed stays ${INSTALLED:0:8}."; exit 0; fi
  sleep 60
done

# Gate 2: backup
BK_OUT=$(mktemp)
paperclipai db:backup --filename-prefix staple-nightly-pre-${TARGET:0:8} --json > "$BK_OUT"
BK_RC=$?
BK=$(backup_result "$BK_OUT" "$BK_RC")
say "backup: $BK"
if [[ "$BK" != file:* ]]; then
  tail -n 20 "$BK_OUT" | sed 's/^/  db:backup: /'; rm -f "$BK_OUT"
  report "Skipped: database backup failed (${BK#error:})" "Nothing installed. Hold released."; exit 1
fi
rm -f "$BK_OUT"; BK=${BK#file:}

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
RESTART_AT=$(date +%s.%6N)
systemctl --user restart paperclipai
ok=0; SEEN=; STARTUP=not-checked
for i in $(seq 1 60); do
  sleep 5
  SEEN=$(health_commit)
  [ "$SEEN" = "$TARGET" ] || continue
  STARTUP=$(startup_logged "$RESTART_AT")
  [ "$STARTUP" = logged ] && { ok=1; break; }
done
say "verify: health commit ${SEEN:-unreadable}, startup $STARTUP"
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
