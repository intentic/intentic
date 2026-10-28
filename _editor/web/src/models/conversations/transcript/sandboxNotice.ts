import { type ResumeNoticeReason, type SandboxNotice, sandboxNoticeOf } from "@intentic/sandbox-contract/events/sandbox-notice";
import type { TranscriptRow, WatchOutcome } from "@intentic/sandbox-contract/events/transcript";
import { accountsLabel } from "@intentic/sandbox-contract/schemas/providers/switched";
import { t } from "@intentic/ui/i18n";
import type { Audience } from "../../../app/useAudience";
import { type FailureView, failureView, legacyFailure } from "../../agent-status/failureView";
import { modelLabelFor, providerDisplayLabel } from "../../providers/providerCatalog";

/*
 * The sandbox's own notice rows in the reader's language and words. The sandbox writes each as an English sentence
 * (`text`, what older apps and stored records read) with a code and the facts it was worded from beside it
 * (`noticeCode`, sandbox-notice.ts); this says the same thing through the catalog. A row with no code, or a code this
 * build does not know (a sandbox older or newer than the app), is drawn from its text as before. The rows another
 * agent's words, a watch or an answered need open carry their facts as fields of their own, and are worded from those.
 * In English, for a developer, every line here is the sandbox's sentence word for word; sandboxNotice.test.ts holds
 * that against the fold itself. The one exception is a failure in the provider's or the harness's words: its line is
 * this build's own for the failure's kind (failureView.ts), and the row opens those words as details (noticeFailure).
 */

type NoticeRow = Pick<TranscriptRow, "noticeCode" | "watchWake" | "needWake" | "agentWords"> & { readonly text?: string };

/** Where the row is read: a home conversation's lands are committed as well (the daemon's version-landed.ts). */
export interface NoticePlace {
    readonly home?: boolean;
}

// The land outcomes, whole sentences per audience rather than a word swapped into one: "land" and "branch" for a
// developer, "accept" and "draft" for a maker (workbench/views/vocabulary.ts).
interface LandWords {
    readonly landed: () => string;
    // A home's land, which its own commit follows, so the Changes panel the plain one points to holds none of it.
    readonly homeLanded: () => string;
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
        homeLanded: () => t(`chat.sandboxNotice.developer.homeLanded`),
        landHeld: () => t(`chat.sandboxNotice.developer.landHeld`),
        landConflict: (count, repos) => t(`chat.sandboxNotice.developer.landConflict`, { count, repos }, count),
        intoParent: () => t(`chat.sandboxNotice.developer.intoParent`),
        intoParentClash: (count) => t(`chat.sandboxNotice.developer.intoParentClash`, { count }, count),
        rebased: (count) => t(`chat.sandboxNotice.developer.rebased`, { count }, count),
        rebaseBlocked: (repos) => t(`chat.sandboxNotice.developer.rebaseBlocked`, { repos }),
    },
    maker: {
        landed: () => t(`chat.sandboxNotice.maker.landed`),
        homeLanded: () => t(`chat.sandboxNotice.maker.homeLanded`),
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
    trimmed: () => t(`chat.sandboxNotice.resumed.trimmed`),
    summarized: () => t(`chat.sandboxNotice.resumed.summarized`),
    refused: () => t(`chat.sandboxNotice.resumed.refused`),
    door: () => t(`chat.sandboxNotice.resumed.door`),
    overflow: () => t(`chat.sandboxNotice.resumed.overflow`),
    flagged: () => t(`chat.sandboxNotice.resumed.flagged`),
    continued: () => t(`chat.sandboxNotice.resumed.continued`),
} as const satisfies Readonly<Record<ResumeNoticeReason, () => string>>;

