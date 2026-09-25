import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import pino from "pino";
import { automationsDocument, automationsRelocationStep, fileAutomationsStore } from "../automations/automations-store.js";
import { capabilitiesDocument, fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import { fileSandboxSettingsStore, settingsDocument } from "../settings/settings-store.js";
import { stateRelPath } from "../state-paths.js";
import { workflowGateTokensStep, workflowsDocument } from "../workflows/workflows-store.js";
import type { DocumentSpec } from "./documents.js";
import { clearNewestRun } from "./newest-run.js";
import { convergeState, resetStateStatus, type StateRoots } from "./state-convergence.js";
import type { StructuralStep } from "./state-steps.js";
import { stateRegroupStep } from "./steps/state-regroup.js";

// The conversions each document declares for the breaks its history holds, run over workspaces laid out the way the
// releases that wrote them left them, and read back through today's stores.

const logger = pino({ level: "silent" });
const made: string[] = [];

const volumes = async (): Promise<StateRoots> => {
    const base = await mkdtemp(join(tmpdir(), "historical-conversions-"));
    made.push(base);
    const roots = { workspace: join(base, "work"), history: join(base, "history"), auth: join(base, "work", "auth") };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
    return roots;
};

const put = async (path: string, value: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`);
};

const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

afterEach(async () => {
    clearNewestRun();
    resetStateStatus();
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const converge = (roots: StateRoots, documents: readonly DocumentSpec[], steps: readonly StructuralStep[]) =>
    convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents, steps });

test("a flat state dir from before the regroup comes up grouped, config copied and records moved", async () => {
    const roots = await volumes();
    const flat = join(roots.workspace, STATE_DIR);
    await put(join(flat, "settings.json"), { hashlineEdits: true });
    await put(join(flat, "identities.json"), [{ id: "writer", label: "Writer" }]);
    await put(join(flat, "bridge-tokens.json"), { tokens: [] });
    await put(join(flat, "drafts", "post.json"), { title: "hello" });
    await put(join(flat, "sessions", "claude", "one.jsonl"), { line: 1 });
    await put(join(flat, "attachments", "a", "b.txt"), "attached");

    const outcome = await converge(roots, [], [stateRegroupStep]);

    expect(await json(join(roots.workspace, stateRelPath(".intentic/config/settings.json")))).toEqual({ hashlineEdits: true });
    expect(await json(join(roots.workspace, stateRelPath(".intentic/config/personas.json")))).toEqual([{ id: "writer", label: "Writer" }]);
    expect(await json(join(roots.workspace, stateRelPath(".intentic/identity/control-tokens.json")))).toEqual({ tokens: [] });
    expect(await readdir(join(roots.workspace, stateRelPath(".intentic/config/approvals/")))).toEqual(["post.json"]);
    expect(await readdir(join(roots.workspace, stateRelPath(".intentic/records/sessions/claude/")))).toEqual(["one.jsonl"]);
    expect(await json(join(roots.workspace, stateRelPath(".intentic/records/artifacts/", "attachments", "a", "b.txt")))).toBe("attached");
    // Config was copied, so a rollback to a flat build still finds it; records were moved.
    expect(await json(join(flat, "settings.json"))).toEqual({ hashlineEdits: true });
    await expect(readdir(join(flat, "sessions"))).rejects.toThrow("ENOENT");
    expect(outcome.plan?.steps.map(({ change }) => change)).toContain("moves sessions to records/sessions");

    const again = await converge(roots, [], [stateRegroupStep]);
    expect(again.plan?.steps).toEqual([]);
});

test("the grouped address wins when the owner set things up again, and a directory at both gets what it lacks", async () => {
    const roots = await volumes();
    const flat = join(roots.workspace, STATE_DIR);
    await put(join(flat, "settings.json"), { hashlineEdits: true });
    await put(join(roots.workspace, stateRelPath(".intentic/config/settings.json")), { hashlineEdits: false });
    await put(join(flat, "skills", "old", "SKILL.md"), "old skill");
    await put(join(roots.workspace, stateRelPath(".intentic/config/skills/"), "new", "SKILL.md"), "new skill");

    await converge(roots, [], [stateRegroupStep]);
    expect(await json(join(roots.workspace, stateRelPath(".intentic/config/settings.json")))).toEqual({ hashlineEdits: false });
    expect((await readdir(join(roots.workspace, stateRelPath(".intentic/config/skills/")))).toSorted()).toEqual(["new", "old"]);
});

test("settings a withdrawn rule once made unreadable read again, the rule gone and personaRouting a boolean", async () => {
    const roots = await volumes();
    const path = join(roots.workspace, settingsDocument.path);
    await put(path, {
        personaRouting: "suggest",
        rules: [
            { id: "push", label: "Before a push", moment: "push.starting", action: { kind: "verdict", verdict: "hold" }, enabled: true },
            { id: "nudge", label: "Nudge", moment: "turn.ending", action: { kind: "instruct", text: "keep going" }, enabled: true },
            { id: "land", label: "Land", moment: "agent.finished", action: { kind: "verdict", verdict: "allow" }, enabled: true },
        ],
    });
    // Read before converging: the store converts on read, so the file is usable at once.
    const settings = await fileSandboxSettingsStore(path).load();
    expect(settings.unreadable).toBe(false);
    expect(settings.settings.personaRouting).toBe(true);
    expect(settings.settings.rules.map((rule) => rule.id)).toEqual(["land"]);

    const outcome = await converge(roots, [settingsDocument], []);
    expect(outcome.plan?.steps).toEqual([
        { document: settingsDocument.path, change: "drops rules at a withdrawn moment or with a withdrawn action (push.starting, instruct, three built-in checks)" },
        { document: settingsDocument.path, change: "converts personaRouting from its old values", detail: '"suggest" became true' },
    ]);
    expect(await json(path)).toMatchObject({ personaRouting: true, rules: [{ id: "land" }] });
});

test("a capability of the kind device was once called becomes a device, and withdrawn connections are retired", async () => {
    const roots = await volumes();
    const path = join(roots.workspace, capabilitiesDocument.path);
    // The retired kind, read off the conversion that maps it rather than spelled here a second time.
    const [retiredKind = ""] = Object.keys(capabilitiesDocument.history[0].mapping);
    await put(path, [
        { id: "laptop", kind: retiredKind, config: { platform: "linux" } },
        { id: "db", kind: "service", config: { service: "postgres" } },
        { id: "gh", kind: "cli", config: { provider: "github" } },
    ]);
    expect((await fileCapabilitiesStore(path).list()).map(({ id, kind }) => `${id}:${kind}`)).toEqual(["laptop:device", "gh:cli"]);

    await converge(roots, [capabilitiesDocument], []);
    expect(await json(path)).toEqual([
        { id: "laptop", kind: "device", config: { platform: "linux" } },
        { id: "gh", kind: "cli", config: { provider: "github" } },
    ]);
    expect(await json(join(roots.workspace, stateRelPath(".intentic/records/conversions.json")))).toMatchObject([
        {
            steps: expect.arrayContaining([
                {
                    document: capabilitiesDocument.path,
                    change: "retires a service or integration connection, withdrawn in favour of CLI connectors",
                    detail: '{"id":"db","kind":"service","config":{"service":"postgres"}}',
                },
            ]),
        },
    ]);
});

test("an automation that named a model gets a one-rung ladder; its runs and webhook token move where they live now", async () => {
    const roots = await volumes();
    const manifest = join(roots.workspace, automationsDocument.path);
    const base = { name: "Nightly", prompt: "tidy up", enabled: true, trigger: { kind: "event", token: "tok-123" } };
    await put(manifest, [
        { id: "nightly", ...base, agent: "codex", model: "gpt-5", runs: [{ at: 1, outcome: "ok" }] },
        { id: "unnamed", ...base, trigger: { kind: "event" } },
    ]);

    await converge(roots, [automationsDocument], [automationsRelocationStep]);

    const stored = (await json(manifest)) as { id: string; models?: unknown; trigger: unknown; runs?: unknown }[];
    expect(stored[0]).toMatchObject({ id: "nightly", models: [{ provider: "codex", model: "gpt-5" }], trigger: { kind: "event" } });
    expect(stored[0]).not.toHaveProperty("runs");
    expect(stored[0]).not.toHaveProperty("model");
    // Named no model: nothing can choose one for it, so it stays for its owner, skipped by the store rather than
    // sinking the others.
    expect(stored[1]).not.toHaveProperty("models");
    expect(await json(join(roots.workspace, stateRelPath(".intentic/secrets/doors.json")))).toEqual({ automation: { nightly: "tok-123" } });
    const listed = await fileAutomationsStore(manifest, join(roots.workspace, stateRelPath(".intentic/records/automation-runs.json"))).list();
    expect(listed.map(({ id }) => id)).toEqual(["nightly"]);
});

test("a release gate's token moves out of the tracked design into the door store", async () => {
    const roots = await volumes();
    const designs = join(roots.workspace, workflowsDocument.path);
    await put(designs, [{ id: "ship", name: "Ship", gate: { passes: ["pass"], token: "gate-9" } }]);
    await converge(roots, [workflowsDocument], [workflowGateTokensStep]);
    expect(await json(designs)).toEqual([{ id: "ship", name: "Ship", gate: { passes: ["pass"] } }]);
    expect(await json(join(roots.workspace, stateRelPath(".intentic/secrets/doors.json")))).toEqual({ gate: { ship: "gate-9" } });
});
