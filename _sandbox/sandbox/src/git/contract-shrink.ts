import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

/* THE WIRE-CONTRACT SHRINK, DETECTED WHERE THE MESSAGE IS WRITTEN — not where the push is refused.
 *
 * This repo's own gate (_tools/scripts/prepass.mjs, invariant 6) blocks a push whose contract lock lost a
 * surface with no `!` commit or `Breaking-Note:` trailer anywhere in the range. Five times running, the gate
 * fired AFTER the shrinking commit had already landed on the main line, and five times a session wrote the
 * missing declaration on its own branch — where it can never matter, because landing applies PATCHES to the
 * main working tree and an empty declaring commit contributes no patch. The one place a declaration can enter
 * the range is the commit the user files, and the one thing that writes that commit's draft is the landing
 * describer (agents/landed-subject.ts). So the detection runs here, mechanically, and the draft it feeds is
 * FORCED to carry the `!` and the Breaking-Note rather than asked to consider them: the model judges what the
 * sentence should say, never whether one is owed.
 *
 * The algorithm is the same one the gate runs, deliberately duplicated: prepass must run with no node_modules
 * installed (it fronts `pnpm install` itself), so it cannot import this file, and this file keeping prepass's
 * exact semantics is what makes "the draft declared it" and "the gate wanted it declared" the same judgment.
 * A change to either copy owes the other a look — the comment above prepass's `shrunk` points back here. */

// Any file with this basename is read as a wire-contract lock: one JSON document whose top-level keys are
// exported schema names (see _sandbox/sandbox-contract/src/contract-lock.ts for the format and why it exists).
const CONTRACT_LOCK_NAME = `contract.lock.json`;

/* Every surface `base` offers that `head` no longer does, as dotted paths. Arrays are the schema's COLLECTIONS
 * (`oneOf` alternatives, `enum` values, `required` names) and are kept unsorted by the lock writer, so a
 * position means nothing: every base element must be matched by SOME head element, and extras pass in silence
 * exactly like a new property does. An element that merely changed reads as removed — same verdict either way.
 * Additions never appear in the result at all: every reader of the wire parses loosely, so growth breaks
 * nobody, and a detector that flagged growth would put a false `!` on ordinary work. */
export const shrunkSurfaces = (base: unknown, head: unknown, at = ``, out: string[] = []): string[] => {
    if (Array.isArray(base) || Array.isArray(head)) {
        if (!Array.isArray(base) || !Array.isArray(head)) {
            out.push(at);
            return out;
        }
        for (const [index, item] of base.entries()) {
            const itemAt = typeof item === `object` && item !== null ? `${at}[${index}]` : `${at} ${JSON.stringify(item)}`;
            const offered = head.some((candidate) => shrunkSurfaces(item, candidate, itemAt, []).length === 0);
            if (!offered) {
                out.push(itemAt);
            }
        }
        return out;
    }
    if (typeof base !== `object` || base === null || typeof head !== `object` || head === null) {
        if (JSON.stringify(base) !== JSON.stringify(head)) {
            out.push(at);
        }
        return out;
    }
    for (const key of Object.keys(base)) {
        if (key in (head as Record<string, unknown>)) {
            shrunkSurfaces((base as Record<string, unknown>)[key], (head as Record<string, unknown>)[key], at === `` ? key : `${at}.${key}`, out);
        } else {
            out.push(at === `` ? key : `${at}.${key}`);
        }
    }
    return out;
};

// The same comparison over the two texts of a lock file. Either side failing to parse yields NO shrink rather
// than a throw: this feeds a commit-message draft, and a mangled lock is the contract-lock test's failure to
// report, not a reason to draft nothing.
export const lockShrinkage = (baseText: string, headText: string): string[] => {
    try {
        return shrunkSurfaces(JSON.parse(baseText), JSON.parse(headText));
    } catch {
        return [];
    }
};

/* What a commit recording `paths` in `dir` would remove from the wire contract: the working tree's lock against
 * HEAD's, for every claimed path that IS a lock. HEAD rather than any merge-base on purpose — this describes
 * THE COMMIT ABOUT TO BE FILED, and a shrink already committed undeclared is the gate's to name, not this
 * draft's to confess. A lock that is new at HEAD removes nothing; a lock unreadable in the tree is left to the
 * contract-lock test. Never throws: every caller is a draft that must not fail a land. */
export const claimedContractShrink = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<string[]> => {
    const removed: string[] = [];
    for (const path of paths.filter((candidate) => basename(candidate) === CONTRACT_LOCK_NAME)) {
        const base = await git(dir, [`show`, `HEAD:${path}`])
            .then((result) => result.stdout)
            .catch(() => undefined);
        const head = base === undefined ? undefined : await readFile(join(dir, path), `utf8`).catch(() => undefined);
        if (base !== undefined && head !== undefined) {
            removed.push(...lockShrinkage(base, head));
        }
    }
    return removed;
};
