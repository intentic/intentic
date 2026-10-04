#!/usr/bin/env node
// `node seed-buildinfo.mjs <buildinfo>`: before a type check whose program is incremental, gives a checkout that has no
// build info yet the one a sibling worktree of the same repository holds at the same path, nearest commit first. A
// conversation's worktree starts without `.cache/` (never committed, never mirrored), so its first web check ran from
// nothing: 57 to 77 s, against 7.5 s once a build info exists (measured 2026-10-03). The program reuses only what each
// file's content hash still matches, so a seed from a tree that differs re-checks exactly what differs and what imports
// it: a new error is still reported. That is also its limit: a sibling on the same commit (a fan-out's children, work
// started together) saves the minute, and one a few central modules apart saves nothing (four files apart, one of them
// the chat's transcript state, measured 58 s), though it costs nothing either.
//
// Only for a `--noEmit` program (the web's vue-tsc): a `tsc -b` build info also vouches for emitted output this tree does
// not have, which is why the worktree mirror leaves caches out (isolation.ts). Every failure is no seed: the check then
// runs from nothing, as it did before.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// How many of the newest candidates are read before giving up: each is a couple of megabytes of JSON.
const TRIED = 5;

// A directory's identity, which a worktree seen from inside a conversation's namespace (/work) shares with its path as
// git lists it (/history/worktrees/<id>), where the two names differ.
const identity = (path) => {
    try {
        const { dev, ino } = statSync(path);
        return `${String(dev)}:${String(ino)}`;
    } catch {
        // allow(silent-catch): a worktree pruned since it was listed has no identity, and is no candidate either
        return undefined;
    }
};

/** The same-path build infos among the repository's other worktrees (`{ path, head }` each), newest first. */
export const siblings = (target, worktrees, self) =>
    worktrees
        .filter(({ path }) => identity(path) !== identity(self))
        .flatMap(({ path: tree, head }) => {
            const path = join(tree, target);
            try {
                return [{ path, head, at: statSync(path).mtimeMs }];
            } catch {
                // allow(silent-catch): a worktree with no build info, or pruned since it was listed, is not a candidate
                return [];
            }
        })
        .toSorted((a, b) => b.at - a.at);

// `git worktree list --porcelain`: a `worktree <path>` line, then `HEAD <sha>`, per worktree.
const worktreesOf = (porcelain) =>
    porcelain
        .split("\n\n")
        .map((block) => ({
            path: /^worktree (.+)$/mu.exec(block)?.[1],
            head: /^HEAD (\w+)$/mu.exec(block)?.[1],
        }))
        .filter((tree) => tree.path !== undefined);

// Files that differ between two commits: a build info from a tree whose shared modules changed re-checks everything
// that imports them (measured: four files apart, one of them the chat's transcript state, cost 58 s against 8 s).
const distance = (from, to) => {
    if (from === undefined || from === to) {
        return 0;
    }
    try {
        return git("diff", "--name-only", from, to)
            .split("\n")
            .filter((line) => line !== "").length;
    } catch {
        // allow(silent-catch): a commit this clone cannot name is as far as anything gets
        return Number.POSITIVE_INFINITY;
    }
};

/**
 * Whether a build info's text records a check that found nothing: one that found errors came from a tree that did not
 * check clean (an install missing its declarations, measured: it seeded a 60 s run), so it is a poor start for this one.
 */
export const checkedClean = (text) => {
    const info = JSON.parse(text);
    const pending = info.semanticDiagnosticsPerFile ?? info.program?.semanticDiagnosticsPerFile ?? [];
    return Array.isArray(pending) && pending.length === 0;
};

const seed = (file) => {
    const wanted = resolve(file);
    if (existsSync(wanted)) {
        return;
    }
    const self = git("rev-parse", "--show-toplevel");
    const prefix = git("rev-parse", "--show-prefix");
    const head = git("rev-parse", "HEAD");
    // The nearest commit first, the newest among equals: the one whose files most likely match this tree's.
    const sources = siblings(join(prefix, file), worktreesOf(git("worktree", "list", "--porcelain")), self)
        .slice(0, TRIED)
        .map((candidate, order) => ({ ...candidate, order, apart: distance(candidate.head, head) }))
        .toSorted((a, b) => a.apart - b.apart || a.order - b.order)
        .map(({ path }) => path);
    if (sources.length === 0) {
        return;
    }
    // Copied whole and parsed before it is put in place: a sibling's check may be writing it this moment.
    const staged = `${wanted}.seed-${process.pid}`;
    mkdirSync(dirname(wanted), { recursive: true });
    try {
        for (const source of sources) {
            try {
                copyFileSync(source, staged);
                if (checkedClean(readFileSync(staged, "utf8"))) {
                    renameSync(staged, wanted);
                    process.stderr.write(`seed-buildinfo: started from ${dirname(dirname(source))}'s build info\n`);
                    return;
                }
            } catch {
                // allow(silent-catch): a copy caught mid-write or pruned mid-read is skipped for the next one
            }
        }
    } finally {
        rmSync(staged, { force: true });
    }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    try {
        const [file] = process.argv.slice(2);
        if (file !== undefined) {
            seed(file);
        }
    } catch {
        // allow(silent-catch): no git, no sibling, an unreadable copy: the check runs from nothing, as it always could
    }
}
