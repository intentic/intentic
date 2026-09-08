#!/usr/bin/env node
// Diffs the committed contract.lock.json against merge-base; a shrunk surface must be declared in the range (a type!:
// subject or Breaking-Note: trailer). Gates the push and stands down on main itself, and in a linked worktree too,
// since landing carries work as patches and the declaration is the landing draft's job.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shrunkSurfaces } from "../constants/src/contract-shrink.mjs";
import { finish } from "./lib/report.mjs";
import { git, root } from "./lib/repo.mjs";

const LOCK_FILE = "_shared/sandbox-contract/contract.lock.json";

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
            // Pasteable remedy: the declaring commit must be on this checkout, not a branch landing cannot carry
            // forward.
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