const WATCH_WAKE = {
    met: (note, elapsed) => t(`chat.sandboxNotice.watchWake.met`, { note, elapsed }),
    timeout: (note, elapsed) => t(`chat.sandboxNotice.watchWake.timeout`, { note, elapsed }),
    broken: (note, elapsed) => t(`chat.sandboxNotice.watchWake.broken`, { note, elapsed }),
    "restart-expired": (note, elapsed) => t(`chat.sandboxNotice.watchWake.restartExpired`, { note, elapsed }),
} as const satisfies Readonly<Record<WatchOutcome, (note: string, elapsed: string) => string>>;

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
    | `retrying`
    | `retried`
    | `outageWaiting`
    | `renewing`
    | `renewalWithdrawn`
    | `reconnect`
    | `undelivered`
    | `stoppedPartway`
    | `kept`
    | `memoryHeld`
    | `failed`
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
    `stoppedPartway`,
    `kept`,
    `memoryHeld`,
    `failed`,
]);
const isFailure = (notice: SandboxNotice): notice is FailureNotice => FAILURE_CODES.has(notice.code);
// What a turn started from (the contract's notice-rows.ts): what a thin send left out, how a held turn continued, where
// a home's session started over, and what the turn switched to since the one before it.
type StartingNotice = Coded<`contextTrim` | `handedOff` | `freshStart` | `switched`>;
const STARTING_CODES: ReadonlySet<SandboxNotice[`code`]> = new Set([`contextTrim`, `handedOff`, `freshStart`, `switched`]);
const isStarting = (notice: SandboxNotice): notice is StartingNotice => STARTING_CODES.has(notice.code);

// Where the work went, in the audience's own words.
const landLine = (notice: LandNotice, land: LandWords, place: NoticePlace): string => {
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
            // Only a home's land is named (the daemon's land-rows.ts), so a named one reads as committed wherever it is drawn.
            return sentences(
                place.home === true || notice.params?.land !== undefined ? land.homeLanded() : land.landed(),
                dependencies(notice.params?.deps, notice.params?.queued),
            );
    }
};

// A failure's own line (failureView.ts), then what the sandbox did or will do about it.
const failureLine = (notice: FailureNotice): string => {
    const message = failureView(notice.params).line;
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
        case `stoppedPartway`:
            return notice.params.switchModel === true
                ? t(`chat.sandboxNotice.stoppedPartwaySwitch`, { message })
                : t(`chat.sandboxNotice.stoppedPartway`, { message });
        case `kept`:
            return notice.params.memory === true ? t(`chat.sandboxNotice.keptMemory`, { message }) : t(`chat.sandboxNotice.kept`, { message });
        case `memoryHeld`:
            return t(`chat.sandboxNotice.memoryHeld`, { message });
        case `failed`:
            return message;
    }
};

// The notices that carry no facts: one fixed sentence each.
type PlainNotice = Coded<`compacted` | `stopped` | `questionDismissed` | `planApproved` | `keptPlanning` | `restartInterrupted`>;
const PLAIN = {
    compacted: () => t(`chat.sandboxNotice.compacted`),
    stopped: () => t(`chat.sandboxNotice.stopped`),
    questionDismissed: () => t(`chat.sandboxNotice.questionDismissed`),
    planApproved: () => t(`chat.sandboxNotice.planApproved`),
    keptPlanning: () => t(`chat.sandboxNotice.keptPlanning`),
    restartInterrupted: () => t(`chat.sandboxNotice.restartInterrupted`),
} as const satisfies Readonly<Record<PlainNotice[`code`], () => string>>;
const isPlain = (notice: SandboxNotice): notice is PlainNotice => Object.hasOwn(PLAIN, notice.code);

const codedLine = (notice: SandboxNotice, audience: Audience, place: NoticePlace): string => {
    if (isLand(notice)) {
        return landLine(notice, LAND_WORDS[audience], place);
    }
    if (isFailure(notice)) {
        return failureLine(notice);
    }
    if (isStarting(notice)) {
        return startingLine(notice, audience);
    }
    if (isPlain(notice)) {
        return PLAIN[notice.code]();
    }
    switch (notice.code) {
        case `watching`:
            return t(`chat.sandboxNotice.watching`, { note: notice.params.note, every: notice.params.every });
        case `resumed`:
            return RESUMED[notice.params.reason]();
        case `keptWarm`:
            return t(`chat.sandboxNotice.keptWarm`, notice.params, notice.params.refreshes);
        case `keptCold`:
            return t(`chat.sandboxNotice.keptCold`, notice.params, notice.params.refreshes);
        case `installing`:
            return installingLine(notice);
        case `accountMoved`:
            return ACCOUNT_MOVED[notice.params.why](notice.params);
    }
};

