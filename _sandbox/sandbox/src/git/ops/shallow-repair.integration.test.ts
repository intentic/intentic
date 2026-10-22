import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../logger.js";
import { repairShallow } from "./shallow-repair.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const git = (dir: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "protocol.file.allow=always", ...args], { cwd: dir, encoding: "utf8" }).trim();

// An upstream with ten commits and a full clone of it: the workspace repo before anybody narrowed a fetch.
const upstreamAndClone = async (): Promise<{ readonly upstream: string; readonly clone: string }> => {
    const root = await mkdtemp(join(tmpdir(), "intentic-shallow-"));
    tempDirs.push(root);
    const upstream = join(root, "upstream");
    git(root, "init", "-q", "-b", "main", upstream);
    for (let n = 1; n <= 10; n += 1) {
        // ten commits, one at a time, as history is made
        await writeFile(join(upstream, "f"), `${String(n)}\n`);
        git(upstream, "add", "f");
        git(upstream, "commit", "-qm", `c${String(n)}`);
    }
    const clone = join(root, "clone");
    git(root, "clone", "-q", upstream, clone);
    return { upstream, clone };
};

const visible = (dir: string): number => Number(git(dir, "rev-list", "--count", "HEAD"));

test("undoes a cut that `git fetch --depth` made in a full clone, whose history is all still here", async () => {
    const { clone } = await upstreamAndClone();
    git(clone, "fetch", "-q", "--depth", "3", "origin", "main");
    expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(visible(clone)).toBe(3);

    expect(await repairShallow(clone, "clone", logger)).toBe("repaired");

    expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(visible(clone)).toBe(10);
    expect(existsSync(join(clone, ".git", "shallow.lock"))).toBe(false);
    // Whole now, so the next pass has nothing to do.
    expect(await repairShallow(clone, "clone", logger)).toBe("whole");
});

test("leaves a clone made shallow on purpose alone: nothing behind its cut is here", async () => {
    const { upstream } = await upstreamAndClone();
    const thin = join(upstream, "..", "thin");
    git(join(upstream, ".."), "clone", "-q", "--depth", "2", `file://${upstream}`, thin);
    const before = await readFile(join(thin, ".git", "shallow"), "utf8");

    expect(await repairShallow(thin, "thin", logger)).toBe("kept");
    // Asked again, the same cut is not walked again.
    expect(await repairShallow(thin, "thin", logger)).toBe("kept");

    expect(await readFile(join(thin, ".git", "shallow"), "utf8")).toBe(before);
    expect(visible(thin)).toBe(2);
});

test("leaves a cut alone while git holds its lock to write it", async () => {
    const { clone } = await upstreamAndClone();
    git(clone, "fetch", "-q", "--depth", "3", "origin", "main");
    await writeFile(join(clone, ".git", "shallow.lock"), "");

    expect(await repairShallow(clone, "clone", logger)).toBe("kept");
    expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");
});

test("calls a full repository and a folder that is no repository whole", async () => {
    const { clone } = await upstreamAndClone();
    expect(await repairShallow(clone, "clone", logger)).toBe("whole");
    expect(await repairShallow(join(clone, ".."), "root", logger)).toBe("whole");
});
