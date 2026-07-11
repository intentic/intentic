#!/usr/bin/env bash
# Self-check for tmux-run: a fast command must return its COMPLETE output and REAL exit code.
# This is the contract the tail-follow streaming used to break — fast commands (ls/pwd/echo) finished
# before `tail -f` flushed, so the SDK captured empty stdout ("Bash completed with no output").
# Run: bash tmux-run.test.sh   (needs tmux; skips cleanly if absent)
set -u
W="$(dirname "$0")/tmux-run"
command -v tmux >/dev/null || { echo "SKIP: tmux not installed"; exit 0; }
S=selftest
trap 'tmux kill-session -t "$S" 2>/dev/null' EXIT

# Fast command, many times: never empty, always exit 0.
for i in $(seq 1 20); do
    out="$(bash "$W" "$S" 'ls -la /' run)"; rc=$?
    [ -n "$out" ] || { echo "FAIL: empty output on fast run $i"; exit 1; }
    [ "$rc" = 0 ] || { echo "FAIL: exit $rc (want 0) on fast run $i"; exit 1; }
done

# Exit code fidelity through the tee pipeline.
bash "$W" "$S" 'exit 7' run >/dev/null; [ $? = 7 ] || { echo "FAIL: exit-code not preserved"; exit 1; }
out="$(bash "$W" "$S" 'echo hi; exit 3' run)"; rc=$?
[ "$out" = hi ] && [ "$rc" = 3 ] || { echo "FAIL: got out='$out' rc=$rc (want hi/3)"; exit 1; }

# -e pairs land in the window's environment (never on the command line): the command reads the var.
out="$(bash "$W" -e FOO=bar "$S" 'echo "$FOO"' run)"; rc=$?
[ "$out" = bar ] && [ "$rc" = 0 ] || { echo "FAIL: -e env got out='$out' rc=$rc (want bar/0)"; exit 1; }

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
F="$(mktemp -d)"; trap 'tmux kill-session -t "$S" 2>/dev/null; rm -rf "$F"' EXIT
printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$(cd "$(dirname "$0")" && pwd)/agent-output-filter.mjs" > "$F/agent-output-filter"
chmod +x "$F/agent-output-filter"
out="$(PATH="$F:$PATH" bash "$W" "$S" 'echo hi; exit 3' run)"; rc=$?
[ "$out" = hi ] && [ "$rc" = 3 ] || { echo "FAIL: filtered failure got out='$out' rc=$rc (want hi/3)"; exit 1; }
out="$(PATH="$F:$PATH" bash "$W" "$S" 'printf "npm warn deprecated x\nadded 1 package\n"' run)"; rc=$?
[ "$rc" = 0 ] || { echo "FAIL: filtered success exited $rc"; exit 1; }
case "$out" in *"npm warn"*) echo "FAIL: npm warn survived the filter: '$out'"; exit 1;; esac
case "$out" in *"added 1 package"*"filtered to"*) ;; *) echo "FAIL: filtered success missing summary/footer: '$out'"; exit 1;; esac

echo "PASS: tmux-run returns full output + real exit code, -e env, output cap, soft timeout + filter behave"
