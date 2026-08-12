#!/usr/bin/env bash
# Self-check for tmux-run: a fast command must return its COMPLETE output and REAL exit code.
# This is the contract the tail-follow streaming used to break — fast commands (ls/pwd/echo) finished
# before `tail -f` flushed, so the SDK captured empty stdout ("Bash completed with no output").
# Run: bash tmux-run.test.sh   (needs tmux; skips cleanly if absent)
set -u
W="$(dirname "$0")/tmux-run"
command -v tmux >/dev/null || { echo "SKIP: tmux not installed"; exit 0; }
S=selftest
R=selftest-race
# This script inherits a REAL sandbox's environment when it runs inside one, so it pins the two vars that decide
# where its output goes and whether it is filtered. Neither may be left ambient:
#
#   INTENTIC_TERMINAL_LOGS_DIR — both downstream writers key off it: tmux-run's pane logs and, since
#       agent-output-filter is on PATH image-wide, its telemetry row per command ($dir/../filter-stats.jsonl).
#       Left inherited, this script's fixtures — `ls -la /` twenty times, `exit 7`, `echo hi; exit 3` — land in
#       the REAL savings ledger and are then reported to the owner as agent traffic. A test must not be able to
#       write the product's telemetry.
#   INTENTIC_RUN_FILTER — off for the cases below, which assert on RAW capture; the filter block at the bottom
#       turns it on for itself. Left inherited it is whatever the host sandbox's "Clean command output" switch
#       implies (off exports 0), so the filter cases would quietly assert nothing.
LOGS="$(mktemp -d)"
F=""
export INTENTIC_TERMINAL_LOGS_DIR="$LOGS/terminals"
export INTENTIC_RUN_FILTER=0
mkdir -p "$INTENTIC_TERMINAL_LOGS_DIR"
# One cleanup for the whole run — a second `trap ... EXIT` later would silently replace this one, not add to it.
cleanup() {
    tmux kill-session -t "$S" 2>/dev/null
    tmux kill-session -t "$R" 2>/dev/null
    rm -rf "$LOGS" ${F:+"$F"}
}
trap cleanup EXIT

# Fast command, many times: never empty, always exit 0.
for i in $(seq 1 20); do
    out="$(bash "$W" "$S" 'ls -la /' run)"; rc=$?
    [ -n "$out" ] || { echo "FAIL: empty output on fast run $i"; exit 1; }
    [ "$rc" = 0 ] || { echo "FAIL: exit $rc (want 0) on fast run $i"; exit 1; }
done

# Concurrent commands race on creating the session, on pruning the same dead predecessor, and on the session
# being destroyed by that prune between another command's has-session check and its new-window. No expected
# race may leak tmux's "duplicate session" / "can't find session" / "can't find window" diagnostics into the
# tool result, and every command must still report its own exit code.
D="$(mktemp -d)"
race() {
    for i in $(seq 1 20); do
        { INTENTIC_RUN_FILTER=0 bash "$W" "$R" 'true' run >"$D/$1-$i.out" 2>"$D/$1-$i.err"; echo $? >"$D/$1-$i.rc"; } &
    done
    wait
}
# Round one starts from no session at all (the new-session race); round two runs against a session whose
# windows are now ALL dead, so a prune can destroy it out from under a command that just saw it exist.
race a
race b
errors="$(grep -h . "$D"/*.err 2>/dev/null)"
codes="$(grep -hv '^0$' "$D"/*.rc 2>/dev/null)"
rm -rf "$D"
[ -z "$errors" ] || { echo "FAIL: concurrent runner leaked tmux diagnostics: $errors"; exit 1; }
[ -z "$codes" ] || { echo "FAIL: concurrent runner lost an exit code: $codes"; exit 1; }

# Exit code fidelity through the tee pipeline.
bash "$W" "$S" 'exit 7' run >/dev/null; [ $? = 7 ] || { echo "FAIL: exit-code not preserved"; exit 1; }
out="$(bash "$W" "$S" 'echo hi; exit 3' run)"; rc=$?
[ "$out" = hi ] && [ "$rc" = 3 ] || { echo "FAIL: got out='$out' rc=$rc (want hi/3)"; exit 1; }

