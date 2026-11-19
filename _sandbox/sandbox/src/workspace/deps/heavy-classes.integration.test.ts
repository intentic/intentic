import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { matchInvocation } from "@intentic/constants/heavy-rules";
import { fileHeavyCommandsStore } from "../../workload/heavy-commands.js";
import { HEAVY_CLASSES_FILE, readHeavyClasses, workspaceHeavyClasses } from "./heavy-classes.js";

// A repository's own heavy commands, read from its `.intentic/heavy.json` the way the daemon reads them before every
// agent command: each repository in the workspace, each class parsed on its own (2026-11-19, the shinobi-society audit).

// Each repository's file, as its text; `root` is the workspace's own.
const workspace = async (files: Record<string, string>): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "heavy-classes-"));
    for (const [repo, content] of Object.entries(files)) {
        const dir = repo === "root" ? root : join(root, repo);
        await mkdir(join(dir, ".git"), { recursive: true });
        await mkdir(join(dir, STATE_DIR), { recursive: true });
        await writeFile(join(dir, HEAVY_CLASSES_FILE), content);
    }
    return root;
};

const json = JSON.stringify;
const capture = { id: "motion-capture", scripts: ["scripts/capture.py"], memory: "6G", cpus: 4, exclusive: true, quiet: true };

test("every repository's classes are read, the first of an id winning, and a bad class costs only itself", async () => {
    const root = await workspace({
        game: json({ classes: [capture, { id: "vfx", scripts: ["../outside.sh"] }, { id: "Bad Id", commands: ["make x"] }] }),
        tools: json({ classes: [{ id: "motion-capture", commands: ["make capture"] }, { id: "e2e", commands: ["npm run e2e"], memory: 3072, limit: 1 }] }),
    });
    const { classes, problems } = await readHeavyClasses(root, ["root", "game", "tools"]);
    expect(classes).toEqual([capture, { id: "e2e", commands: ["npm run e2e"], memory: "3072", limit: 1 }]);
    expect(problems).toEqual([
        expect.stringMatching(/^game\/\.intentic\/heavy\.json classes\[1\]: scripts\.0: a path inside the repository/u),
        expect.stringMatching(/^game\/\.intentic\/heavy\.json classes\[2\]: id: lowercase letters, digits and dashes$/u),
        'heavy class "motion-capture" is declared twice; the first declaration is used',
    ]);
});

test("a file that is not JSON, or not a list of classes, or a class taking a built-in rule's id, is named and left out", async () => {
    const root = await workspace({
        a: "{ nope",
        b: json({ classes: { id: "x" } }),
        c: json({ classes: [{ id: "cargo", commands: ["cargo build"] }] }),
        d: json({ classes: [{ id: "x", unknown: 1, commands: ["x"] }] }),
    });
    const { classes, problems } = await readHeavyClasses(root, ["a", "b", "c", "d", "missing"]);
    expect(classes).toEqual([]);
    expect(problems).toEqual([
        expect.stringMatching(/^a\/\.intentic\/heavy\.json: not JSON/u),
        'b/.intentic/heavy.json: expected { "classes": [ … ] }',
        'c/.intentic/heavy.json classes[0]: "cargo" is a built-in rule\'s id; name the class something else',
        expect.stringMatching(/^d\/\.intentic\/heavy\.json classes\[0\]: class: Unrecognized key/u),
    ]);
});

test("the workspace's classes reach the table every command is judged by, each problem told once", async () => {
    const root = await workspace({ root: json({ classes: [{ id: "render", scripts: ["tools/render.sh"] }] }), game: json({ classes: [capture, { id: "x" }] }) });
    const told: string[] = [];
    const classes = workspaceHeavyClasses(root, (problem) => told.push(problem));
    const store = fileHeavyCommandsStore(join(root, STATE_DIR, "config", "heavy-commands.json"), undefined, classes);
    const table = await store.read();
    await store.read();
    expect(matchInvocation("python3 scripts/capture.py", table, undefined, { paths: ["/srv/game/scripts/capture.py"] })).toMatchObject({ id: "motion-capture", exclusive: true, quiet: true, cpus: 4, size: "6144m" });
    expect(matchInvocation("bash tools/render.sh", table, undefined, { paths: [join(root, "tools/render.sh")] })?.id).toBe("render");
    expect(told).toEqual([expect.stringMatching(/^game\/\.intentic\/heavy\.json classes\[1\]: class: it names no script and no command$/u)]);
});

test("a declaration source that fails costs only the declared classes, never the shipped table", async () => {
    const root = await mkdtemp(join(tmpdir(), "heavy-classes-"));
    const reasons: string[] = [];
    const store = fileHeavyCommandsStore(join(root, "heavy-commands.json"), (reason) => reasons.push(reason), async () => {
        throw new Error("disk gone");
    });
    expect(matchInvocation("cargo build", await store.read())?.id).toBe("cargo");
    expect(reasons).toEqual(["declared heavy classes: disk gone"]);
});
