import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot, repoRoot } from "@intentic/constants/node";
import { expect, test } from "vitest";

/* THE IMAGE'S PRIVACY HARDENING MUST SURVIVE THE TASK RUNNER — a var set in the Dockerfile and dropped before
 * the process that would read it is worth exactly nothing, and says the opposite on inspection.
 *
 * Turborepo 2 defaults to envMode `strict`: a task does NOT inherit the ambient environment, it is handed a
 * reconstructed one holding Turbo's system defaults plus whatever globalEnv/globalPassThroughEnv/env/
 * passThroughEnv name. Both ENV blocks below were correct, and `env` in any sandbox shell showed them set — so
 * nothing looked wrong. But `pnpm dev` runs through turbo, and turbo deleted 30 of the 32 on the way in (all
 * except NEXT_ and TURBO_, which Turbo ships itself). `astro dev` therefore ran with telemetry ON, printed its
 * collection notice, and persisted `enabled: true` plus a generated tracking id into ~/.config/astro/
 * config.json — for as long as the hole was open, on every sandbox.
 *
 * Same shape as the port collision container-ports.test.ts guards: two files, two languages, nothing comparing
 * them. A comment asking the next person to update both is what was there before. This is the comparison.
 */

const DOCKERFILE = join(packageRoot(import.meta.url), "Dockerfile");
// The root graph, which is what `pnpm dev` / `pnpm build` actually run through — not this package's turbo.json.
const TURBO_JSON = join(repoRoot(import.meta.url), "turbo.json");

// The two blocks are anchored by their first variable rather than by line number or by "every ENV in the file":
// the image sets plenty of non-privacy env (WORKSPACE_ROOT, LANG, TRANSLATOR_URL) that has no business being
// passed through a cache key boundary.
const PRIVACY_BLOCK_ANCHORS = ["DO_NOT_TRACK", "DISABLE_OPENCOLLECTIVE"];

// A backslash-continued `ENV A=1 \ <newline> B=2` block, read from its anchor to the first line that does not
// continue. `ENV` itself is never captured — the pattern requires the `=` that makes a name an assignment.
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

// turbo.json carries comments, so it is not JSON.parse-able and there is no JSONC dep in this package. Reading
// the array as text is also the stricter assertion: the name has to be literally in THAT array, not merely
// somewhere in a file that happens to mention it.
const globalPassThroughEnv = (turboJson: string): string[] => {
    const block = turboJson.match(/"globalPassThroughEnv"\s*:\s*\[([^\]]*)\]/);
    if (!block) {
        return [];
    }
    return [...block[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
};

// The discovery half, and the reason this is a separate test: every assertion below is vacuously true against
// an empty list, so a Dockerfile whose blocks were reshaped — or a turbo.json whose key was renamed — would
// pass while guarding nothing. container-ports.test.ts learned the same lesson.
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
