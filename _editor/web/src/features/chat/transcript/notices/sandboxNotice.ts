import { type ResumeNoticeReason, type SandboxNotice, sandboxNoticeOf, type TranscriptRow, type WatchOutcome } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import type { Audience } from "../../../../app/useAudience";
import { memoryShare } from "../held/memoryTip";

/*
 * The sandbox's own notice rows in the reader's language and words. The sandbox writes each as an English sentence
 * (`text`, what older apps and stored records read) with a code and the facts it was worded from beside it
 * (`noticeCode`, sandbox-notice.ts); this says the same thing through the catalog. A row with no code, or a code this
 * build does not know (a sandbox older or newer than the app), is drawn from its text as before. The rows another
 * agent's words, a watch or an answered need open carry their facts as fields of their own, and are worded from those.
 * In English, for a developer, every line here is the sandbox's sentence word for word; sandboxNotice.test.ts holds
 * that against the fold itself.
 */

type NoticeRow = Pick<TranscriptRow, "noticeCode" | "watchWake" | "needWake" | "agentWords">;

type Failure = { readonly message: string; readonly error?: string | undefined };

// The land outcomes, whole sentences per audience rather than a word swapped into one: "land" and "branch" for a
// developer, "accept" and "draft" for a maker (core-views/vocabulary.ts).
interface LandWords {
    readonly landed: () => string;
    readonly landHeld: () => string;
    readonly landConflict: (files: number, repos: string) => string;
    readonly intoParent: () => string;
    readonly intoParentClash: (files: number) => string;
    readonly rebased: (commits: number) => string;
    readonly rebaseBlocked: (repos: string) => string;
}

const LAND_WORDS = {
    developer: {
        landed: () => t(`chat.sandboxNotice.developer.landed`),
        landHeld: () => t(`chat.sandboxNotice.developer.landHeld`),
        landConflict: (count, repos) => t(`chat.sandboxNotice.developer.landConflict`, { count, repos }, count),
        intoParent: () => t(`chat.sandboxNotice.developer.intoParent`),
        intoParentClash: (count) => t(`chat.sandboxNotice.developer.intoParentClash`, { count }, count),
        rebased: (count) => t(`chat.sandboxNotice.developer.rebased`, { count }, count),
        rebaseBlocked: (repos) => t(`chat.sandboxNotice.developer.rebaseBlocked`, { repos }),
    },
    maker: {
        landed: () => t(`chat.sandboxNotice.maker.landed`),
        landHeld: () => t(`chat.sandboxNotice.maker.landHeld`),
        landConflict: (count, repos) => t(`chat.sandboxNotice.maker.landConflict`, { count, repos }, count),
        intoParent: () => t(`chat.sandboxNotice.maker.intoParent`),
        intoParentClash: (count) => t(`chat.sandboxNotice.maker.intoParentClash`, { count }, count),
        rebased: (count) => t(`chat.sandboxNotice.maker.rebased`, { count }, count),
        rebaseBlocked: (repos) => t(`chat.sandboxNotice.maker.rebaseBlocked`, { repos }),
    },
} as const satisfies Readonly<Record<Audience, LandWords>>;

const RESUMED = {
    auth: () => t(`chat.sandboxNotice.resumed.auth`),
    outage: () => t(`chat.sandboxNotice.resumed.outage`),
    restart: () => t(`chat.sandboxNotice.resumed.restart`),
    stopped: () => t(`chat.sandboxNotice.resumed.stopped`),
    limit: () => t(`chat.sandboxNotice.resumed.limit`),
    switched: () => t(`chat.sandboxNotice.resumed.switched`),
    carried: () => t(`chat.sandboxNotice.resumed.carried`),
    refused: () => t(`chat.sandboxNotice.resumed.refused`),
    door: () => t(`chat.sandboxNotice.resumed.door`),
    overflow: () => t(`chat.sandboxNotice.resumed.overflow`),
    flagged: () => t(`chat.sandboxNotice.resumed.flagged`),
} as const satisfies Readonly<Record<ResumeNoticeReason, () => string>>;

const WATCH_WAKE = {
    met: (note, elapsed) => t(`chat.sandboxNotice.watchWake.met`, { note, elapsed }),
    timeout: (note, elapsed) => t(`chat.sandboxNotice.watchWake.timeout`, { note, elapsed }),
    broken: (note, elapsed) => t(`chat.sandboxNotice.watchWake.broken`, { note, elapsed }),
    "restart-expired": (note, elapsed) => t(`chat.sandboxNotice.watchWake.restartExpired`, { note, elapsed }),
} as const satisfies Readonly<Record<WatchOutcome, (note: string, elapsed: string) => string>>;

