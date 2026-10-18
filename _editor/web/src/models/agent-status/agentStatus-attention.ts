import type { AgentAttention, AgentStatus } from "@intentic/sandbox-contract/schemas/agents";
import { formatCount } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { useVocabulary } from "../../workbench/views/vocabulary";
import { failureKind, failureOpensChat, failureWord } from "./agentStatus-failure";
import {
    type AgentStanding,
    bookingAnswers,
    type ClientAgentStatus,
    conflictIsYours,
    heldByPrompt,
    landBroken,
    limited,
    memoryHeld,
    unregistered,
} from "./agentStatus-standing";

// One table for the chip word and drill-in verb per attention flag, in display rank order, so the two can't drift
// apart as they did before. `satisfies Record<keyof AgentAttention, …>` makes a new wire flag a build error until
// both words exist. Kept short: the chip is `shrink-0` beside the title, so every character taken grows at the
// agent name's expense.
const attentionWords = () =>
    ({
        plan: { chip: t(`agents.agentStatus.approvalNeeded`), verb: t(`agents.agentStatus.reviewPlan`) },
        // Outranks a question: parked on a setup only the user can do. Verb names the work, since this click leads into a
        // flow rather than a one-press approval.
        capability: { chip: t(`agents.agentStatus.setupNeeded`), verb: t(`agents.words.setUp`) },
        // Waits for an exact list of addresses the owner named; the daemon refuses everybody else
        // (secrets/credential-gate.ts). Ranked above a question, below setup: it blocks outright like a setup but is a
        // yes/no rather than a decision to read. Verb names the destination, not the action ("Release" would promise
        // something the reader may be unable to do).
        credential: { chip: t(`agents.agentStatus.releaseNeeded`), verb: t(`agents.agentStatus.seeRequest`) },
        // Something the agent asked a person for that outlives the turn (a connection, a secret, reach, a tool): ranked
        // with a setup, since it is one, and worded for what the reader does, which is answer it where it is drawn.
        need: { chip: t(`agents.agentStatus.needsYou`), verb: t(`agents.agentStatus.seeWhatItNeeds`) },
        question: { chip: t(`agents.agentStatus.question`), verb: t(`ui.action.answer`) },
        // Ranked last, the most routine and cheapest park to clear: a plan, a spend or a setup wants reading first. Chip
        // reads "Permission" alone, not "Approval needed" (a plan's word) or "Permission needed" (too long at the card's
        // lane width, and the only thing naming the state on mobile where the drill-in verb doesn't render).
        permission: { chip: t(`agents.agentStatus.permission`), verb: t(`ui.action.approve`) },
        // Verb names the report, not the fix: the fix is its own button one line above the drill-in (AgentCard). Two
        // controls both promising to resolve the conflict, only one of which does, is worse than one of each.
        conflict: { chip: t(`agents.agentStatus.landConflict`), verb: t(`agents.agentStatus.seeWhatBlocked`) },
    }) as const satisfies Record<keyof AgentAttention, { chip: string; verb: string }>;

// The rank for both readings. Spelled out rather than read off the table above, which is a function now: calling it
// here, while this module is still being imported, would ask for words before any catalog is registered.
const ATTENTION_RANK = [
    `plan`,
    `capability`,
    `need`,
    `credential`,
    `question`,
    `permission`,
    `conflict`,
] as const satisfies readonly (keyof AgentAttention)[];

// The flag this card leads with, read once so the chip and verb are always about the same park. Raised flags are
// checked before the `conflict` status; a live park with someone waiting outranks a fact about where work came to
// rest.
const leadingPark = (agent: AgentStanding): keyof AgentAttention | undefined =>
    ATTENTION_RANK.find((flag) => agent.attention[flag]) ?? (agent.status === `conflict` ? `conflict` : undefined);

