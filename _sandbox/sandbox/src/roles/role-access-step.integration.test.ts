import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type JsonValue, parseJsonOr } from "@intentic/base/json";
import pino from "pino";
import { accessProfilesDocument } from "../auth/principals/access-profiles-store.js";
import { areasDocument } from "../areas/areas-store.js";
import { capabilitiesDocument } from "../capabilities/capabilities-store.js";
import { sandboxSecretsDocument } from "../secrets/sandbox-secrets.js";
import { clearNewestRun } from "../store/newest-run.js";
import { convergeState, resetStateStatus, type StateRoots } from "../store/evolution/state-convergence.js";
import { roleAccessStep } from "./role-access-step.js";
import { rolesDocument } from "./roles-store.js";

// A card's own limits survive the update as access: a profile on the history volume lists the card, so a conversation
// wearing it reaches no more than it did, and no card answer can lift it any more.

const logger = pino({ level: "silent" });
const made: string[] = [];

const volumes = async (): Promise<StateRoots> => {
    const base = await mkdtemp(join(tmpdir(), "role-access-"));
    made.push(base);
    const roots = { workspace: join(base, "work"), history: join(base, "history"), auth: join(base, "auth") };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    return roots;
};

afterEach(async () => {
    clearNewestRun();
    resetStateStatus();
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const converge = (roots: StateRoots) => convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [], steps: [roleAccessStep] });

const put = async (path: string, value: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`);
};
const json = async (path: string): Promise<JsonValue> => parseJsonOr(await readFile(path, "utf8"), null);

const paths = (roots: StateRoots) => ({
    roles: join(roots.workspace, rolesDocument.path),
    profiles: join(roots.history, accessProfilesDocument.path),
    areas: join(roots.workspace, areasDocument.path),
    capabilities: join(roots.workspace, capabilitiesDocument.path),
    secrets: join(roots.auth, sandboxSecretsDocument.path),
});

test("a read-only card fenced to one folder becomes a profile, an area and a card that opens there", async () => {
    const roots = await volumes();
    const at = paths(roots);
    await put(at.roles, [
        { id: "reviewer", label: "Reviewer", capabilities: [], powers: { files: "read", shell: false, connectors: ["github"] }, workspace: { folders: ["app"] } },
        { id: "writer", label: "Writer", capabilities: ["reddit-work"] },
    ]);
    await put(at.capabilities, [
        { id: "github", kind: "cli" },
        { id: "linear", kind: "cli" },
        { id: "reddit-work", kind: "browser" },
    ]);
    await put(at.secrets, { OPENAI_KEY: "x" });
    await converge(roots);

    expect(await json(at.roles)).toEqual([
        { id: "reviewer", label: "Reviewer", capabilities: [], workspace: { startIn: "app" } },
        { id: "writer", label: "Writer", capabilities: ["reddit-work"] },
    ]);
    expect(await json(at.areas)).toEqual([{ id: "role-reviewer", label: "Reviewer (role)", folders: ["app"] }]);
    expect(await json(at.profiles)).toEqual([
        {
            id: "role-reviewer",
            label: "Reviewer (role)",
            brief: "What the role Reviewer may reach, carried from its own card.",
            roles: ["reviewer"],
            areas: ["role-reviewer"],
            // Linear was left out by the card's connector list; the signed-in account is the card's own to decide.
            credentials: { capabilities: ["github", "reddit-work"], secrets: ["OPENAI_KEY"] },
            tools: { files: "read", shell: false },
        },
    ]);
});

test("a card that limited nothing loses its empty fields and gets no profile; an existing area with its folders is reused", async () => {
    const roots = await volumes();
    const at = paths(roots);
    await put(at.roles, [
        { id: "open", capabilities: [], powers: {} },
        { id: "fenced", capabilities: [], workspace: { startIn: "docs", folders: ["docs", "site"] } },
    ]);
    await put(at.areas, [{ id: "web", folders: ["site", "docs"] }]);
    await put(at.profiles, [{ id: "role-fenced" }]);
    await converge(roots);

    expect(await json(at.roles)).toEqual([
        { id: "open", capabilities: [] },
        { id: "fenced", capabilities: [], workspace: { startIn: "docs" } },
    ]);
    expect(await json(at.areas)).toEqual([{ id: "web", folders: ["site", "docs"] }]);
    // The id it would take is someone else's already.
    expect(await json(at.profiles)).toEqual([
        { id: "role-fenced" },
        {
            id: "role-fenced-2",
            label: "fenced (role)",
            brief: "What the role fenced may reach, carried from its own card.",
            roles: ["fenced"],
            areas: ["web"],
        },
    ]);
});

test("a sandbox with nothing to move is left untouched", async () => {
    const roots = await volumes();
    const at = paths(roots);
    await put(at.roles, [{ id: "writer", capabilities: [] }]);
    const plan = await roleAccessStep.plan({
        roots,
        read: async (path) => readFile(path, "utf8").catch(() => undefined),
        list: async () => [],
        kind: async () => undefined,
    });
    expect(plan).toBeUndefined();
});