// A failure the sandbox itself worded, by its code, in the reader's language; any other failure's own sentence is the
// provider's, and stays as it said it. A memory hold keeps its figures, in a few characters.
const failureWords = ({ message, error }: Failure): string => {
    if (error === `agent-busy`) {
        return t(`chat.sandboxNotice.agentBusy`);
    }
    if (error === `sandbox-memory-low`) {
        const share = memoryShare(message);
        return share === undefined ? t(`chat.sandboxNotice.memoryLow`) : t(`chat.sandboxNotice.memoryLowShare`, { share });
    }
    return message;
};

// A landed turn's dependency clause, a sentence of its own after the landed one.
const dependencies = (deps: number | undefined, queued: boolean | undefined): string | undefined => {
    if (deps === undefined || deps === 0) {
        return undefined;
    }
    return queued === true ? t(`chat.sandboxNotice.depsQueued`, { count: deps }, deps) : t(`chat.sandboxNotice.depsInstalling`, { count: deps }, deps);
};

// Where an agent's own install works: the workspace root first, then the named folders, then how many more.
const installWhere = ({ root, projects, more }: Coded<`installing`>[`params`]): string | undefined => {
    const named = [...(root === true ? [t(`chat.sandboxNotice.installRoot`)] : []), ...(projects === undefined ? [] : [projects])].join(`, `);
    if (named === ``) {
        return undefined;
    }
    return more === undefined || more === 0 ? named : t(`chat.sandboxNotice.installMore`, { named, more });
};

// An agent's own install starting: into its own copy, or the main tree, in the projects it names.
const installingLine = (notice: Coded<`installing`>): string => {
    const where = installWhere(notice.params);
    if (notice.params.ownCopy) {
        return where === undefined ? t(`chat.sandboxNotice.installingOwn`) : t(`chat.sandboxNotice.installingOwnIn`, { where });
    }
    return where === undefined ? t(`chat.sandboxNotice.installingMain`) : t(`chat.sandboxNotice.installingMainIn`, { where });
};

// Sentences that each stand whole, one after another, as the sandbox's own text joins them.
const sentences = (...parts: readonly (string | undefined)[]): string => parts.filter((part) => part !== undefined).join(` `);

type Coded<C extends SandboxNotice[`code`]> = Extract<SandboxNotice, { code: C }>;
type LandNotice = Coded<`synced` | `intoParent` | `intoParentClash` | `landHeld` | `landConflict` | `landed`>;
type FailureNotice = Coded<
    `retrying` | `retried` | `outageWaiting` | `renewing` | `renewalWithdrawn` | `reconnect` | `undelivered` | `kept` | `memoryHeld` | `failed`
>;

const LAND_CODES: ReadonlySet<SandboxNotice[`code`]> = new Set([`synced`, `intoParent`, `intoParentClash`, `landHeld`, `landConflict`, `landed`]);
const isLand = (notice: SandboxNotice): notice is LandNotice => LAND_CODES.has(notice.code);
const FAILURE_CODES: ReadonlySet<SandboxNotice[`code`]> = new Set([
    `retrying`,
    `retried`,
    `outageWaiting`,
    `renewing`,
    `renewalWithdrawn`,
    `reconnect`,
    `undelivered`,
    `kept`,
    `memoryHeld`,
    `failed`,
]);
const isFailure = (notice: SandboxNotice): notice is FailureNotice => FAILURE_CODES.has(notice.code);

// Where the work went, in the audience's own words.
const landLine = (notice: LandNotice, land: LandWords): string => {
    switch (notice.code) {
        case `synced`: {
            const { commits, blocked } = notice.params;
            return sentences(commits > 0 ? land.rebased(commits) : undefined, blocked === undefined ? undefined : land.rebaseBlocked(blocked));
        }
        case `intoParent`:
            return land.intoParent();
        case `intoParentClash`:
            return land.intoParentClash(notice.params.files);
        case `landHeld`:
            return land.landHeld();
        case `landConflict`:
            return land.landConflict(notice.params.files, notice.params.repos);
        case `landed`:
            return sentences(land.landed(), dependencies(notice.params?.deps, notice.params?.queued));
    }
};

// A failure's own sentence, then what the sandbox did or will do about it.
const failureLine = (notice: FailureNotice): string => {
    const message = failureWords(notice.params);
    switch (notice.code) {
        case `retrying`:
            return t(`chat.sandboxNotice.retrying`, { message, attempt: notice.params.attempt, of: notice.params.of });
        case `retried`:
            return t(`chat.sandboxNotice.retried`, { message, made: notice.params.made, of: notice.params.of });
        case `outageWaiting`:
            return t(`chat.sandboxNotice.outageWaiting`, { message });
        case `renewing`:
            return t(`chat.sandboxNotice.renewing`, { message });
        case `renewalWithdrawn`:
            return t(`chat.sandboxNotice.renewalWithdrawn`, { message });
        case `reconnect`:
            return t(`chat.sandboxNotice.reconnect`, { message });
        case `undelivered`:
            return notice.params.unattended === true ? t(`chat.sandboxNotice.undeliveredUnattended`, { message }) : t(`chat.sandboxNotice.undelivered`, { message });
        case `kept`:
            return notice.params.memory === true ? t(`chat.sandboxNotice.keptMemory`, { message }) : t(`chat.sandboxNotice.kept`, { message });
        case `memoryHeld`:
            return t(`chat.sandboxNotice.memoryHeld`, { message });
        case `failed`:
            return message;
    }
};

