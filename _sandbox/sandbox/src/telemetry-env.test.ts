import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot, repoRoot } from "@intentic/constants/node";
import { expect, test } from "vitest";

// Turborepo's strict envMode reconstructs the task environment from allowlists; a privacy var baked into the image but
// missing from globalPassThroughEnv is silently dropped before `astro dev` reads it.

const DOCKERFILE = join(packageRoot(import.meta.url), "Dockerfile");
// The root graph, which is what pnpm dev / pnpm build actually run through, not this package's turbo.json.
const TURBO_JSON = join(repoRoot(import.meta.url), "turbo.json");

// Anchored by first variable, not line number; the image also sets non-privacy env that shouldn't pass through.
const PRIVACY_BLOCK_ANCHORS = ["DO_NOT_TRACK", "DISABLE_OPENCOLLECTIVE"];

// Reads a backslash-continued `ENV` block from its anchor to the first non-continuing line; `ENV` itself is never
// captured.
const envBlockNames = (dockerfile: string, anchor: string): string[] => {
    const lines = dockerfile.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`ENV ${anchor}=`));
    if (start === -1) {
        return [];
    }
    const names: string[] = [];
    for (const line of lines.slice(start)) {
        names.push(...[...line.matchAll(/\b([A-Z][A-Z0-9_]*)=/g)].map((match) => match[1]!));
        if (!line.trimEnd().endsWith("\\")) {
            break;
        }
    }
    return names;
};

// Read as text since turbo.json has comments (not JSON-parseable) and no JSONC dep here; also the stricter check, since
// the name must be in this array specifically.
const globalPassThroughEnv = (turboJson: string): string[] => {
    const block = turboJson.match(/"globalPassThroughEnv"\s*:\s*\[([^\]]*)\]/);
    if (!block) {
        return [];
    }
    return [...block[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
};

// A separate test since every assertion below is vacuously true against an empty list; a reshaped Dockerfile or renamed
// turbo.json key would otherwise pass while guarding nothing.
test("both privacy blocks and the passthrough list are actually found", async () => {
    const [dockerfile, turboJson] = await Promise.all([readFile(DOCKERFILE, "utf8"), readFile(TURBO_JSON, "utf8")]);

    for (const anchor of PRIVACY_BLOCK_ANCHORS) {
        expect(envBlockNames(dockerfile, anchor).length, `ENV block anchored at ${anchor}`).toBeGreaterThan(1);
    }
    expect(globalPassThroughEnv(turboJson).length).toBeGreaterThan(1);
});

test("every privacy var the image bakes survives turbo's strict env", async () => {
    const [dockerfile, turboJson] = await Promise.all([readFile(DOCKERFILE, "utf8"), readFile(TURBO_JSON, "utf8")]);

    const baked = PRIVACY_BLOCK_ANCHORS.flatMap((anchor) => envBlockNames(dockerfile, anchor));
    const passed = new Set(globalPassThroughEnv(turboJson));

    // Listed rather than counted: a failure has to name the variable that would silently start phoning home.
    expect(baked.filter((name) => !passed.has(name))).toEqual([]);
});
