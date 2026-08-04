import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import { expect, test } from "vitest";

/* EVERY FILE A COMMENT POINTS AT STILL EXISTS — the one cross-file link nothing else checks.
 *
 * The comments here are load-bearing. README.md sends a new agent to `agents/isolation.ts` and
 * `agents/worktrees.ts` to learn why isolation is shaped the way it is, and those headers hand off to each
 * other by name. An import that goes stale stops compiling; a name in PROSE is just text. It survives every
 * rename, and it is read by exactly the people who do not yet know it is wrong.
 *
 * It had rotted in 28 places before this existed. `sandboxPool.ts` became `sandbox-pool.ts` and three comments
 * in _apps/api kept sending readers to the old spelling. The preview-hostname builder was folded into the
 * contract's `hostnames.ts` and three more named a file that had been gone for weeks. Fifteen suites gained the
 * `.integration.` marker that SELECTS THEIR TIMEOUT BUDGET while the comments naming them did not — so the
 * prose disagreed with the one convention AGENTS.md makes a suite's name mean something. Every one was a
 * one-line fix nobody had a reason to make, because nothing failed.
 *
 * Recognized by SHAPE rather than by a list of known-bad names, which would repeat the miss it exists to
 * prevent. A reference is a POINTER on any of three grounds: its stem names a real module here (so
 * `standing.test.ts` is measured against the `standing.integration.test.ts` that exists), or the stem is
 * compound and long (so a target renamed clean away is still caught — `sandboxPool.ts` had nothing left to
 * match), or it is shaped like a component, every .vue/.tsx here being PascalCase. That third ground is not
 * decoration: `Chat.vue` outlived the page it named and was invisible to the other two. Everything else is the
 * prose's own vocabulary — `foo.ts`, `a.ts`, `Foo.vue`, globs like `*.test.ts` — and is left alone. */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

const SCANNED = new Set([".ts", ".tsx", ".vue", ".mjs"]);

// Strings are consumed BEFORE comments can open inside them, so a URL in a literal ("https://…/foo.ts") is not
// read as prose. Whatever is left starting with // or /* is a comment.
const TOKENS = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

const REFERENCE = /[\w./-]+\.(?:ts|tsx|vue|mjs)\b/g;

// A stem worth checking on its own evidence: hyphenated or camelCase, and long enough that the compounding is a
// name rather than an accident. Single short words are how this prose writes an EXAMPLE.
const compound = (stem: string): boolean => stem.length >= 6 && (/-/.test(stem) || /[a-z][A-Z]/.test(stem));

// Every .vue/.tsx here is a PascalCase component, so a reference wearing that shape is NAMING one rather than
// illustrating a filename — and it is the only ground a single-word component name is caught on.
const component = (stem: string, leaf: string): boolean => /\.(?:vue|tsx)$/.test(leaf) && stem.length >= 4 && /^[A-Z][a-z]/.test(stem);

// Names for files outside this tree — they resolve to nothing and always will. Three are the chore analyzer's
// examples of components in a USER's repository (chores/stack.ts reduces two of them to one stem, which is the
// point it is making); the last is an example argument in a documented command line.
const NOT_OURS = new Set(["BaseButton.vue", "ButtonV2.tsx", "Checkout.vue", "one-file.ts"]);

// The one file that has to QUOTE dead names in order to explain itself — its header is evidence, not a pointer.
const SELF = "_apps/sandbox/src/comment-refs.test.ts";

const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const found = await Promise.all(
        entries.map(async (entry) => {
            if (entry.isDirectory()) {
                return entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name) ? [] : walk(join(dir, entry.name));
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

    let checked = 0;
    const dead: string[] = [];
    for (const file of files) {
        if (file.endsWith(SELF)) {
            continue;
        }
        const source = await readFile(file, "utf8").catch(() => "");
        for (const token of source.match(TOKENS) ?? []) {
            if (!token.startsWith("//") && !token.startsWith("/*")) {
                continue;
            }
            for (const reference of token.match(REFERENCE) ?? []) {
                // A glob or a bare extension — `*.test.ts`, `.d.ts`, `-store.ts` — names a pattern, not a file.
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

    // If the scan ever stops matching, this file would pass while guarding nothing.
    expect(checked).toBeGreaterThan(500);

    expect(
        [...new Set(dead)].toSorted(),
        "These comments name a file that does not exist — point them at the current name, or reword so the name is not a claim about this tree.",
    ).toEqual([]);
});
