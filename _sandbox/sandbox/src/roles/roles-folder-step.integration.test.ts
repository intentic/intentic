import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import pino from "pino";
import { clearNewestRun } from "../store/newest-run.js";
import { convergeState, resetStateStatus, type StateRoots } from "../store/evolution/state-convergence.js";
import { roleKitsFolderStep } from "./roles-folder-step.js";

// Personas were renamed roles: every card's kit (its prompt and its own skills) comes along to the roles folder, and a
// kit already made there again after the update is never written over.

const logger = pino({ level: "silent" });
const made: string[] = [];

const volumes = async (): Promise<StateRoots> => {
    const base = await mkdtemp(join(tmpdir(), "role-kits-"));
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

const converge = (roots: StateRoots) => convergeState({ roots, version: "1.400.0", logger, mayWrite: true, documents: [], steps: [roleKitsFolderStep] });

const put = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
};
const config = (roots: StateRoots, ...parts: string[]): string => join(roots.workspace, STATE_DIR, "config", ...parts);

test("every kit moves from the personas folder to the roles folder", async () => {
    const roots = await volumes();
    await put(config(roots, "personas", "reviewer", "PROMPT.md"), "Review carefully.");
    await put(config(roots, "personas", "writer", "skills", "tone", "SKILL.md"), "---\nname: tone\n---\n");
    await converge(roots);

    expect(await readFile(config(roots, "roles", "reviewer", "PROMPT.md"), "utf8")).toBe("Review carefully.");
    expect(await readFile(config(roots, "roles", "writer", "skills", "tone", "SKILL.md"), "utf8")).toContain("name: tone");
    expect(await readdir(config(roots)).then((names) => names.includes("personas"))).toBe(false);
});

test("a kit made again in the roles folder wins, and the old one stays where it was", async () => {
    const roots = await volumes();
    await put(config(roots, "personas", "reviewer", "PROMPT.md"), "Old prompt.");
    await put(config(roots, "personas", "writer", "PROMPT.md"), "Writer prompt.");
    await put(config(roots, "roles", "reviewer", "PROMPT.md"), "New prompt.");
    await converge(roots);

    expect(await readFile(config(roots, "roles", "reviewer", "PROMPT.md"), "utf8")).toBe("New prompt.");
    expect(await readFile(config(roots, "roles", "writer", "PROMPT.md"), "utf8")).toBe("Writer prompt.");
    expect(await readFile(config(roots, "personas", "reviewer", "PROMPT.md"), "utf8")).toBe("Old prompt.");
});

test("a sandbox with no personas folder has nothing to move", async () => {
    const roots = await volumes();
    const plan = await roleKitsFolderStep.plan({
        roots,
        read: async () => undefined,
        list: async () => [],
        kind: async () => undefined,
    });
    expect(plan).toBeUndefined();
});
