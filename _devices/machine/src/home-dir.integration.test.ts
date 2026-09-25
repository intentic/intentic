import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// ONE WAY TO THE HOME DIRECTORY in this agent: `homeDir()` from @intentic/local-agent, which follows a HOME (or
// USERPROFILE) set after startup where `os.homedir()` is fixed at it. Three spellings of "home" once lived side by side
// here and a test that moved HOME moved only some of them. Reads this package's own sources.

const SRC = import.meta.dir;

const sources = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map(async (entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                return await sources(path);
            }
            return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [path] : [];
        }),
    );
    return nested.flat();
};

test("no source reaches for the home directory except through homeDir()", async () => {
    const offenders: string[] = [];
    for (const path of await sources(SRC)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a few dozen small files, read in order for a stable report
        const text = await readFile(path, "utf8");
        if (/\bhomedir\s*\(/.test(text)) {
            offenders.push(relative(SRC, path));
        }
    }
    expect(offenders).toEqual([]);
});