// The one refusal whose chip reads "Your edits": the card leads with a land conflict only the reader's own uncommitted
// edits stand in. What a surface that names the Sandbox pages behind such a refusal keys off (settingsChip), never the
// word itself.
export const editsRefusal = (agent: AgentStanding): boolean =>
    !limited(agent) && !memoryHeld(agent) && leadingPark(agent) === `conflict` && conflictIsYours(agent);

// The one-line "why this card needs you" label, shared by the card chip, the Changes legend's hover card, and any
// future toast.
export const attentionReason = (agent: AgentStanding): string | undefined => {
    // "Usage limit": the vendor's own phrase, not "allowance" which reads as jargon. Naming the condition here is the
    // whole fix; the card's body is left to say what the card is rather than what happened to it. Short, since the
    // chip is `shrink-0` beside the agent's name.
    if (limited(agent)) {
        return t(`agents.agentStatus.usageLimit`);
    }
    // Held, not failed: the chip is the word the reader acts on ("send anyway"), and "error" sent people hunting a fault.
    // Once its words are booked for later the hold is answered, and the corner says when they go instead (standingChip).
    if (memoryHeld(agent) && !bookingAnswers(agent)) {
        return t(`agents.agentStatus.held`);
    }
    const park = leadingPark(agent);
    if (park !== undefined) {
        // Same length as the generic word it replaces, and it names the half of the report the reader can act on:
        // "Land conflict" beside a button only they can press read as the agent's problem.
        return editsRefusal(agent) ? t(`agents.agentStatus.edits`) : attentionWords()[park].chip;
    }
    // A land that broke says so rather than "Error": the turn itself finished, and its work is what is stuck.
    if (landFailure(agent) !== undefined) {
        return useVocabulary().value.couldntLand;
    }
    // Before the endings: the turn ended cleanly, and what holds the card is a command it left at a prompt. Its own short
    // word, since a chip beside the name has no room for "Waiting for input": the readout says that, with the clock.
    if (heldByPrompt(agent)) {
        return t(`agents.agentStatus.needsInput`);
    }
    // An ending something booked answers names no reason: the card is Active, and its corner says when the booking goes
    // ("Scheduled"), where "Error" beside a clock already counting to the send read as a fault nobody had dealt with.
    if (bookingAnswers(agent)) {
        return undefined;
    }
    // A failure the daemon classified says what kind it was ("No access", "Provider down"), never the bare "Error" a
    // crash wears: the kind is what tells the reader whether to switch account, wait, or read what broke.
    const kind = failureKind(agent);
    if (kind !== undefined) {
        return failureWord(kind);
    }
    // A park the attention block can't name: `awaiting` covers a browser or terminal hand-off, neither of which raises
    // a wire flag, so it arrives as a bare status. Checked last, only once nothing more specific applies.
    return endingReasons()[agent.status] ?? (agent.status === `awaiting` ? t(`agents.agentStatus.waitingOn`) : undefined);
};

// A land that broke: the daemon ran git to carry the work into the workspace and git refused, or the agent's copy lost
// its link to it, which is a different thing from the agent erring, and the one ending a card must never let read as
// finished. The sandbox keeps it on the card until a land goes through (`landFailure`, landBroken); one older than that
// says it only as the turn's failure, the raw `Command failed: git …` it ended on, which the next turn clears.
// Undefined for every other card; otherwise the reason in plain words, git's own last line where no plainer one fits.
// The raw sentence stays in the card's hover.
const GIT_FAILURE = /^Command failed: git\b/u;
// Git's words for a checkout that no longer shares history with the workspace: an object or range it cannot find, or
// a link it cannot follow. Said as what it means to the reader, since "bad object 3e03077" means nothing to them.
// The daemon's git runs untranslated, so these are git's English whatever the locale.
// allow(dependency-text): git's stderr wording; an unmatched one is quoted as git's verdict line below, never misnamed.
const LOST_LINK = /bad object|invalid symmetric difference|unknown revision|not a git repository|\.git file broken|not a valid object/iu;
// Git's verdict: the last `fatal:` or `error:` line of the message, which is execFile's `Command failed: git …` line
// followed by git's stderr whole (`apply` says `error:`, most verbs `fatal:`, and a hint can follow the verdict).
// allow(dependency-text): git's `fatal:`/`error:` line prefixes; a message without one reads as the generic gitRefused.
const GIT_VERDICT = /^(?:fatal|error): (.+)$/gmu;
// Older sandboxes kept only the runner's sentence. Recognise those as well as the stable codes newer ones send.
// allow(dependency-text): Node/Bun spawn and buffer errors, and our runner's own exit message; unknown failures keep their verdict.
export const landFailureCode = (reason: string, code?: string): string | undefined => {
    if (/E2BIG|argument list too long/iu.test(reason)) { return `too_many_paths`; }
    if (/maxBuffer|ERR_CHILD_PROCESS_STDIO_MAXBUFFER/iu.test(reason)) { return `output_limit`; }
    if (/the forker exited/iu.test(reason)) { return `forker_exited`; }
    return code;
};

