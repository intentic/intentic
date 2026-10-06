import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import pino from "pino";
import { testConfig } from "../../testing.js";
import { clearNewestRun } from "../../store/newest-run.js";
import { convergeState, resetStateStatus, type StateRoots } from "../../store/evolution/state-convergence.js";
import type { StructuralStep } from "../../store/evolution/state-steps.js";
import { stateRegroupStep } from "../../store/evolution/steps/state-regroup.js";
import { createAuthSlice } from "../auth-slice.js";
import { identityOffWorkspaceStep } from "./identity-off-workspace.js";

// A sandbox updated past the move keeps its owner, its roster and its programs' tokens; the copy left in the workspace
// is nobody's input from then on, including whatever a turn writes there later.

const logger = pino({ level: "silent" });
const made: string[] = [];

const volumes = async (): Promise<StateRoots> => {
    const base = await mkdtemp(join(tmpdir(), "identity-off-workspace-"));
    made.push(base);
    const roots = { workspace: join(base, "work"), history: join(base, "history"), auth: join(base, "work", "auth") };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    return roots;
};

const put = async (path: string, value: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`);
};

afterEach(async () => {
    clearNewestRun();
    resetStateStatus();
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const converge = (roots: StateRoots, steps: readonly StructuralStep[] = [identityOffWorkspaceStep]) =>
    convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [], steps });

const sliceOn = (roots: StateRoots) => createAuthSlice({ ...testConfig, historyRoot: roots.history }, roots.workspace, logger);

const identity = (roots: StateRoots, name: string): string => join(roots.workspace, STATE_DIR, "identity", name);

const ROSTER = { members: [{ email: "max@example.com", role: "maintainer" as const }] };
const TOKENS = { tokens: [{ id: "ci", label: "CI", scope: "drive", hash: sha256Hex("ict_ci"), createdAt: 1 }] };

test("a sandbox from before the move keeps its owner, roster and tokens, and the workspace copy stays for a rollback", async () => {
    const roots = await volumes();
    await put(identity(roots, "owner.json"), { email: "ada@example.com" });
    await put(identity(roots, "members.json"), ROSTER);
    await put(identity(roots, "control-tokens.json"), TOKENS);

    const outcome = await converge(roots);

    const slice = sliceOn(roots);
    expect(await slice.ownerEmail()).toBe("ada@example.com");
    expect(await slice.members.list()).toEqual(ROSTER.members);
    expect(await slice.controlTokens.resolve("ict_ci")).toEqual({ id: "ci", label: "CI", scope: "drive" });
    expect(outcome.plan?.steps.map(({ change }) => change)).toEqual([
        "copies .intentic/identity/owner.json to identity/owner.json on the history volume",
        "copies .intentic/identity/members.json to identity/members.json on the history volume",
        "copies .intentic/identity/control-tokens.json to identity/control-tokens.json on the history volume",
    ]);
    expect(JSON.parse(await readFile(identity(roots, "members.json"), "utf8"))).toEqual(ROSTER);

    expect((await converge(roots)).plan?.steps).toEqual([]);
});

test("a roster a turn writes at the old address after the move is never brought over", async () => {
    const roots = await volumes();
    await put(identity(roots, "members.json"), ROSTER);
    await converge(roots);

    await put(identity(roots, "members.json"), { members: [...ROSTER.members, { email: "mallory@example.com", role: "maintainer" }] });
    await put(identity(roots, "owner.json"), { email: "mallory@example.com" });
    expect((await converge(roots)).plan?.steps).toEqual([]);

    const slice = sliceOn(roots);
    expect(await slice.members.list()).toEqual(ROSTER.members);
    expect(await slice.ownerEmail()).toBeUndefined();
});

test("a sandbox with nothing to move starts an empty roster, so what a turn plants later stays where it was put", async () => {
    const roots = await volumes();
    expect((await converge(roots)).plan?.steps.map(({ change }) => change)).toEqual(["starts identity/members.json on the history volume with nobody on it"]);

    await put(identity(roots, "members.json"), { members: [{ email: "mallory@example.com", role: "maintainer" }] });
    await put(identity(roots, "control-tokens.json"), TOKENS);
    await converge(roots);

    const slice = sliceOn(roots);
    expect(await slice.members.list()).toEqual([]);
    expect(await slice.controlTokens.resolve("ict_ci")).toBeUndefined();
});

// The regroup is a layout step and this one is not, so a sandbox from before the 2026-08-19 regroup crosses both moves
// on one boot.
test("a flat state dir from before the regroup arrives on the history volume in one boot", async () => {
    const roots = await volumes();
    await put(join(roots.workspace, STATE_DIR, "owner.json"), { email: "ada@example.com" });
    await put(join(roots.workspace, STATE_DIR, "members.json"), ROSTER);

    await converge(roots, [stateRegroupStep, identityOffWorkspaceStep]);

    const slice = sliceOn(roots);
    expect(await slice.ownerEmail()).toBe("ada@example.com");
    expect(await slice.members.list()).toEqual(ROSTER.members);
});
