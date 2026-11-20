import type { AgentEvent } from "../events/agent-events.js";
import type { TranscriptRow } from "../events/transcript.js";
import { noticeCode, type WorktreeSyncCause } from "../events/sandbox-notice.js";

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
    const what = `${deps.missing} changed ${deps.missing === 1 ? `dependency` : `dependencies`}`;
    return deps.deferred ? ` ${what} queued to install.` : ` Installing ${what}, then checks.`;
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
            ? `Installing packages${where} into this conversation's own copy.`
            : `Installing packages${where} in the main tree.`,
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
// couldn't rebase, where the turn ran from an older base. Worded by when it ran: a frame with no `cause` predates it and
// reads as a turn's opening, as it always did. A mid-turn catch-up only ever moves the branch where the main line touched
// none of the files it changed (land/sync.ts, the `clear` gate), and says so with the commit to diff against: in the
// shinobi-society audit (2026-11-17) "while this agent waited" sent an agent hunting for what had reset its fix.
export interface SyncFacts {
    readonly commits: number;
    readonly blocked: readonly string[];
    readonly cause?: WorktreeSyncCause | undefined;
}
export const syncLine = (sync: SyncFacts, base?: string): string => {
    const plural = sync.commits === 1 ? `` : `s`;
    const onto = base === undefined || base === `` ? `` : ` (base ${base})`;
    const moved =
        sync.commits === 0
            ? undefined
            : sync.cause === `between-tools`
              ? `Rebased mid-turn onto ${sync.commits} new commit${plural}, none of its files touched${onto}.`
              : `Rebased onto your latest ${sync.commits} commit${plural} while this agent waited.`;
    const blocked = sync.blocked.length > 0 ? `Couldn't rebase in ${sync.blocked.join(`, `)}; its land may need a resolve.` : undefined;
    return [moved, blocked].filter((line) => line !== undefined).join(` `);
};

// Row for a spawned child's work gone into its parent's checkout, or held off it by a clash with the parent's edits.
const intoParentRow = (event: Extract<AgentEvent, { kind: "landed" }>): TranscriptRow => {
    if (event.landed) {
        return {
            role: "notice",
            text: `Changes went into the parent agent's checkout; they land with it.`,
            noticeCode: noticeCode({ code: "intoParent" }),
        };
    }
    const files = (event.conflicts ?? []).flatMap((conflict) => conflict.paths).length;
    return {
        role: "notice",
        text: `${files} ${files === 1 ? `file clashes` : `files clash`} with the parent agent's edits; the parent was told.`,
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
        return { role: "notice", text: `Finished: ready to land from this agent's review.`, noticeCode: noticeCode({ code: "landHeld" }) };
    }
    if (!event.landed) {
        // Per-file cause (your edits, a moved main line, a binary) is spelled out in the review, not named here.
        const conflicts = event.conflicts ?? [];
        const files = conflicts.flatMap((conflict) => conflict.paths).length;
        const repos = conflicts.map((conflict) => conflict.repo).join(`, `);
        return {
            role: "notice",
            text: `${files} ${files === 1 ? `file` : `files`} couldn't land in ${repos}: resolve in the agent's review.`,
            noticeCode: noticeCode({ code: "landConflict", params: { files, repos } }),
        };
    }
    // An install the land started is the one follow-up offered; a landed row never asks the user to change how this agent lands.
    const deps = event.deps === undefined || event.deps.missing === 0 ? undefined : event.deps;
    const row: TranscriptRow = {
        role: "notice",
        // A home's land (the only one named) is committed too, by nobody pressing anything: said, not left to the Changes panel.
        text: `${event.land === undefined ? "Landed in your workspace." : "Landed and committed."}${dependencyLine(event.deps)}`,
        noticeCode: noticeCode({
            code: "landed",
            params: deps === undefined && event.land === undefined ? undefined : { deps: deps?.missing, queued: deps?.deferred || undefined, land: event.land },
        }),
    };
    if ((event.deps?.started.length ?? 0) > 0) {
        row.noticeAction = "depsInstall";
    }
    return row;
};