export const retryLand = (agent: AgentStanding): boolean =>
    landFailure(agent) !== undefined && landFailureCode(agent.landFailure?.reason ?? agent.failure ?? ``, agent.landFailure?.code) === `forker_exited`;

const internalReason = (reason: string, code?: string): string | undefined => {
    switch (landFailureCode(reason, code)) {
        case `forker_exited`: return t(`agents.agentStatus.landProcessStopped`);
        case `too_many_paths`: return t(`agents.agentStatus.landTooManyPaths`);
        case `output_limit`: return t(`agents.agentStatus.landOutputLimit`);
        default: return undefined;
    }
};

// Used by both the report and the card's hover, with the count formatted in the reader's locale by i18n.
export const workspaceOverlap = (count: number): string | undefined =>
    count > 3_000 ? t(`agents.agentStatus.workspaceOverlap`, { count: formatCount(count) }) : undefined;

// Git's refusal as the reader is told it.
const gitReason = (failure: string): string => {
    const internal = internalReason(failure);
    if (internal !== undefined) { return internal; }
    if (LOST_LINK.test(failure)) {
        return t(`agents.agentStatus.lostLink`);
    }
    const said = [...failure.matchAll(GIT_VERDICT)].at(-1)?.[1]?.trim();
    return said === undefined || said === `` ? t(`agents.agentStatus.gitRefused`) : said;
};
export const landFailure = (agent: AgentStanding): string | undefined => {
    const broke = agent.landFailure;
    if (broke !== undefined) {
        if (!landBroken(agent)) {
            return undefined;
        }
        // The sandbox's own sentence for a lost link is long and English; the code says it in the reader's language.
        return internalReason(broke.reason, broke.code) ?? (broke.code === `unlinked` ? t(`agents.agentStatus.lostLink`) : GIT_FAILURE.test(broke.reason) ? gitReason(broke.reason) : broke.reason);
    }
    const failure = agent.failure;
    if (agent.status !== `error` || limited(agent) || failure === undefined || (!GIT_FAILURE.test(failure) && internalReason(failure) === undefined)) {
        return undefined;
    }
    return gitReason(failure);
};

// The word an ending says itself in, for a surface naming how a turn ended rather than why its card is waiting
// ("Didn't start", "Interrupted"); undefined for a status that is no ending of that kind.
export const endingReason = (status: AgentStanding["status"]): string | undefined => endingReasons()[status];

// The endings, tabled rather than chained since a sixth condition (`limited`) has to be checked ahead of them.
// Absent means the card isn't in Attention for a reason worth a chip.
const endingReasons = (): Partial<Record<AgentStatus | ClientAgentStatus, string>> => ({
    error: t(`agents.agentStatus.error`),
    // Names the whole of what happened, in the right tense: not "failed" (nothing ran) or "error" (no agent to have
    // erred). Stops the card reading as a live agent at all.
    failed: t(`agents.agentStatus.didntStart`),
    // The turn didn't fail or finish, its daemon went away. Sending a message starts a fresh turn on the same session.
    interrupted: t(`agents.agentStatus.interrupted`),
    // The user's own decision, so the chip reports it rather than addressing them ("Stopped", not "Stopped by you").
    // `stopping` is the same ending a beat earlier, in the tense it's actually in: still unwinding.
    stopping: t(`agents.agentStatus.stopping2`),
    stopped: t(`agents.agentStatus.stopped`),
});

