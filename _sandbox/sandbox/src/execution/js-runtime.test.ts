import { tmpdir } from "node:os";
import { type Persona, PersonaPowersSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { turnPersona } from "../personas/personas.js";
import { JS_TIMEOUT_DEFAULT_S, jsExecutionPlanOf, nodeArgs } from "./js-runtime.js";

/* The PURE half of the backend: the plan a card yields (every powers combination is a table row) and the argv
 * a plan means. The runner honouring them spawns real `node` subprocesses and lives in
 * js-runtime.integration.test.ts: the permission flags ARE the fence, and only the real runtime can vouch
 * for those. */

const personaWith = (powers: Record<string, unknown>, extra: Partial<Persona> = {}) =>
    turnPersona({
        personas: [{ id: "card", capabilities: [], powers: PersonaPowersSchema.parse(powers), ...extra }],
        actsAs: "card",
        unattended: false,
    });

const TREE = { root: "/work", cwd: "/work/app" };
const ENV = { GITHUB_TOKEN_GITHUB: "t" };

test("a full-powers card gets the whole turn tree, writable, spawn allowed, and tmp readable", () => {
    const plan = jsExecutionPlanOf(personaWith({}), TREE, ENV);
    expect(plan).toEqual({
        cwd: "/work/app",
        env: ENV,
        readRoots: ["/work", tmpdir()],
        writeRoots: ["/work"],
        allowSpawn: true,
    });
});

test("the code shelf off means no plan at all: absence, not refusal", () => {
    expect(jsExecutionPlanOf(personaWith({ code: false }), TREE, ENV)).toBeUndefined();
    // And so does a named-but-missing card, whose resolver answers every shelf shut.
    const missing = turnPersona({ personas: [], actsAs: "gone", unattended: false });
    expect(jsExecutionPlanOf(missing, TREE, ENV)).toBeUndefined();
});

test("the files answer scopes the filesystem: read loses writes, none loses the filesystem entirely", () => {
    const read = jsExecutionPlanOf(personaWith({ files: "read" }), TREE, ENV);
    expect(read?.readRoots).toEqual(["/work", tmpdir()]);
    expect(read?.writeRoots).toEqual([]);
    const none = jsExecutionPlanOf(personaWith({ files: "none" }), TREE, ENV);
    expect(none?.readRoots).toEqual([]);
    expect(none?.writeRoots).toEqual([]);
});

test("no shell means no spawning: code-without-bash cannot become bash", () => {
    expect(jsExecutionPlanOf(personaWith({ shell: false }), TREE, ENV)?.allowSpawn).toBe(false);
});

test("the card's folders become the roots, resolved against the turn root, escapers dropped", () => {
    const plan = jsExecutionPlanOf(personaWith({}, { workspace: { folders: ["app", "../outside", "libs/shared"] } }), TREE, ENV);
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

// Pinned so the tool description and the schema bound cannot drift apart silently.
test("the default timeout is the Bash tool's own", () => {
    expect(JS_TIMEOUT_DEFAULT_S).toBe(120);
});
