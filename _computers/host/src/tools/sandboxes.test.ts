import type { HostScopes } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ScopeError } from "../policy.js";
import {
    icCandidates,
    icRemoveArgs,
    icRunnerArgs,
    icSwapArgs,
    listSandboxes,
    manageSandbox,
    removeSandbox,
    runnerFlow,
    rowsFrom,
    sandboxesFrom,
    sandboxLogs,
    swapSandbox,
    tailSandboxLogs,
} from "./sandboxes.js";

const scopes = (overrides: Partial<HostScopes> = {}): HostScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    sandboxRemove: "on",
    ...overrides,
});

const row = (names: string, state = "running") => ({ names, state, image: "ghcr.io/intentic/sandbox:1" });

test("docker's json-lines output is read row by row, skipping whatever else the stream carried", () => {
    const stdout = [
        "WARNING: something about the daemon",
        JSON.stringify({ Names: "intentic-sandbox-work", State: "running", Image: "img" }),
        "{ not json at all }",
        JSON.stringify({ NotNames: "x" }),
    ].join("\n");
    expect(rowsFrom(stdout)).toEqual([{ names: "intentic-sandbox-work", state: "running", image: "img" }]);
});

/* The sidecar rule, moved here from the daemon so the machine is the one producer of "what runs on me": a name is
 * only a sidecar when the workspace container it would belong to exists, because a user's own subdomain may
 * legitimately BE `tunnel-something`. */
test("a tunnel sidecar folds into its sandbox instead of being a sandbox", () => {
    const boxes = sandboxesFrom([row("intentic-sandbox-work"), row("intentic-sandbox-tunnel-work", "exited")]);
    expect(boxes).toEqual([
        { slug: "work", container: "intentic-sandbox-work", running: true, image: "ghcr.io/intentic/sandbox:1", tunnelRunning: false },
    ]);
});

test("a sandbox with no sidecar at all has no tunnelRunning key: absent and false are different facts", () => {
    const boxes = sandboxesFrom([row("intentic-sandbox-work")]);
    expect(boxes).toHaveLength(1);
    expect("tunnelRunning" in (boxes[0] ?? {})).toBe(false);
});

test("a workspace whose own name starts with tunnel- is a sandbox, not somebody's sidecar", () => {
    const boxes = sandboxesFrom([row("intentic-sandbox-tunnel-lab")]);
    expect(boxes.map((box) => box.slug)).toEqual(["tunnel-lab"]);
});

test("listing is refused only when NEITHER grant covers it, naming the manage switch", async () => {
    await expect(listSandboxes(scopes({ shell: "off", sandboxes: "off" }))).rejects.toThrow(ScopeError);
    await expect(listSandboxes(scopes({ shell: "off", sandboxes: "off" }))).rejects.toThrow(/Manage sandboxes on this computer/);
});

test("managing is refused by the sandboxes switch alone: a full shell does not imply it", async () => {
    await expect(manageSandbox("stop", "work", scopes({ sandboxes: "off" }))).rejects.toThrow(/Manage sandboxes on this computer/);
});

/* ---- the flows that run `ic` ---- */

/* The argv, both platforms' worth of risk in one place: an argument that regresses to a different position binds
 * to a different parameter and fails silently, much later, as something else. */
test("each swap builds the argv ic actually takes", () => {
    expect(icSwapArgs("update", "work", undefined)).toEqual(["sandbox", "update", "work"]);
    expect(icSwapArgs("rollback", "work", undefined)).toEqual(["sandbox", "rollback", "work"]);
    expect(icSwapArgs("rebuild", "work", "deadbeef")).toEqual(["sandbox", "rebuild", "work", "deadbeef"]);
    // `prepare` is the one that must NEVER reach `update`: the whole reason it is offered is that it does not
    // restart the sandbox, and a verb that slipped would recreate a container someone was told nothing about.
    expect(icSwapArgs("prepare", "work", undefined)).toEqual(["sandbox", "prepare", "work"]);
    // A hash tagging along changes nothing: prepare re-applies whatever the owner has approved, and taking
    // a digest here would silently turn it into a rebuild.
    expect(icSwapArgs("prepare", "work", "deadbeef")).toEqual(["sandbox", "prepare", "work"]);
});

test("a rebuild without the approved digest is refused rather than built against nothing", () => {
    // The hash is the trust anchor: only content that still hashes to what the owner reviewed is ever built, so
    // a missing one has to stop the flow rather than fall through to an unpinned rebuild.
    expect(() => icSwapArgs("rebuild", "work", undefined)).toThrow(/hash.*required/i);
    expect(() => icSwapArgs("rebuild", "work", "")).toThrow(/approved/);
});

test("removal confirms itself, because there is no terminal on this end to answer ic's prompt", () => {
    expect(icRemoveArgs("work")).toEqual(["sandbox", "remove", "work", "-y"]);
});

/* The RUNNER argv, which carries something no other flow does: a single-use pairing. An argument lost here is
 * invisible in the worst way, the container boots, dials, is refused, and reads as a network problem. */
test("a runner is started with its parent's address and its pairing, and removed without a prompt", () => {
    expect(icRunnerArgs("runner-up", "rig", "https://sandbox-x.intentic.dev", "pair-1")).toEqual([
        "runner",
        "up",
        "https://sandbox-x.intentic.dev",
        "--pair",
        "pair-1",
        "--name",
        "rig",
    ]);
    expect(icRunnerArgs("runner-remove", "rig", undefined, undefined)).toEqual(["runner", "remove", "rig", "-y"]);
});

