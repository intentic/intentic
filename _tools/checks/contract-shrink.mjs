#!/usr/bin/env node
/* A SHRUNK WIRE CONTRACT ARRIVES DECLARED. contract.lock.json is the sandbox-contract package's exported
 * schemas as one comparable document; this diffs the committed lock against its merge-base and, when something
 * that EXISTED is gone or different, insists some commit in the range says so, a `type!:` subject or a
 * `Breaking-Note:` trailer, the two spellings the release pipeline majors and warns on. The comparison itself is
 * @intentic/constants/contract-shrink, the one copy the landing drafter also reads.
 *
 * Compared against merge-base rather than the worktree so it gates the PUSH (pre-push hook, PR preflight): on
 * main itself the merge-base IS HEAD and the check stands down, which is honest: by then the declaration either
 * landed or the moment for it has passed. No base, no lock at base, no git: stand down rather than guess.
 *
 * A LINKED WORKTREE STANDS DOWN TOO. Every conversation runs in one, and a conversation is the one place this
 * gate can never be satisfied: landing carries work to the main tree as PATCHES, so a declaring commit written
 * on a conversation's branch never joins any range a push is checked on. The declaration is the landing draft's
 * to write (git/contract-shrink.ts detects the shrink in the claim, agents/landed-subject.ts forces the `!` and
 * the Breaking-Note into the message), and the commit that draft becomes joins a range this gate still checks.
 * Recognized by shape: a checkout whose git dir is not its common dir is a linked worktree. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shrunkSurfaces } from "../constants/src/contract-shrink.mjs";
import { finish } from "./lib/report.mjs";
import { git, root } from "./lib/repo.mjs";

const LOCK_FILE = "_sandbox/sandbox-contract/contract.lock.json";

const gitDir = git("rev-parse", "--absolute-git-dir")?.trim();
const gitCommonDir = git("rev-parse", "--path-format=absolute", "--git-common-dir")?.trim();
const conversation = gitDir !== undefined && gitCommonDir !== undefined && gitDir !== gitCommonDir;

const undeclaredBreaks = [];
if (!conversation && existsSync(join(root, LOCK_FILE))) {
    const head = git("rev-parse", "HEAD")?.trim();
    const mergeBase = (git("merge-base", "HEAD", "origin/main") ?? git("merge-base", "HEAD", "main"))?.trim();
    const baseLock = head !== undefined && mergeBase !== undefined && mergeBase !== head ? git("show", `${mergeBase}:${LOCK_FILE}`) : undefined;
    if (baseLock !== undefined) {
        const gone = shrunkSurfaces(JSON.parse(baseLock), JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8")));
        const messages = git("log", "--format=%B", `${mergeBase}..HEAD`) ?? "";
        const declared = /^[a-z]+(\([^)]*\))?!:/m.test(messages) || /^Breaking-Note:/m.test(messages);
        if (gone.length > 0 && !declared) {
            /* The remedy, PASTEABLE, because five sessions in a row proved what happens without it: agents asked
             * to "fix the failing test" each wrote the declaring commit on their own conversation branch, where
             * landing can never carry it to the range this check reads. The declaration has to be a commit on
             * THIS checkout, made by whoever is about to push. */
            undeclaredBreaks.push(
                ...gone.slice(0, 10).map((path) => `${LOCK_FILE}: ${path}`),
                ...(gone.length > 10 ? [`…and ${gone.length - 10} more`] : []),
                `something users could rely on was removed or changed: declare it, or make the change compatible`,
                `to declare it, run this ON THIS CHECKOUT (fill in the sentence) and re-run the push:`,
                `    git commit --allow-empty -m 'feat!: declare the wire-contract removals in this range' ` +
                    `-m 'Breaking-Note: <what stops working and what to do instead, one plain sentence>'`,
            );
        }
    }
}

finish([["The wire contract shrank without a declared breaking change", undeclaredBreaks]], [
    `wire contract: ${conversation ? "conversation worktree, the landing draft declares any shrink, and the push re-runs this gate from the primary checkout" : "nothing shrank undeclared against merge-base"}`,
]);