const startingLine = (notice: StartingNotice, audience: Audience): string => {
    switch (notice.code) {
        case `handedOff`:
            return handedOffLine(notice.params);
        case `freshStart`:
            return audience === `maker` ? freshStartPlain(notice.params) : freshStartLine(notice.params);
        case `switched`:
            return switchedLine(notice.params);
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

// Where a turn ran instead of the conversation's account, and why, both accounts by name (notice-rows.ts accountMovedRow).
type AccountMoved = Coded<`accountMoved`>[`params`];
const ACCOUNT_MOVED = {
    refused: ({ from, to }) => t(`chat.sandboxNotice.accountMoved.refused`, { from, to }),
    reach: ({ from, to }) => t(`chat.sandboxNotice.accountMoved.reach`, { from, to }),
    cold: ({ from, to }) => t(`chat.sandboxNotice.accountMoved.cold`, { from, to }),
} as const satisfies Readonly<Record<AccountMoved[`why`], (move: AccountMoved) => string>>;

// How a held turn continued after a spent allowance: the whole session, a trimmed copy, or a summary (handoff.ts).
const handedOffLine = (params: Extract<SandboxNotice, { code: "handedOff" }>["params"]): string => {
    const { mode, tokens, from, model } = params;
    if (params.fellBack === true) {
        return mode === `trim` ? t(`chat.sandboxNotice.handedOff.trimFellBack`) : t(`chat.sandboxNotice.handedOff.summaryFellBack`);
    }
    if (mode === `carry`) {
        return tokens === undefined ? t(`chat.sandboxNotice.handedOff.carry`) : t(`chat.sandboxNotice.handedOff.carrySized`, { tokens });
    }
    if (mode === `summary`) {
        return model === undefined ? t(`chat.sandboxNotice.handedOff.summary`) : t(`chat.sandboxNotice.handedOff.summaryBy`, { model });
    }
    const cleared = params.cleared ?? 0;
    if (tokens === undefined) {
        return t(`chat.sandboxNotice.handedOff.trim`, { cleared }, cleared);
    }
    return from === undefined
        ? t(`chat.sandboxNotice.handedOff.trimSized`, { tokens, cleared }, cleared)
        : t(`chat.sandboxNotice.handedOff.trimFrom`, { tokens, from, cleared }, cleared);
};

// Where a home conversation's memory starts over (handoff.ts freshStartLine): why, then what the fresh session opened
// with, two clauses the sandbox's own sentence joins with a comma.
type FreshStart = Extract<SandboxNotice, { code: "freshStart" }>["params"];
const FRESH_WHY = {
    budget: (from) => (from === undefined ? t(`chat.sandboxNotice.freshStart.budget`) : t(`chat.sandboxNotice.freshStart.budgetFrom`, { from })),
    cold: (from) => (from === undefined ? t(`chat.sandboxNotice.freshStart.cold`) : t(`chat.sandboxNotice.freshStart.coldFrom`, { from })),
    asked: () => t(`chat.sandboxNotice.freshStart.asked`),
    cleared: () => t(`chat.sandboxNotice.freshStart.cleared`),
} as const satisfies Readonly<Record<FreshStart["why"], (from: string | undefined) => string>>;
const freshStartLine = ({ why, from, model, summarized }: FreshStart): string => {
    if (!summarized) {
        return `${FRESH_WHY[why](from)}${t(`chat.sandboxNotice.freshStart.recent`)}`;
    }
    const carried = model === undefined ? t(`chat.sandboxNotice.freshStart.summary`) : t(`chat.sandboxNotice.freshStart.summaryBy`, { model });
    return `${FRESH_WHY[why](from)}${carried}`;
};
// A maker's: the same two clauses without a token count or the model's name, which say nothing to them.
const FRESH_WHY_PLAIN = {
    budget: () => t(`chat.sandboxNotice.freshStart.plain.budget`),
    cold: () => t(`chat.sandboxNotice.freshStart.plain.cold`),
    asked: () => t(`chat.sandboxNotice.freshStart.asked`),
    cleared: () => t(`chat.sandboxNotice.freshStart.cleared`),
} as const satisfies Readonly<Record<FreshStart["why"], () => string>>;
const freshStartPlain = ({ why, summarized }: FreshStart): string =>
    `${FRESH_WHY_PLAIN[why]()}${summarized ? t(`chat.sandboxNotice.freshStart.plain.summary`) : t(`chat.sandboxNotice.freshStart.plain.recent`)}`;

// What a turn switched to since the one before it (switched.ts switchedLine): the part that changed, named as the app
// names providers and models, then whether the session went with it.
type Switched = Extract<SandboxNotice, { code: "switched" }>["params"];
const switchedTo = ({ segment, provider, model, account, loop }: Switched): string => {
    switch (segment) {
        case `provider`:
            return t(`chat.sandboxNotice.switched.provider`, { provider: providerDisplayLabel(provider) });
        case `account`:
            return account === undefined
                ? t(`chat.sandboxNotice.switched.anotherAccount`, { provider: accountsLabel(provider) })
                : t(`chat.sandboxNotice.switched.account`, { account });
        case `loop`:
            return loop === undefined ? t(`chat.sandboxNotice.switched.anotherLoop`) : t(`chat.sandboxNotice.switched.loop`, { loop });
        case `model`:
            return model === undefined
                ? t(`chat.sandboxNotice.switched.anotherModel`)
                : t(`chat.sandboxNotice.switched.model`, { model: modelLabelFor(provider, model) });
    }
};
const switchedLine = (params: Switched): string =>
    `${switchedTo(params)}${params.fresh ? t(`chat.sandboxNotice.switched.fresh`) : t(`chat.sandboxNotice.switched.same`)}`;

// Another agent's words, named by its title where it had one, else by its id.
const agentWordsLine = ({ kind, from, title, failed, machine }: NonNullable<TranscriptRow["agentWords"]>): string => {
    if (kind === `peer`) {
        return title === undefined ? t(`chat.sandboxNotice.agentWords.peer`, { from }) : t(`chat.sandboxNotice.agentWords.peerTitled`, { from, title });
    }
    // A child is named by its title alone (its id is noise beside one), and by the machine it ran on when that was not here.
    const on = machine !== undefined;
    if (failed === true) {
        if (title === undefined) {
            return on ? t(`chat.sandboxNotice.agentWords.childFailedOn`, { from, machine }) : t(`chat.sandboxNotice.agentWords.childFailed`, { from });
        }
        return on
            ? t(`chat.sandboxNotice.agentWords.childFailedTitledOn`, { title, machine })
            : t(`chat.sandboxNotice.agentWords.childFailedTitled`, { title });
    }
    if (title === undefined) {
        return on ? t(`chat.sandboxNotice.agentWords.childFinishedOn`, { from, machine }) : t(`chat.sandboxNotice.agentWords.childFinished`, { from });
    }
    return on
        ? t(`chat.sandboxNotice.agentWords.childFinishedTitledOn`, { title, machine })
        : t(`chat.sandboxNotice.agentWords.childFinishedTitled`, { title });
};

/** The notice's line in the reader's language and words; undefined when only its own text can say it. */
export const noticeLine = (row: NoticeRow, audience: Audience, place: NoticePlace = {}): string | undefined => {
    const notice = sandboxNoticeOf(row);
    if (notice !== undefined) {
        return codedLine(notice, audience, place);
    }
    if (row.watchWake !== undefined) {
        return WATCH_WAKE[row.watchWake.outcome](row.watchWake.note, row.watchWake.elapsed);
    }
    if (row.needWake !== undefined) {
        return row.needWake.outcome === `met`
            ? t(`chat.sandboxNotice.needWake.met`, { title: row.needWake.title })
            : t(`chat.sandboxNotice.needWake.declined`, { title: row.needWake.title });
    }
    if (row.agentWords !== undefined) {
        return agentWordsLine(row.agentWords);
    }
    // A row written before failures were coded, recognised as a provider's failure by its marks: what it says (legacyFailure).
    return row.text === undefined ? undefined : legacyFailure(row.text)?.line;
};

/** The failure a row reports (its line, and the words its details hold); undefined for every other notice. */
export const noticeFailure = (row: NoticeRow): FailureView | undefined => {
    const notice = sandboxNoticeOf(row);
    if (notice !== undefined) {
        return isFailure(notice) ? failureView(notice.params) : undefined;
    }
    const unworded = row.watchWake === undefined && row.needWake === undefined && row.agentWords === undefined;
    return unworded && row.text !== undefined ? legacyFailure(row.text) : undefined;
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