// The card's drill-in label (desktop): names the destination rather than a generic "Open". A draft has no
// worktree yet, so no review detail. Order: a pending park first, then a special ending, then the diff, falling
// back to "Review".
export const reviewAction = (agent: AgentStanding & { readonly branch?: string; readonly diff?: { files: number } }): string | undefined => {
    if (unregistered(agent.status) || agent.branch === undefined) {
        return undefined;
    }
    // The same flag the chip led with, so the corner's noun and the card's verb are always about the same park.
    const park = leadingPark(agent);
    if (park !== undefined) {
        return attentionWords()[park].verb;
    }
    if (retryLand(agent)) { return t(`agents.agentStatus.reviewChanges`); }
    // A spent allowance is not an error to view: there's nothing to diagnose in the transcript, and the destination is
    // the conversation itself. Checked before the `error` branch below, which it would otherwise fall into.
    // Neither is a held message: the press that sends it is in the conversation. Nor a bare park on a browser or a
    // terminal, whose hand-off card is drawn there too (drillTarget).
    if (limited(agent) || memoryHeld(agent) || agent.status === `awaiting`) {
        return t(`agents.agentStatus.openChat`);
    }
    // Nor is a classified failure whose way on is a choice the conversation offers (failureOpensChat); a turn cut short
    // is a report of how far it got, named as a stop's is.
    const kind = failureKind(agent);
    if (kind !== undefined && landFailure(agent) === undefined) {
        return failureOpensChat(kind) ? t(`agents.agentStatus.openChat`) : t(`agents.agentStatus.seeWhereStopped`);
    }
    return (
        endingActions()[agent.status] ??
        (agent.diff !== undefined && agent.diff.files > 0 ? t(`agents.agentStatus.reviewChanges`) : t(`agents.words.review`))
    );
};

// Where the card's drill-in leads. An ask answered on its own card (a plan, a question, a permission, a setup, a
// release, a need, a hand-off) and a spent allowance lead to the chat, where that card and the way on are drawn: the
// review page draws none of them, and an "Approve" that led there was a round trip to a page with nothing to approve.
// A refused land's report, an unclassified error, and a diff to read are the review page's; a classified failure goes
// where its way on is (failureOpensChat).
export const drillTarget = (agent: AgentStanding): `chat` | `review` => {
    const park = leadingPark(agent);
    if (park !== undefined) {
        return park === `conflict` ? `review` : `chat`;
    }
    const kind = failureKind(agent);
    if (kind !== undefined && landFailure(agent) === undefined) {
        return failureOpensChat(kind) ? `chat` : `review`;
    }
    return limited(agent) || memoryHeld(agent) || agent.status === `awaiting` ? `chat` : `review`;
};

// Endings whose destination is named by the ending itself rather than by the diff; tabled for the same reason as
// `endingReasons`. Anything absent falls to the diff reading below.
const endingActions = (): Partial<Record<AgentStatus | ClientAgentStatus, string>> => ({
    error: t(`agents.agentStatus.viewError`),
    // Destination is the transcript, where the cut-off tool call is itself the report. One label for both endings:
    // whether the daemon died or the user stopped it, the question is the same, how far did it get?
    interrupted: t(`agents.agentStatus.seeWhereStopped`),
    stopped: t(`agents.agentStatus.seeWhereStopped`),
    // Names both halves of the destination: reading the held work and landing it. The card's own primary button lands
    // without the trip (AgentCard).
    ready: useVocabulary().value.reviewAndLand,
});