const codedLine = (notice: SandboxNotice, audience: Audience): string => {
    if (isLand(notice)) {
        return landLine(notice, LAND_WORDS[audience]);
    }
    if (isFailure(notice)) {
        return failureLine(notice);
    }
    switch (notice.code) {
        case `compacted`:
            return t(`chat.sandboxNotice.compacted`);
        case `stopped`:
            return t(`chat.sandboxNotice.stopped`);
        case `questionDismissed`:
            return t(`chat.sandboxNotice.questionDismissed`);
        case `planApproved`:
            return t(`chat.sandboxNotice.planApproved`);
        case `keptPlanning`:
            return t(`chat.sandboxNotice.keptPlanning`);
        case `watching`:
            return t(`chat.sandboxNotice.watching`, { note: notice.params.note, every: notice.params.every });
        case `restartInterrupted`:
            return t(`chat.sandboxNotice.restartInterrupted`);
        case `resumed`:
            return RESUMED[notice.params.reason]();
        case `keptWarm`:
            return t(`chat.sandboxNotice.keptWarm`, notice.params, notice.params.refreshes);
        case `keptCold`:
            return t(`chat.sandboxNotice.keptCold`, notice.params, notice.params.refreshes);
        case `installing`:
            return installingLine(notice);
        case `contextTrim`: {
            const { window, omitted, base } = notice.params;
            return sentences(
                omitted === undefined ? t(`chat.sandboxNotice.contextTrim`, { window }) : t(`chat.sandboxNotice.contextTrimOmitted`, { window, omitted }),
                base ? t(`chat.sandboxNotice.contextTrimBase`) : undefined,
                t(`chat.sandboxNotice.contextTrimKept`),
            );
        }
    }
};

// Another agent's words, named by its title where it had one, else by its id.
const agentWordsLine = ({ kind, from, title, failed }: NonNullable<TranscriptRow["agentWords"]>): string => {
    if (kind === `peer`) {
        return title === undefined ? t(`chat.sandboxNotice.agentWords.peer`, { from }) : t(`chat.sandboxNotice.agentWords.peerTitled`, { from, title });
    }
    if (failed === true) {
        return title === undefined
            ? t(`chat.sandboxNotice.agentWords.childFailed`, { from })
            : t(`chat.sandboxNotice.agentWords.childFailedTitled`, { from, title });
    }
    return title === undefined
        ? t(`chat.sandboxNotice.agentWords.childFinished`, { from })
        : t(`chat.sandboxNotice.agentWords.childFinishedTitled`, { from, title });
};

/** The notice's line in the reader's language and words; undefined when only its own text can say it. */
export const noticeLine = (row: NoticeRow, audience: Audience): string | undefined => {
    const notice = sandboxNoticeOf(row);
    if (notice !== undefined) {
        return codedLine(notice, audience);
    }
    if (row.watchWake !== undefined) {
        return WATCH_WAKE[row.watchWake.outcome](row.watchWake.note, row.watchWake.elapsed);
    }
    if (row.needWake !== undefined) {
        return row.needWake.outcome === `met`
            ? t(`chat.sandboxNotice.needWake.met`, { title: row.needWake.title })
            : t(`chat.sandboxNotice.needWake.declined`, { title: row.needWake.title });
    }
    return row.agentWords === undefined ? undefined : agentWordsLine(row.agentWords);
};

// What a daemon says when a conversation's turn is already running, word for word: the resume refusal, an older build's
// refusal of a message (from before a busy conversation queued it instead), and the begin refusal
// (`_sandbox/sandbox/src/agent/run/placement/turn-placement.ts`). A refusal is a status and a sentence, no code, and
// the older builds that say the second will never send one.
const KNOWN_REFUSALS: ReadonlyMap<string, () => string> = new Map([
    [`a turn is already running in that conversation`, () => t(`chat.sandboxNotice.turnRunning`)],
    [`a turn is already running for this conversation`, () => t(`chat.sandboxNotice.turnRunning`)],
    [`This agent is already running a turn, wait for it to finish.`, () => t(`chat.sandboxNotice.agentBusy`)],
]);

/** A refusal the daemon worded, in the reader's language where it is one this build knows; any other as it was said. */
export const refusalWords = (said: string): string => KNOWN_REFUSALS.get(said.trim())?.() ?? said;