test("a runner start with no way home is refused before anything is spawned", () => {
    // A container with no parent URL, or none of the pairing that gets it enrolled, is a container somebody
    // has to go and clean up by hand: it can never become a runner, and it says nothing about why.
    expect(() => icRunnerArgs("runner-up", "rig", "", "pair-1")).toThrow(/address/i);
    expect(() => icRunnerArgs("runner-up", "rig", "https://sandbox-x.intentic.dev", "")).toThrow(/pairing/i);
});

test("both runner ops ride the sandboxes switch, and removal does NOT take the removal one", async () => {
    // A runner's /work is a mirror of the parent's git, so removing it destroys nothing the parent still has:
    // the switch that guards somebody's workspace is not the switch that guards this.
    const off = scopes({ sandboxes: "off", sandboxRemove: "on" });
    await expect(runnerFlow("runner-up", "rig", "https://x", "p", {}, off, () => undefined)).rejects.toBeInstanceOf(ScopeError);
    await expect(runnerFlow("runner-remove", "rig", undefined, undefined, {}, off, () => undefined)).rejects.toBeInstanceOf(ScopeError);
});

/* The parent's SHAPE files, appended only when they exist: the definition seed, and the overlay pinned to its
 * hash. The hash is the trust anchor — an overlay riding without one would ask this machine to build content
 * nobody's approval pins — so the pair is enforced where the argv is built, before anything spawns. */
test("shape files ride the runner-up argv, and an overlay without its hash is refused", () => {
    expect(icRunnerArgs("runner-up", "rig", "https://x", "p", { definitionFile: "/tmp/d/sandbox.toml" })).toEqual([
        "runner",
        "up",
        "https://x",
        "--pair",
        "p",
        "--name",
        "rig",
        "--definition-file",
        "/tmp/d/sandbox.toml",
    ]);
    expect(icRunnerArgs("runner-up", "rig", "https://x", "p", { overlayFile: "/tmp/d/overlay.Dockerfile", environmentHash: "a".repeat(64) })).toEqual([
        "runner",
        "up",
        "https://x",
        "--pair",
        "p",
        "--name",
        "rig",
        "--overlay-file",
        "/tmp/d/overlay.Dockerfile",
        "--environment-hash",
        "a".repeat(64),
    ]);
    expect(() => icRunnerArgs("runner-up", "rig", "https://x", "p", { overlayFile: "/tmp/d/overlay.Dockerfile" })).toThrow(/hash/);
    expect(() => icRunnerArgs("runner-up", "rig", "https://x", "p", { environmentHash: "a".repeat(64) })).toThrow(/overlay/);
});

/* The agent's own install is preferred over whatever is on PATH, per platform: the same rule the desktop app
 * applies to the sync agent, and for the same reason: a developer's global copy answers on the machine where this
 * was written and nothing answers on a real user's. */
test("ic is looked for where the installers put it before PATH is tried", () => {
    expect(icCandidates("linux", "/home/ada")).toEqual(["/home/ada/.intentic/ic/bin/ic", "/usr/local/bin/ic", "ic"]);
    expect(icCandidates("win32", "C:\\Users\\Ada")).toEqual(["C:\\Users\\Ada\\.intentic\\ic\\bin\\ic.exe", "ic.exe"]);
});

test("a machine with no home still tries the rest", () => {
    expect(icCandidates("linux", undefined)).toEqual(["/usr/local/bin/ic", "ic"]);
    expect(icCandidates("win32", undefined)).toEqual(["ic.exe"]);
});

test("swapping is refused by the sandboxes switch, like managing", async () => {
    await expect(swapSandbox("update", "work", undefined, scopes({ sandboxes: "off" }), () => {})).rejects.toThrow(
        /Manage sandboxes on this computer/,
    );
});

/* The point of the separate switch, asserted: a user who delegated the fleet did not thereby agree to lose one
 * of it. Granting `sandboxes` must not be enough to remove. */
test("removal takes its own switch: managing sandboxes does not imply destroying one", async () => {
    await expect(removeSandbox("work", scopes({ sandboxRemove: "off" }), () => {})).rejects.toThrow(/Remove sandboxes from this computer/);
    await expect(removeSandbox("work", scopes({ sandboxes: "on", sandboxRemove: "off" }), () => {})).rejects.toThrow(ScopeError);
});

test("reading a log is covered by either grant, like listing", async () => {
    await expect(sandboxLogs("work", 50, scopes({ shell: "off", sandboxes: "off" }))).rejects.toThrow(/Manage sandboxes on this computer/);
});

/* The Computers view's Logs button reaches the same reading through the flow door, so it is gated the same way
 *: a grant that answers `sandbox_logs` for a model answers the button for its owner, and neither answers when
 * both switches are off. Asserted because this one is a READ travelling a route whose other seven ops write. */
test("the log flow is gated exactly like the log tool it shares a reading with", async () => {
    await expect(tailSandboxLogs("work", scopes({ shell: "off", sandboxes: "off" }), () => {})).rejects.toThrow(/Manage sandboxes on this computer/);
});
