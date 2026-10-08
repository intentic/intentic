import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FAKE_SSH, fakeProject } from "../../testing.js";
import { adoptFolder, asideFolder, setAsidePaths } from "../adopt.js";
import type { Listed } from "../project-files.js";
import { projectShell, sandboxCopy } from "../project-remote.js";
import { IGNORES } from "../ssh.js";

// A FOLDER SET UP AGAIN AFTER IT SAT UNSYNCED, end to end on temp trees: the sandbox's copy is a local folder behind the
// fake ssh that runs the real listing program (src/testing.ts). The case it was written for: a sandbox that deleted and
// edited files while the folder kept its older copy, which a fresh session wrote back and stopped on (2026-10-08).

let root: string;
let local: string;
let remote: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "adopt-"));
    local = join(root, "workspace-abc");
    remote = join(root, "remote");
    await mkdir(local);
    await mkdir(remote);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const put = async (side: string, path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(side, path)), { recursive: true });
    await writeFile(join(side, path), content);
};

const read = async (side: string, path: string): Promise<string | undefined> => await readFile(join(side, path), "utf8").catch(() => undefined);

const AT = new Date("2026-10-08T05:44:00Z");

const adopt = async (): Promise<{ readonly moved: number; readonly movedTo?: string; readonly calls: string[]; readonly said: string[] }> => {
    const fake = fakeProject();
    const said: string[] = [];
    const outcome = await adoptFolder({
        localDir: local,
        sandbox: sandboxCopy(fake.runner, projectShell({ kind: "ssh", alias: "intentic-sync-sandbox-a" }, FAKE_SSH), remote),
        ignores: IGNORES,
        log: (line) => said.push(line),
        now: AT,
    });
    return { ...outcome, calls: fake.calls, said };
};

describe("adoptFolder", () => {
    it("moves what the sandbox deleted or changed out of the folder, and leaves what matches in place", async () => {
        await put(local, "README.md", "# same\n");
        await put(remote, "README.md", "# same\n");
        await put(local, "src/same.ts", "export {};\n");
        await put(remote, "src/same.ts", "export {};\n");
        // Deleted in the sandbox while the folder sat unsynced: a fresh session would write it back there.
        await put(local, "src/old/one-shot.ts", "export const old = 1;\n");
        // Edited in the sandbox: a fresh session would hold it as a conflict.
        await put(local, "src/index.ts", "export const a = 1;\n");
        await put(remote, "src/index.ts", "export const a = 2;\n");
        // Same size, different bytes: only the hash tells them apart.
        await put(local, "src/size.ts", "aaaa");
        await put(remote, "src/size.ts", "bbbb");
        // Ignored on both sides by the session, so never compared nor moved.
        await put(local, "node_modules/pkg/index.js", "local build\n");
        await put(local, ".env", "SECRET=local\n");
        // Only the sandbox has it: it simply arrives once the session starts.
        await put(remote, "src/new.ts", "export const fresh = true;\n");

        const outcome = await adopt();

        const aside = asideFolder(local, AT);
        expect(outcome).toMatchObject({ moved: 3, movedTo: aside });
        expect(await read(aside, "src/old/one-shot.ts")).toBe("export const old = 1;\n");
        expect(await read(aside, "src/index.ts")).toBe("export const a = 1;\n");
        expect(await read(aside, "src/size.ts")).toBe("aaaa");
        expect(await read(local, "src/old/one-shot.ts")).toBeUndefined();
        expect(await read(local, "src/index.ts")).toBeUndefined();
        expect(await read(local, "README.md")).toBe("# same\n");
        expect(await read(local, "node_modules/pkg/index.js")).toBe("local build\n");
        expect(await read(local, ".env")).toBe("SECRET=local\n");
        // The folder the deleted file left empty goes too, or the session would create it in the sandbox.
        expect(await readdir(join(local, "src"))).toEqual(["same.ts"]);
        expect(outcome.calls).toEqual(["ssh list"]);
    });

    it("asks the sandbox nothing for an empty or missing folder", async () => {
        await put(remote, "README.md", "# sandbox\n");
        expect(await adopt()).toMatchObject({ moved: 0, calls: [] });
        await rm(local, { recursive: true });
        expect(await adopt()).toMatchObject({ moved: 0, calls: [] });
    });

    it("moves nothing when the folder already matches", async () => {
        await put(local, "README.md", "# same\n");
        await put(remote, "README.md", "# same\n");
        const outcome = await adopt();
        expect(outcome).toMatchObject({ moved: 0 });
        expect(outcome.movedTo).toBeUndefined();
        expect(await read(local, "README.md")).toBe("# same\n");
    });

    it("throws, moving nothing, when the sandbox's copy cannot be listed", async () => {
        await put(local, "README.md", "# here\n");
        await rm(remote, { recursive: true });
        await expect(adopt()).rejects.toThrow(/has no/);
        expect(await read(local, "README.md")).toBe("# here\n");
    });
});

describe("setAsidePaths", () => {
    it("moves a file the sandbox holds as a link, and leaves a link on both sides to Mutagen", () => {
        const here = new Map<string, Listed>([
            ["a", { size: 1, hash: "x" }],
            ["b", "other"],
            ["c", { size: 2 }],
        ]);
        const sandbox = new Map<string, Listed>([
            ["a", "other"],
            ["b", "other"],
            ["c", { size: 3, hash: "y" }],
        ]);
        expect(setAsidePaths(here, sandbox)).toEqual(["a", "c"]);
    });
});
