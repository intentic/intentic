import type { HostScopes } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ScopeError } from "../policy.js";
import { asSandboxOp, listSandboxes, manageSandbox, rowsFrom, sandboxesFrom } from "./sandboxes.js";

const scopes = (overrides: Partial<HostScopes> = {}): HostScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
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

test("a sandbox with no sidecar at all has no tunnelRunning key — absent and false are different facts", () => {
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

test("managing is refused by the sandboxes switch alone — a full shell does not imply it", async () => {
    await expect(manageSandbox("stop", "work", scopes({ sandboxes: "off" }))).rejects.toThrow(/Manage sandboxes on this computer/);
});

test("an op outside start/stop/restart is rejected before anything is looked at", () => {
    expect(() => asSandboxOp("kill")).toThrow(/start.*stop.*restart/);
    expect(asSandboxOp("restart")).toBe("restart");
});
