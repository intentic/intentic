import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import { createWorkspaceHistory } from "./history.js";
import { literalPattern, MAX_SNAPSHOT_FILE_BYTES } from "./large-files.js";

const exec = promisify(execFile);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A real workspace and history root, and what the root scope's latest snapshot records.
const workspace = async () => {
    const base = await mkdtemp(join(tmpdir(), "intentic-history-large-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    await mkdir(join(work, "marketing"), { recursive: true });
    const history = createWorkspaceHistory({ workspace: workspacePaths(work), historyRoot, logger });
    const recorded = async (): Promise<string[]> =>
        (await exec("git", ["--git-dir", join(historyRoot, "scopes", "root.git"), "ls-tree", "-r", "-z", "--name-only", "refs/snapshots/head"])).stdout
            .split("\0")
            .filter((path) => path !== "");
    // A sparse file: past the limit on disk in no time, and never read unless something stages it.
    const sized = async (path: string, bytes: number): Promise<void> => {
        await writeFile(join(work, path), "");
        await truncate(join(work, path), bytes);
    };
    return { work, history, recorded, sized };
};

const LARGE = MAX_SNAPSHOT_FILE_BYTES + 1;

describe("a file past the snapshot limit", () => {
    it("is left out of the snapshot, and a restore neither brings it back nor deletes it", async () => {
        const { work, history, recorded, sized } = await workspace();
        await writeFile(join(work, "notes.txt"), "v1\n");
        const before = await history.snapshot("user");

        await sized("marketing/launch film.mp4", LARGE);
        await writeFile(join(work, "marketing/brief.md"), "brief\n");
        await history.snapshot("user");
        expect(await recorded()).toEqual(["marketing/brief.md", "notes.txt"]);

        // Restoring the earlier checkpoint takes the brief away, as it was added since; the film was never recorded,
        // and stays as it is.
        expect(await history.restore(before ?? "")).toBe(true);
        expect([existsSync(join(work, "marketing/brief.md")), (await stat(join(work, "marketing/launch film.mp4"))).size]).toEqual([false, LARGE]);
    });

    it("stops being recorded once it grows past the limit, and is recorded again once it shrinks back", async () => {
        const { work, history, recorded, sized } = await workspace();
        await writeFile(join(work, "marketing/cut.mov"), "draft\n");
        await history.snapshot("user");
        expect(await recorded()).toEqual(["marketing/cut.mov"]);

        await sized("marketing/cut.mov", LARGE);
        await writeFile(join(work, "readme.md"), "hi\n");
        await history.snapshot("user");
        expect(await recorded()).toEqual(["readme.md"]);

        await writeFile(join(work, "marketing/cut.mov"), "trimmed\n");
        await history.snapshot("user");
        expect(await recorded()).toEqual(["marketing/cut.mov", "readme.md"]);
        expect(await readFile(join(work, "marketing/cut.mov"), "utf8")).toBe("trimmed\n");
    });

    it("is matched by its exact name, however many wildcard or escape characters that has", async () => {
        const { work, history, recorded, sized } = await workspace();
        const odd = "marketing/[final] *cut?* #2 !v\\1 ";
        await sized(odd, LARGE);
        // Names its pattern would also match, were the characters left as wildcards: these are recorded.
        await writeFile(join(work, "marketing/f *cut?* #2 !v\\1 "), "small\n");
        await writeFile(join(work, "marketing/[final] xcutyz #2 !v\\1 "), "small\n");
        await history.snapshot("user");
        expect(await recorded()).toEqual(["marketing/[final] xcutyz #2 !v\\1 ", "marketing/f *cut?* #2 !v\\1 "]);
        expect(literalPattern("a\nb")).toBeUndefined();
    });
});
