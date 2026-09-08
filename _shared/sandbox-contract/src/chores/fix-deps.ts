// Automations catalogue template for repairing dependency breakage; nothing creates it until the owner picks it. Wakes
// on `deps.broken`, whose payload carries `deps.project`, `deps.command`, `deps.exitCode`, `deps.logTail` and
// `deps.attempt` (consecutive reds since the last green). Once created, each fire holds for `holdForSeconds` before
// starting, cancellable, never while another agent is mid-turn.
export const FIX_DEPS_AUTOMATION = {
    id: "fix-dependency-breakage",
    title: "Fix what a dependency change broke",
    event: "deps.broken",
    holdForSeconds: 60,
    guard: `test "$(printf '%s' "$AUTOMATION_PAYLOAD" | jq -r '.deps.attempt // 1')" -le 2`,
    guardNote: "stops after 2 attempts",
    prompt:
        "A landed change drifted this workspace's dependencies; the daemon reinstalled them and ran the project's own checks, " +
        "and they failed. The payload names the project (`deps.project`), the check command (`deps.command`), how it exited " +
        "(`deps.exitCode`) and the tail of its output (`deps.logTail`); the full log is in the project's `--verify` terminal.\n\n" +
        "Re-run the check yourself to see the failure first-hand, then fix the ROOT CAUSE. That usually means updating call " +
        "sites, types or tests to match what actually changed: never loosening or deleting the checks, pinning or downgrading " +
        "dependencies just to silence them, or editing generated files. If the breakage needs a decision only the owner can " +
        "make (an intentional breaking upgrade, a license change, a dependency that should be dropped), stop and say exactly " +
        "that instead of guessing.\n\n" +
        "Finish by running the same check command and reporting what was broken, what you changed, and whether it is green now.",
} as const;
