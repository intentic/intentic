import { cp, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { slugOf } from "./transcript/slug.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Copies the committed fixture workspace and transcript templates into a tmp dir. Templates use __ROOT__ (workspace
// root), __TS_<n>D__ (timestamp n days ago), and __PAD_40K__ (~40 KB filler); mtimes are backdated 30 days by default.
export const makeRecallFixture = async (): Promise<{
    root: string;
    claudeDir: string;
    projectsDir: string;
    historyRoot: string;
    cleanup: () => Promise<void>;
}> => {
    const tmp = await mkdtemp(join(tmpdir(), "iq-recall-fixture-"));
    const root = join(tmp, "workspace");
    const claudeDir = join(tmp, "claude");
    const historyRoot = join(tmp, "history");
    // Anchored to the package root so it resolves the same from dist/testing.js and src/testing.ts.
    const fixtures = join(packageRoot(import.meta.url), "src/__fixtures__");
    await cp(join(fixtures, "workspace"), root, { recursive: true });
    const backdated = new Date(Date.now() - 30 * DAY_MS);
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            await utimes(join(entry.parentPath, entry.name), backdated, backdated);
        }
    }
    const projectsDir = join(claudeDir, "projects", slugOf(root));
    await mkdir(projectsDir, { recursive: true });
    const sessionIds: string[] = [];
    for (const name of await readdir(join(fixtures, "transcripts"))) {
        const template = await readFile(join(fixtures, "transcripts", name), "utf8");
        const resolved = template
            .replaceAll("__ROOT__", root)
            .replaceAll("__PAD_40K__", "x".repeat(40_000))
            .replace(/__TS_(\d+)D__/g, (_, days: string) => new Date(Date.now() - Number(days) * DAY_MS).toISOString());
        await writeFile(join(projectsDir, name), resolved);
        sessionIds.push(name.replace(/\.jsonl$/, ""));
    }
    // Fleet registry derived from the transcripts just written; reachable only via `historyRoot`.
    await mkdir(historyRoot, { recursive: true });
    await writeFile(
        join(historyRoot, "agents.json"),
        JSON.stringify(
            sessionIds.map((sessionId, index) => ({
                id: `fixture-agent-${index + 1}`,
                branch: `agent/fixture-agent-${index + 1}`,
                title: `Fixture conversation ${index + 1}`,
                sessionId,
            })),
        ),
    );
    return { root, claudeDir, projectsDir, historyRoot, cleanup: () => rm(tmp, { recursive: true, force: true }) };
};
