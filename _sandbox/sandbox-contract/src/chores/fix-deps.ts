/* THE FIX CHORE, the template for opting into dependency-breakage repair.
 *
 * The automations catalogue offers it as a recipe; nothing creates it until the owner picks that template.
 *
 * It wakes on `deps.broken`, the dependency verifier's edge event: a landed change drifted the installed
 * dependencies, the daemon reinstalled them, ran the tree's own checks, and they came back red. The payload
 * is that event: `deps.project` is the project whose checks failed, `deps.command` the exact command that
 * judged it, `deps.exitCode` and `deps.logTail` what it said, and `deps.attempt` which consecutive red this
 * is since the last green.
 *
 * THE GUARD IS THE LOOP CAP, and it lives in guard shell, one visible, owner-editable line, rather than in
 * daemon code, because whoever tunes "how many tries before a human looks" must be able to see the number.
 * Attempt 1 is the breakage, attempt 2 is one landed fix that still failed; past that the loop stops and the
 * standing red is the owner's to read (the activity feed has been narrating every step).
 *
 * THE HOLD IS THE SECOND CHANCE. After the owner creates the automation from its template, each fire is held,
 * visibly, for this many seconds on the Automations page before it starts, cancellable the whole way, and it
 * never starts while another agent is mid-turn. */
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
        "sites, types or tests to match what actually changed — never loosening or deleting the checks, pinning or downgrading " +
        "dependencies just to silence them, or editing generated files. If the breakage needs a decision only the owner can " +
        "make (an intentional breaking upgrade, a license change, a dependency that should be dropped), stop and say exactly " +
        "that instead of guessing.\n\n" +
        "Finish by running the same check command and reporting what was broken, what you changed, and whether it is green now.",
} as const;
