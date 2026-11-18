import { tmpdir } from "node:os";
import type { Fence } from "@intentic/sandbox-contract/policy/fence-paths";
import type { ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import { capRole, turnRole } from "../roles/roles.js";
import { jsExecutionPlanOf, nodeArgs, RECORD_READ_ROOTS } from "./js-runtime.js";

/* The PURE half of the backend: the plan a card's access yields (every ceiling combination is a table row) and the argv a
   plan means. The ceiling and the folders are what an access profile listing the card holds it to. */

const roleWith = (ceiling: ToolCeiling, roleFence?: Fence) =>
    capRole(
        turnRole({
            roles: [{ id: "card", capabilities: [] }],
            actsAs: "card",
            unattended: false,
            roleFence,
        }),
        ceiling,
    );

const TREE = { root: "/work", cwd: "/work/app" };
const ENV = { GITHUB_TOKEN_GITHUB: "t" };

test("a full-powers card gets the whole turn tree, writable, spawn allowed, and tmp and the daemon's records readable", () => {
    const plan = jsExecutionPlanOf(roleWith({}), TREE, ENV);
    expect(plan).toEqual({
        cwd: "/work/app",
        env: ENV,
        readRoots: ["/work", tmpdir(), ...RECORD_READ_ROOTS],
        writeRoots: ["/work"],
        allowSpawn: true,
    });
});

test("the code shelf off means no plan at all: absence, not refusal", () => {
    expect(jsExecutionPlanOf(roleWith({ code: false }), TREE, ENV)).toBeUndefined();
    // And so does a named-but-missing card, whose resolver answers every shelf shut.
    const missing = turnRole({ roles: [], actsAs: "gone", unattended: false });
    expect(jsExecutionPlanOf(missing, TREE, ENV)).toBeUndefined();
});

test("the files answer scopes the filesystem: read loses writes, none loses the filesystem entirely", () => {
    const read = jsExecutionPlanOf(roleWith({ files: "read" }), TREE, ENV);
    expect(read?.readRoots).toEqual(["/work", tmpdir(), ...RECORD_READ_ROOTS]);
    expect(read?.writeRoots).toEqual([]);
    const none = jsExecutionPlanOf(roleWith({ files: "none" }), TREE, ENV);
    expect(none?.readRoots).toEqual([]);
    expect(none?.writeRoots).toEqual([]);
});

test("no shell means no spawning: code-without-bash cannot become bash", () => {
    expect(jsExecutionPlanOf(roleWith({ shell: false }), TREE, ENV)?.allowSpawn).toBe(false);
});

// The records are readable by a shell already; a card held without one, or fenced to folders, gains no reach through code.
test("the daemon's records are read-only, and only for an unfenced card that has a shell", () => {
    expect(RECORD_READ_ROOTS.some((root) => root.endsWith("/agent-auth") || root.endsWith("/translator"))).toBe(false);
    const full = jsExecutionPlanOf(roleWith({}), TREE, ENV);
    expect(full?.writeRoots.some((root) => RECORD_READ_ROOTS.includes(root))).toBe(false);
    expect(jsExecutionPlanOf(roleWith({ shell: false }), TREE, ENV)?.readRoots).toEqual(["/work", tmpdir()]);
    const fenced = jsExecutionPlanOf(roleWith({}, ["app"]), TREE, ENV);
    expect(fenced?.readRoots).toEqual(["/work/app", tmpdir()]);
});

test("the folders the card's access fences it to become the roots, resolved against the turn root, escapers dropped", () => {
    const plan = jsExecutionPlanOf(roleWith({}, ["app", "../outside", "libs/shared"]), TREE, ENV);
    expect(plan?.readRoots).toEqual(["/work/app", "/work/libs/shared", tmpdir()]);
    expect(plan?.writeRoots).toEqual(["/work/app", "/work/libs/shared"]);
});

test("the argv is exactly the plan: one permission flag per grant, stdin as the module", () => {
    expect(nodeArgs({ readRoots: ["/a"], writeRoots: [], allowSpawn: false })).toEqual([
        "--permission",
        "--allow-fs-read=/a",
        "--input-type=module",
        "-",
    ]);
    expect(nodeArgs({ readRoots: ["/a", "/b"], writeRoots: ["/a"], allowSpawn: true })).toEqual([
        "--permission",
        "--allow-fs-read=/a",
        "--allow-fs-read=/b",
        "--allow-fs-write=/a",
        "--allow-child-process",
        "--disable-warning=SecurityWarning",
        "--input-type=module",
        "-",
    ]);
});