# The owner stamp lands on the SESSION (a tmux user option the daemon's reaper lists by), from the wrapper's
# own environment — and a run without the stamp leaves the option untouched rather than blanking it.
INTENTIC_TURN_OWNER=conv-reap-test bash "$W" "$S" 'true' run >/dev/null
owner="$(tmux show-options -t "=$S:" -v @intentic_owner 2>/dev/null)"
[ "$owner" = conv-reap-test ] || { echo "FAIL: session owner option got '$owner' (want conv-reap-test)"; exit 1; }
bash "$W" "$S" 'true' run >/dev/null
owner="$(tmux show-options -t "=$S:" -v @intentic_owner 2>/dev/null)"
[ "$owner" = conv-reap-test ] || { echo "FAIL: unstamped run disturbed the owner option: '$owner'"; exit 1; }

# Both halves of the finished-session contract, checked on a session whose every command has completed.
# 1. The session SURVIVES with its last command's output still readable — a dead window (remain-on-exit) is
#    what the terminal panel shows after a turn. remain-on-exit has to be set from inside the pane: a fast
#    command exits before an option set from outside lands, and tmux then destroys the window — the whole
#    session with it, since no bootstrap shell holds it open.
# 2. NO pane is alive — not even the shell `tmux new-session` would leave in window 0. One never-dying pane
#    makes the daemon report the agent session as `running` forever (paneStates, src/system/system.routes.ts),
#    so the panel's "clear finished terminals" sweep can never take a finished agent's terminal.
panes="$(tmux list-panes -s -t "=$S" -F '#{pane_dead} #{window_name} #{pane_current_command}' 2>&1)" \
    || { echo "FAIL: session gone after a finished command (want it kept, dead, readable): $panes"; exit 1; }
printf '%s\n' "$panes" | grep -q '^0 ' \
    && { echo "FAIL: live pane left in a session whose commands all finished:"; printf '  %s\n' "$panes"; exit 1; }

# -e NAME resolves from the wrapper's own env onto the window (name-only; the value never rides an argv).
out="$(FOO=bar bash "$W" -e FOO "$S" 'echo "$FOO"' run)"; rc=$?
[ "$out" = bar ] && [ "$rc" = 0 ] || { echo "FAIL: -e name got out='$out' rc=$rc (want bar/0)"; exit 1; }

# Fresh per window: the server (started above without FOO) must not mask the caller's CURRENT value.
out="$(FOO=second bash "$W" -e FOO "$S" 'echo "$FOO"' run)"; rc=$?
[ "$out" = second ] && [ "$rc" = 0 ] || { echo "FAIL: stale window env got out='$out' rc=$rc (want second/0)"; exit 1; }

# Unset and invalid names are skipped, never fatal (set -u + indirect-expansion guard).
out="$(bash "$W" -e NOPE_UNSET -e 'no good' "$S" 'echo "ok-${NOPE_UNSET:-unset}"' run)"; rc=$?
[ "$out" = ok-unset ] && [ "$rc" = 0 ] || { echo "FAIL: unset/invalid -e got out='$out' rc=$rc (want ok-unset/0)"; exit 1; }

# Output cap: only the tail of the capture ships over stdout (the pane keeps the full output).
out="$(INTENTIC_RUN_FILTER=0 INTENTIC_RUN_OUTPUT_BYTES=3 bash "$W" "$S" 'printf abcdef' run)"; rc=$?
[ "$out" = def ] && [ "$rc" = 0 ] || { echo "FAIL: output cap got out='$out' rc=$rc (want def/0)"; exit 1; }

