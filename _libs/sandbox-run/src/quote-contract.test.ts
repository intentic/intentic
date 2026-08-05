import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

/* NOBODY HAND-ROLLS A QUOTE — enforced by discovery, not by a list.
 *
 * The dangerous pattern this repo actually had was one shape, repeated: a secret or operator-supplied value
 * spliced into a command as `'${value}'` or `"${value}"`, on the assumption that it contains no quote of its
 * own. It held until a restic password contained an apostrophe — and then the write either corrupted (a `.env`
 * value truncated at the quote, so the backups encrypt under a key nobody has) or executed (a `$(…)` past the
 * closing quote of a command a daemon runs on a host as root).
 *
 * Enumerating the sites did not work. A correct POSIX quoter already existed and had been COPIED four times
 * rather than shared, and the first sweep that fixed "every site" still missed seven — including a second
 * `valkey-cli -a '<password>'` one file away from the one it did fix. That is a discovery failure, so the
 * guard is discovery: walk the repo, recognize the shape, and require the file to import the real quoters.
 *
 * Following the precedent of sandbox-run-contract.test.ts, the IMPORT is the guarantee. A file that has the
 * quoters in hand and still hand-rolls one is a code-review problem; a file that never heard of them is the
 * failure this test exists to make impossible to add. */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

// The shape: a value interpolated between a matched pair of quote characters. `'${password}'`, `"${sql}"`.
const QUOTED_INTERPOLATION = /['"]\$\{[^{}]*\}['"]/;

// …on a line that is building a command for something else to parse. Deliberately strong markers: an earlier
// draft accepted a bare `restic ` and flagged the sentence "the restic repo lives on it" in a log message.
const BUILDS_A_COMMAND = /\.exec\(|execSync|execFileSync|printf |docker |psql |valkey-cli|restic -r|sh -c|bash -c/;

// A line whose only content is prose. The shape appears in the comments that explain these very fixes.
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

const QUOTERS = /@intentic\/sandbox-run\/quote/;

// Not a workspace concern the leaf lib should take a dependency for — the set that matters here is small.
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
        // Tests write the broken shape on purpose in order to assert against it; quote.ts IS the shape.
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

// The positive floor under the discovery above: losing the quoters to a refactor must not read as "clean".
test("the sites that carry secrets to a host still import the quoters", async () => {
    const carriers = [
        "_libs/providers/src/backup/backup.ts",
        "_libs/providers/src/backings/postgres-database.ts",
        "_libs/providers/src/backings/valkey-namespace.ts",
        "_libs/providers/src/komodo/komodo.ts",
        "_libs/providers/src/auth/authentik.ts",
        "_apps/sandbox/src/secrets/secrets.routes.ts",
    ];
    for (const carrier of carriers) {
        const content = await readFile(join(REPO_ROOT, carrier), "utf8");
        expect(QUOTERS.test(content), `${carrier}: must quote through @intentic/sandbox-run/quote`).toBe(true);
    }
});
