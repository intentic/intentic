#!/bin/sh
# ONE-SHOT: move an EXISTING sandbox's state dir into the five group folders.
#
# The code half of this change (the state table, and every rule derived from it) ships in the sandbox image. A
# sandbox created after that image is fine — its stores write to the grouped paths from first boot, and the
# workspace rule is fresh state with no compatibility layers, so nothing in the daemon looks for the old spelling.
#
# A sandbox that already EXISTS is the case this file is for. Its `.intentic` still holds forty-nine entries at
# the flat spelling, and the new daemon will not find any of them: settings, personas, skills, automations and
# drafts all read as absent, and the owner sees what looks like a reset. Nothing is lost — the files are still
# there — but nothing is found either.
#
# RUN IT WHILE THE DAEMON IS DOWN, between stopping the old build and starting the new one. Running it under a
# live daemon moves files out from under a process still writing to them.
#
# What is left behind afterwards is quarantined, not orphaned: the old flat names are listed in the contract's
# RETIRED_WORKSPACE_STATE_DIRS, so a leftover `auth/` stays locked and unsearchable rather than being reclassified
# as ordinary workspace content, and the boot sweep deletes the rebuildable ones.
#
# Delete this file once every sandbox in the fleet has been through it. It documents a move, not a rule.
set -eu

cd "${1:-/work}/.intentic" || exit 1

mkdir -p config identity local records secrets

move() {
    # $1 = entry as it was spelled flat, $2 = its group folder. Absent entries are ordinary: no sandbox has all
    # forty-nine, and a store that was never written has nothing to move.
    [ -e "$1" ] || return 0
    mv "$1" "$2/"
    echo "  $1 -> $2/$1"
}

echo "config — reviewed and tracked"
for entry in automations.json capabilities.json capability-dismissals.json docs drafts \
    environment.custom.Dockerfile environment.d environment.Dockerfile extension-enablement.json \
    extension-settings.json extension-update-policy.json loop-designs.json personas personas.json \
    settings.json skills templates.json workflows.json workspace-extensions; do
    move "$entry" config
done

echo "records — what happened here"
for entry in approvals artifacts automation-runs.json chores extension-updates.json extension-usage.json \
    loops.json plugins secret-uses.json sessions thread-sessions.json verify.json webchat-installs.json \
    workflow-runs.json; do
    move "$entry" records
done

echo "local — rebuildable, and deletable"
for entry in .pnpm-store browser cache environment.approved.Dockerfile extensions newest-run.json \
    rule-firings.json runtime tmp verify; do
    move "$entry" local
done

echo "identity — who owns this sandbox"
for entry in control-tokens.json members.json owner.json workspace.json; do
    move "$entry" identity
done

echo "secrets — credentials"
for entry in auth ci.json; do
    move "$entry" secrets
done

echo "done."
