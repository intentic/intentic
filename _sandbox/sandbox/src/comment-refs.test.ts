import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import { expect, test } from "vitest";

// Every file a comment names still exists under that name; a reference is recognized by shape (a known stem, a long or
// hyphenated/camelCase stem, or a PascalCase component name), not a list of known-bad names.

const REPO_ROOT = repoRoot(import.meta.url);

const SCANNED = new Set([".ts", ".tsx", ".vue", ".mjs"]);

// Strings are consumed before comments can open inside them, so a URL in a literal is never read as prose.
const TOKENS = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

const REFERENCE = /[\w./-]+\.(?:ts|tsx|vue|mjs)\b/g;

// A stem worth checking alone: hyphenated or camelCase and long enough that the compounding is a name, not an accident.
const compound = (stem: string): boolean => stem.length >= 6 && (/-/.test(stem) || /[a-z][A-Z]/.test(stem));

// Every .vue/.tsx here is a PascalCase component; that shape alone names one, even from a single word.
const component = (stem: string, leaf: string): boolean => /\.(?:vue|tsx)$/.test(leaf) && stem.length >= 4 && /^[A-Z][a-z]/.test(stem);

// Filenames that are examples or belong to another repo/dependency; quoted as evidence, not a broken pointer.
const NOT_OURS = new Set([
    "BaseButton.vue",
    "ButtonV2.tsx",
    "Checkout.vue",
    "legacyPlans.ts",
    "one-file.ts",
    "AppShell.vue",
    "ErrorBoundary.tsx",
    "page.tsx",
    "client.mjs",
]);

// The only file allowed to quote dead names; its header is evidence, not a pointer.
const SELF = "_sandbox/sandbox/src/comment-refs.test.ts";

const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const found = await Promise.all(
        entries.map(async (entry) => {
            if (entry.isDirectory()) {
                // target is cargo's build tree; nothing of ours lives there, and it wastes stats on a dirty checkout.
                return entry.name.startsWith(".") || entry.name === "target" || IGNORED_DIRS.has(entry.name) ? [] : walk(join(dir, entry.name));
            }
            return SCANNED.has(entry.name.slice(entry.name.lastIndexOf("."))) ? [join(dir, entry.name)] : [];
        }),
    );
    return found.flat();
};

test("every module a comment names still exists under that name", async () => {
    const files = await walk(REPO_ROOT);
    const basenames = new Set(files.map((file) => file.slice(file.lastIndexOf("/") + 1)));
    const stems = new Set([...basenames].map((name) => name.slice(0, name.indexOf("."))));

    // Reads the tree in one batch; serialized, many round trips risk the suite's time budget under concurrent runs.
    const sources = await Promise.all(
        files.filter((file) => !file.endsWith(SELF)).map(async (file) => [file, await readFile(file, "utf8").catch(() => "")] as const),
    );

    let checked = 0;
    const dead: string[] = [];
    for (const [file, source] of sources) {
        for (const token of source.match(TOKENS) ?? []) {
            if (!token.startsWith("//") && !token.startsWith("/*")) {
                continue;
            }
            for (const reference of token.match(REFERENCE) ?? []) {
                // A glob or a bare extension (`*.test.ts`, `.d.ts`, `-store.ts`) names a pattern, not a file.
                if (/^[*.-]/.test(reference)) {
                    continue;
                }
                const leaf = reference.slice(reference.lastIndexOf("/") + 1);
                const stem = leaf.slice(0, leaf.indexOf("."));
                if (NOT_OURS.has(leaf) || (!stems.has(stem) && !compound(stem) && !component(stem, leaf))) {
                    continue;
                }
                checked++;
                if (!basenames.has(leaf)) {
                    dead.push(`${file.slice(REPO_ROOT.length + 1)} → ${reference}`);
                }
            }
        }
    }

    // If the scan stops matching, this test passes while guarding nothing.
    expect(checked).toBeGreaterThan(500);

    expect(
        [...new Set(dead)].toSorted(),
        "These comments name a file that does not exist: point them at the current name, or reword so the name is not a claim about this tree.",
    ).toEqual([]);
    // 20s budget: this suite reads every source file in the repo, slower than vitest's 5s default assumes.
}, 20_000);
