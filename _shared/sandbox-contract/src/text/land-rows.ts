import type { AgentEvent } from "../events/agent-events.js";
import type { TranscriptRow } from "../events/transcript.js";
import { noticeCode } from "../events/sandbox-notice.js";

// The notices a turn's work leaves as it moves: an install starting, the branch rebased onto the workspace while it
// waited, and where the finished work went (landed, held, conflicted, or into a parent's checkout).

// Clause appended to the landed notice for a workspace dependency change, or empty when there is none. Reports the
// install as already started, or as on its way: the daemon starts it within seconds, in the install lane, behind any
// install already running; never as a request.
const dependencyLine = (deps: { missing: number; started: string[]; deferred: boolean } | undefined): string => {
    if (deps === undefined || deps.missing === 0) {
        return ``;
    }
    // `missing` counts versions the turn bumped as well as names it added, so the sentence names both.
    const what = `${deps.missing} ${deps.missing === 1 ? `dependency` : `dependencies`} it added or changed`;
    return deps.deferred
        ? ` ${what} ${deps.missing === 1 ? `is` : `are`} being installed in your tree: the install waits for any other install to finish, appears in Work terminals, and its outcome lands in Activity.`
        : ` Installing ${what}; the project's checks run when that finishes, and the outcome lands in Activity.`;
};

// Said as an agent's own install starts: where it writes and what outlasts it. Names up to three projects, the workspace
// root first; an install the gate could not place in a project says only where it writes. Coded like every sandbox
// notice (sandbox-notice.ts `installing`), so the chat can say it in the reader's language.
const INSTALL_NAMED = 3;
export const installRow = (event: { readonly reach: "own-copy" | "main-tree"; readonly projects: readonly string[] }): TranscriptRow => {
    const root = event.projects.includes(``);
    const dirs = event.projects.filter((dir) => dir !== ``).map((dir) => `${dir}/`);
    const shownDirs = dirs.slice(0, INSTALL_NAMED - (root ? 1 : 0));
    const more = dirs.length - shownDirs.length;
    const named = [...(root ? [`the workspace root`] : []), ...shownDirs].join(`, `);
    const list = more > 0 ? `${named} and ${more} more` : named;
    const where = list === `` ? `` : ` in ${list}`;
    const ownCopy = event.reach === `own-copy`;
    return {
        role: "notice",
        text: ownCopy
            ? `Installing packages${where} into this conversation's own copy. The manifest and lockfile land with the work, and the review lists what it adds.`
            : `Installing packages${where} in the main tree, one install at a time.`,
        noticeCode: noticeCode({
            code: "installing",
            params: {
                ownCopy,
                root: root || undefined,
                projects: shownDirs.length === 0 ? undefined : shownDirs.join(`, `),
                more: more > 0 ? more : undefined,
            },
        }),
    };
};

// One line reporting the daemon's rebase of this agent's branch onto the current workspace; `blocked` names repos it
// couldn't rebase, where the turn ran from an older base.
export const syncLine = (sync: { commits: number; blocked: readonly string[] }): string => {
    const moved =
        sync.commits > 0
            ? `Your workspace moved on while this agent waited, its branch was rebased onto your latest ${sync.commits} commit${sync.commits === 1 ? `` : `s`}.`
            : undefined;
    const blocked =
        sync.blocked.length > 0
            ? `Couldn't rebase onto your workspace in ${sync.blocked.join(`, `)}: the turn is running from the older base, so its land may need a resolve.`
            : undefined;
    return [moved, blocked].filter((line) => line !== undefined).join(` `);
};

// Row for a spawned child's work gone into its parent's checkout, or held off it by a clash with the parent's edits.
const intoParentRow = (event: Extract<AgentEvent, { kind: "landed" }>): TranscriptRow => {
    if (event.landed) {
        return {
            role: "notice",
            text: `Changes went into the parent agent's checkout, as its in-process subagents' edits do: they reach your workspace with its land.`,
            noticeCode: noticeCode({ code: "intoParent" }),
        };
    }
    const files = (event.conflicts ?? []).flatMap((conflict) => conflict.paths).length;
    return {
        role: "notice",
        text: `${files} file(s) clash with the parent agent's own edits, so nothing was written into its checkout. The parent was told, and can bring the changes in to resolve.`,
        noticeCode: noticeCode({ code: "intoParentClash", params: { files } }),
    };
};

// Row for a finished turn: held on its branch, landed automatically, or conflicted. A landed turn that changed
// dependencies appends dependencyLine, since the Changes diff can't show that.
export const landedRow = (event: Extract<AgentEvent, { kind: "landed" }>): TranscriptRow => {
    if (event.into !== undefined) {
        return intoParentRow(event);
    }
    if (event.held === true) {
        return { role: "notice", text: `Finished: the work is on this agent's branch, ready to land from its review.`, noticeCode: noticeCode({ code: "landHeld" }) };
    }
    if (!event.landed) {
        // Per-file cause (your edits, a moved main line, a binary) is spelled out in the review, not named here.
        const conflicts = event.conflicts ?? [];
        const files = conflicts.flatMap((conflict) => conflict.paths).length;
        const repos = conflicts.map((conflict) => conflict.repo).join(`, `);
        return {
            role: "notice",
            text: `${files} file(s) couldn't land automatically in ${repos}. Open the agent's review to see what blocked them and land from there.`,
            noticeCode: noticeCode({ code: "landConflict", params: { files, repos } }),
        };
    }
    // noticeAction fires only here, right as the auto-behavior ran; an active install takes the slot instead.
    const deps = event.deps === undefined || event.deps.missing === 0 ? undefined : event.deps;
    return {
        role: "notice",
        text: `Changes landed in your workspace: review them in the Changes panel.${dependencyLine(event.deps)}`,
        noticeAction: (event.deps?.started.length ?? 0) > 0 ? "depsInstall" : "landHold",
        noticeCode: noticeCode({ code: "landed", params: deps === undefined ? undefined : { deps: deps.missing, queued: deps.deferred || undefined } }),
    };
};
