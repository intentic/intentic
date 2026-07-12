import { cp, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { slugOf } from "./transcript/slug.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Copies the committed fixture workspace + transcript templates into a tmp dir. Templates carry __ROOT__
// (absolute workspace root), __TS_<n>D__ (ISO timestamp n days before now — so recency assertions don't rot
// as the repo ages), and __PAD_40K__ (~40 KB filler making session A's second turn visibly token-expensive).
// Workspace file mtimes are backdated 30 days so fixture touches are fresh by default; staleness tests bump
// files forward.
export const makeRecallFixture = async (): Promise<{ root: string; claudeDir: string; projectsDir: string; cleanup: () => Promise<void> }> => {
    const tmp = await mkdtemp(join(tmpdir(), "iq-recall-fixture-"));
    const root = join(tmp, "workspace");
    const claudeDir = join(tmp, "claude");
    // ../src/__fixtures__ resolves from dist/testing.js and src/testing.ts alike (fixtures are never compiled).
    const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../src/__fixtures__");
    await cp(join(fixtures, "workspace"), root, { recursive: true });
    const backdated = new Date(Date.now() - 30 * DAY_MS);
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            await utimes(join(entry.parentPath, entry.name), backdated, backdated);
        }
    }
    const projectsDir = join(claudeDir, "projects", slugOf(root));
    await mkdir(projectsDir, { recursive: true });
    for (const name of await readdir(join(fixtures, "transcripts"))) {
        const template = await readFile(join(fixtures, "transcripts", name), "utf8");
        const resolved = template
            .replaceAll("__ROOT__", root)
            .replaceAll("__PAD_40K__", "x".repeat(40_000))
            .replace(/__TS_(\d+)D__/g, (_, days: string) => new Date(Date.now() - Number(days) * DAY_MS).toISOString());
        await writeFile(join(projectsDir, name), resolved);
    }
    return { root, claudeDir, projectsDir, cleanup: () => rm(tmp, { recursive: true, force: true }) };
};