# Soft timeout: a long-running command returns early with exit 0 and a follow handle, pane left alive.
out="$(INTENTIC_RUN_SOFT_TIMEOUT_S=1 bash "$W" "$S" 'echo started; sleep 60' run)"; rc=$?
[ "$rc" = 0 ] || { echo "FAIL: soft timeout exited $rc (want 0)"; exit 1; }
case "$out" in *started*"still running"*) ;; *) echo "FAIL: soft-timeout output missing started/still-running: '$out'"; exit 1;; esac
tmux list-panes -s -t "=$S" -F '#{pane_dead}' | grep -q 0 || { echo "FAIL: long-running pane did not survive early return"; exit 1; }

# With the output filter on PATH: failures pass through verbatim; command-matched noise is stripped on
# success with the footer naming the elision.
command -v node >/dev/null || { echo "SKIP filter cases: node not installed"; echo "PASS: tmux-run self-check"; exit 0; }
F="$(mktemp -d)"
printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$(cd "$(dirname "$0")" && pwd)/agent-output-filter.mjs" > "$F/agent-output-filter"
chmod +x "$F/agent-output-filter"
out="$(INTENTIC_RUN_FILTER=1 PATH="$F:$PATH" bash "$W" "$S" 'echo hi; exit 3' run)"; rc=$?
[ "$out" = hi ] && [ "$rc" = 3 ] || { echo "FAIL: filtered failure got out='$out' rc=$rc (want hi/3)"; exit 1; }

# A LOT of progress noise, deliberately. The trim has to dwarf the retrieval footer, because the filter's
# "never worse than raw" guard hands back the raw capture whenever the final text would be longer than what
# came in — and the footer carries this run's pane-log path, whose length is a temp directory nobody controls.
# A handful of lines put the two within a few bytes of each other and the assertion passed or failed by which
# mktemp name it drew. `:` keeps the command a no-op while still NAMING pnpm, which is what the cleaner matches.
noise='for i in $(seq 1 40); do printf "Progress: resolved %d, reused %d, downloaded 0, added 0\n" "$i" "$i"; done; printf "done in 4s\n"'

out="$(INTENTIC_RUN_FILTER=1 PATH="$F:$PATH" bash "$W" "$S" ": pnpm install; $noise" run)"; rc=$?
[ "$rc" = 0 ] || { echo "FAIL: filtered success exited $rc"; exit 1; }
case "$out" in *"Progress: resolved"*) echo "FAIL: pnpm progress survived the filter: '$out'"; exit 1;; esac
case "$out" in *"done in 4s"*"filtered to"*) ;; *) echo "FAIL: filtered success missing summary/footer: '$out'"; exit 1;; esac

# -c names the command the FILTER is told this is: by the time tmux-run runs it, the executed line carries the
# daemon's wrapping (namespace hop, nice/ionice, bash -c), while everything the filter is asked about — which
# cleaners match, which un-cleaned commands deserve a handler — is a property of what the AGENT wrote.
#
# Asserted through a stub filter rather than the real one, because the question here is purely "which string
# reaches argv[1]". Routing it through the cleaners instead would make the assertion depend on their matching,
# the session cache and the size guard above, none of which this flag has anything to do with.
printf '#!/usr/bin/env bash\nprintf "ARGV1=%%s\\n" "$1"\n' > "$F/echo-argv1"
chmod +x "$F/echo-argv1"
out="$(INTENTIC_RUN_FILTER=1 INTENTIC_FILTER_CMD="$F/echo-argv1" bash "$W" -c 'pnpm install' "$S" 'echo ignored' run)"
[ "$out" = "ARGV1=pnpm install" ] || { echo "FAIL: -c did not reach the filter, got '$out'"; exit 1; }
# Without it the two are the same string — the daemon's own terminal runner has no wrapping to see past.
out="$(INTENTIC_RUN_FILTER=1 INTENTIC_FILTER_CMD="$F/echo-argv1" bash "$W" "$S" 'echo ignored' run)"
[ "$out" = "ARGV1=echo ignored" ] || { echo "FAIL: filter got '$out' with no -c (want the executed command)"; exit 1; }

echo "PASS: tmux-run returns full output + real exit code, -e env, -c filter command, output cap, soft timeout + filter behave"
