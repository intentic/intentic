#!/usr/bin/env node
// Diffs the committed contract.lock.json against merge-base; a shrunk surface must be declared in the range (a type!:
// subject or Breaking-Note: trailer). A route's recorded access (`access:` entries) counts: any change to one is a
// shrink. Fails CI on a branch that shrinks it undeclared, and stands down on main itself, and in a linked worktree too,
// since landing carries work as patches and the declaration is the landing draft's job.
//
// And diffs the doors whose far end lags in the field (the machine agent, the phone app, the browser extension,
// runners, a sandbox's netd: lib/release-doors.mjs) against the LAST RELEASE, the newest vX.Y.Z tag this commit
// descends from: a copy of that release is out there whatever a commit says, so no declaration lets these through, only
// a retirement the far end's floor has reached. This half runs everywhere, worktrees included. The tag is read from
// the checkout, or, in a shallow clone that has none (CI's preflight), the newest one origin lists is fetched alone.
// INTENTIC_RELEASE_REF names another ref to compare with.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shrunkSurfaces } from "../constants/src/contract-shrink.mjs";
import { compareReleases, peerFloors } from "./lib/peer-floors.mjs";
import { doorEntries, LAGGING_DOORS, uncoveredShrinks } from "./lib/release-doors.mjs";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { git, root } from "./lib/repo.mjs";

const LOCK_FILE = "_shared/sandbox-contract/contract.lock.json";
const RAW_JSON_ROUTES = "_shared/sandbox-contract/src/protocol/raw/raw-json-routes.ts";
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/u;
const RELEASE_REF_ENV = "INTENTIC_RELEASE_REF";
const NETWORK_MS = 30_000;

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
                // An `access:METHOD /path.field` entry is a route's reach (sandbox-contract route-meta.ts `routeAccess`):
                // a lower floor or a new grant lets someone reach what they could not, so the note says who, and what.
                ...(gone.some((path) => path.startsWith("access:"))
                    ? [`an access: entry is who may reach that route: say in the note who can now reach it, or who no longer can`]
                    : []),
                `to declare it, run this ON THIS CHECKOUT (fill in the sentence) and push again:`,
                `    git commit --allow-empty -m 'feat!: declare the wire-contract removals in this range' ` +
                    `-m 'Breaking-Note: <what stops working and what to do instead, one plain sentence>'`,
            );
        }
    }
}

/* THE LAST RELEASE. */

// A network git call with a deadline and no credential prompt; undefined when it fails or runs out.
const remoteGit = (...args) => {
    const result = spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: NETWORK_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return result.status === 0 ? result.stdout : undefined;
};

const newestTag = (names) =>
    names
        .filter((name) => RELEASE_TAG.test(name))
        .toSorted((a, b) => compareReleases(RELEASE_TAG.exec(b)[1], RELEASE_TAG.exec(a)[1]))[0];

const present = (ref) => git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`) !== undefined;

// The ref to compare with, or undefined when none can be had. A full history answers with the newest release this
// commit descends from (a branch cut before a release is not judged against what that release added). A shallow one
// cannot tell descent, so it takes the newest release origin lists: main is always ahead of its last release.
const lastRelease = () => {
    const named = process.env[RELEASE_REF_ENV]?.trim();
    if (named !== undefined && named !== "") {
        return present(named) ? named : undefined;
    }
    if (git("rev-parse", "--is-shallow-repository")?.trim() !== "true") {
        const described = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*", "HEAD")?.trim();
        if (described !== undefined && RELEASE_TAG.test(described)) {
            return described;
        }
    }
    const listed = remoteGit("ls-remote", "--tags", "--refs", "origin", "v*");
    const remote = newestTag((listed ?? "").split("\n").map((line) => line.split("refs/tags/")[1]?.trim() ?? ""));
    if (remote !== undefined && (present(remote) || remoteGit("fetch", "--no-tags", "--depth=1", "origin", `refs/tags/${remote}:refs/tags/${remote}`) !== undefined)) {
        return remote;
    }
    return newestTag((git("tag", "--list", "v*") ?? "").split("\n").map((name) => name.trim()));
};

const laggingShrinks = [];
let releaseNote;
if (existsSync(join(root, LOCK_FILE))) {
    const release = lastRelease();
    const releaseLock = release === undefined ? undefined : git("show", `${release}:${LOCK_FILE}`);
    if (releaseLock === undefined) {
        releaseNote = `no release tag (vX.Y.Z) to read ${LOCK_FILE} at, locally or from origin`;
    } else {
        let floors;
        try {
            floors = peerFloors();
        } catch (error) {
            cannotMeasure(`contract-shrink: ${error.message}`);
        }
        const base = JSON.parse(releaseLock);
        const head = JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8"));
        const at = (ref, path) => (ref === undefined ? (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined) : git("show", `${ref}:${path}`));
        const both = (path) => [at(release, path), at(undefined, path)].filter((text) => text !== undefined);
        const rawJsonTexts = both(RAW_JSON_ROUTES);
        for (const door of LAGGING_DOORS) {
            const entries = doorEntries(door, { moduleTexts: (door.modules ?? []).flatMap(both), rawJsonTexts, base, head });
            const goldens = (door.goldens ?? []).map((path) => [path, at(release, path), at(undefined, path)]);
            const gone = uncoveredShrinks({ door, base, head, entries, goldens, floors });
            laggingShrinks.push(...gone.slice(0, 10).map((path) => `${door.id}: ${path}`), ...(gone.length > 10 ? [`${door.id}: …and ${gone.length - 10} more`] : []));
        }
        if (laggingShrinks.length > 0) {
            laggingShrinks.push(
                `each of these is spoken by copies of ${release} already out there, which update on their own schedule: no commit message waives it`,
                `make the change compatible (keep the old shape beside the new, a field optional rather than gone), or retire it: give the far end a floor (_tools/checks/lib/peer-floors.mjs) and a RETIRED entry (lib/release-doors.mjs) the floor has reached`,
            );
        }
        releaseNote = `doors that lag in the field: nothing shrank against ${release}`;
    }
}

// Unmeasured rather than passed when CI could not find the release, so a lost tag is seen; locally it is a note.
if (laggingShrinks.length === 0 && undeclaredBreaks.length === 0 && releaseNote?.startsWith("no release") === true && process.env.CI !== undefined) {
    cannotMeasure(`contract-shrink: ${releaseNote}; set ${RELEASE_REF_ENV} or fetch the tags`);
}

finish(
    [
        ["The wire contract shrank without a declared breaking change", undeclaredBreaks],
        ["A door whose far end lags in the field shrank against the last release", laggingShrinks],
    ],
    [
        `wire contract: ${conversation ? "conversation worktree, the landing draft declares any shrink, and CI runs this gate again on what is pushed" : "nothing shrank undeclared against merge-base"}`,
        ...(releaseNote === undefined ? [] : [releaseNote]),
    ],
);
