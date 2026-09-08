import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { expect, test } from "vitest";

// Enforces by discovery, not a list, that no file splices a value into a command via bare quotes without importing the
// shared quoters. `.integration.`: it walks every .ts file in the repo, so timing reflects the machine, not the code.

const REPO_ROOT = repoRoot(import.meta.url);

// The shape: a value interpolated between a matched pair of quote characters. `'${password}'`, `"${sql}"`.
const QUOTED_INTERPOLATION = /['"]\$\{[^{}]*\}['"]/;

// On a line building a command for something else to parse; markers are strong to avoid matching prose.
const BUILDS_A_COMMAND = /\.exec\(|execSync|execFileSync|printf |docker |psql |valkey-cli|restic -r|sh -c|bash -c/;

// A line whose only content is prose.
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

const QUOTERS = /@intentic\/sandbox-run\/quote/;

// Not a workspace concern the leaf lib should take a dependency for; the set that matters here is small.
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "coverage", "refs", "public"]);

const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const found = await Promise.all(
        entries.map(async (entry) => {
            if (entry.isDirectory()) {
                return entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name) ? [] : walk(join(dir, entry.name));
            }
            return entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [];
        }),
    );
    return found.flat();
};

test("no file splices a value into a command between bare quotes without importing the shared quoters", async () => {
    const offenders: string[] = [];
    for (const file of await walk(REPO_ROOT)) {
        // Tests write the broken shape on purpose to assert against it; quote.ts IS the shape.
        if (file.endsWith(".test.ts") || file.endsWith("/quote.ts")) {
            continue;
        }
        const content = await readFile(file, "utf8").catch(() => "");
        if (QUOTERS.test(content)) {
            continue;
        }
        for (const [index, line] of content.split("\n").entries()) {
            if (!COMMENT.test(line) && QUOTED_INTERPOLATION.test(line) && BUILDS_A_COMMAND.test(line)) {
                offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${index + 1}: ${line.trim()}`);
            }
        }
    }
    expect(
        offenders,
        `hand-rolled quoting — import { shellQuote, sqlLiteral, sqlIdentifier, envLine, dockerEnvLine } from "@intentic/sandbox-run/quote" and wrap the value, one call per parser it crosses:\n${offenders.join("\n")}`,
    ).toEqual([]);
});

// The positive floor under the discovery test above: losing the quoters to a refactor must not read as clean.
test("the sites that carry secrets to a host still import the quoters", async () => {
    const carriers = [
        "_deploy/providers/src/backup/backup.ts",
        "_deploy/providers/src/backings/postgres-database.ts",
        "_deploy/providers/src/backings/valkey-namespace.ts",
        "_deploy/providers/src/komodo/komodo.ts",
        // The write-once .env every provider's secrets cross; naming it holds the floor under all of them.
        "_deploy/providers/src/core/host-files.ts",
        "_sandbox/sandbox/src/secrets/secrets.routes.ts",
    ];
    for (const carrier of carriers) {
        const content = await readFile(join(REPO_ROOT, carrier), "utf8");
        expect(QUOTERS.test(content), `${carrier}: must quote through @intentic/sandbox-run/quote`).toBe(true);
    }
});
