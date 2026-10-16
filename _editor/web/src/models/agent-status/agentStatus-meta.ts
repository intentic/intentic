import type { IconName } from "@intentic/ui";
import type { AgentOrigin } from "@intentic/sandbox-contract/schemas/agent";
import type { AgentStatus, AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { LoopState } from "@intentic/sandbox-contract/schemas/loops";
import type { SubagentStatus } from "@intentic/sandbox-contract/schemas/terminal";
import { t } from "@intentic/ui/i18n";
import { useAudience } from "../../app/useAudience";
import { useVocabulary } from "../../workbench/views/vocabulary";
import { plainToolWords } from "../../lib/toolWords/toolWords";
import { type AgentStanding, type ClientAgentStatus, memoryHeld } from "./agentStatus-standing";

// One entry per status, no fallthrough. A table rather than an if-chain: `satisfies` over the full union makes an
// unhandled status a build error instead of silently drawing it as idle.
const statusMeta = () =>
    ({
        // Not `pencil`, that's the card's rename affordance; the draft glyph is a not-yet-started marker.
        draft: { icon: `circle`, label: t(`agents.agentStatus.draft`), class: `text-subtle` },
        // Says where it came from, not how it ended (that's unknowable, the registry entry that would say is gone). Glyph
        // matches the search footer's "In earlier chats".
        resumed: { icon: `history`, label: t(`agents.agentStatus.earlierChat`), class: `text-subtle` },
        // Send was refused: nothing of the user's is at risk, so warning rather than `error`'s danger. This agent doesn't
        // exist; the card is for work that never started.
        failed: { icon: `exclamation-triangle`, label: t(`agents.agentStatus.didntStart`), class: `text-warning` },
        // The turn has gone but the daemon hasn't filed it yet; drawn from what this browser knows, not the registry.
        starting: { icon: `spinner`, spin: true, label: t(`ui.status.starting`), class: `text-link` },
        running: { icon: `spinner`, spin: true, label: t(`shared.running`), class: `text-link` },
        // The Stop press landed and the turn is unwinding. Muted rather than a spinner: this is the tail of something
        // ending, not new work.
        stopping: { icon: `stop`, label: t(`agents.agentStatus.stopping`), class: `text-subtle` },
        // The other way a person ends a turn (waving away what it was parked on). Wears the finish it's about to become
        // rather than a second kind of halt.
        dismissing: { icon: `check-circle`, label: t(`agents.agentStatus.finishing`), class: `text-subtle` },
        // The turn stopped without ending (something underneath broke) and the daemon is already restarting it; running
        // spinner and blue since nothing failed and work is still in progress.
        resuming: { icon: `spinner`, spin: true, label: t(`agents.agentStatus.resuming`), class: `text-link` },
        // The daemon is rebasing the branch and carrying its work into the workspace; nothing has finished yet, nothing has
        // failed, and nothing may act on the branch until it settles, so the running spinner and blue.
        landing: { icon: `spinner`, spin: true, label: useVocabulary().value.landing, class: `text-link` },
        awaiting: { icon: `exclamation-circle`, label: t(`shared.needs`), class: `text-accent` },
        landed: { icon: `check-circle`, label: useVocabulary().value.landed, class: `text-success` },
        // Finished with auto-land off: work is safe on the branch, waiting for a deliberate Land. Link-blue, not an
        // attention hue, since the user chose this.
        ready: { icon: `download`, label: useVocabulary().value.readyToLand, class: `text-link` },
        conflict: { icon: `exclamation-triangle`, label: t(`agents.agentStatus.conflict`), class: `text-warning` },
        error: { icon: `exclamation-triangle`, label: t(`agents.agentStatus.error`), class: `text-danger` },
        // Warning, not danger: the daemon died underneath it (rebuild, crash), a fact about the sandbox rather than the
        // work. Glyph matches the Stop button.
        interrupted: { icon: `stop`, label: t(`agents.agentStatus.interrupted`), class: `text-warning` },
        // Same kind of ending, by the user's own hand, so quieter than `interrupted`: the reader already knows, since they
        // pressed Stop.
        stopped: { icon: `stop`, label: t(`agents.agentStatus.stopped`), class: `text-subtle` },
        idle: { icon: `circle-fill`, label: t(`agents.agentStatus.idle`), class: `text-subtle` },
    }) as const satisfies Record<AgentStatus | ClientAgentStatus, { icon: IconName; spin?: boolean; label: string; class: string }>;

// The `??` is unreachable by types but kept: an unhandled status here is `undefined.icon` in a render, which takes
// down the whole board, worse than one card reading `Idle`. The wire isn't runtime-typed, so a newer daemon can
// send a status this build has never heard of.
export const agentStatusMeta = (status: AgentStatus | ClientAgentStatus): { icon: IconName; spin?: boolean; label: string; class: string } =>
    statusMeta()[status] ?? statusMeta().idle;

// A card's glyph, read off its standing rather than its status alone: the one `error` that is not one (a message held for
// memory) wears a hold's glyph and says why, in the reader's language, where the daemon's sentence is English.
export const agentStandingMeta = (
    agent: Pick<AgentStanding, "status" | "failureCode">,
): { icon: IconName; spin?: boolean; label: string; class: string } =>
    memoryHeld(agent) ? { icon: `pause`, label: t(`agents.agentStatus.heldMemory`), class: `text-warning` } : agentStatusMeta(agent.status);

// THE CORNER'S QUIET INK. A session card's corner glyph is a solid mark beside the title, not a word: drawn in a type
// ink (`subtle`, `muted`) an idle dot or a stopped square read as the darkest thing on a light card. Wherever a status
// says it quietly, the corner says it in `faint`, the mark ink (semantic-colors.css), which the dark scheme answers as
// `subtle` and so leaves as it was. Every other ink (a spinner's link, a failure's danger) is the corner's to keep.
const QUIET_INKS: ReadonlySet<string> = new Set([`text-subtle`, `text-muted`]);
export const cornerInk = (classes: string): string =>
    classes
        .split(` `)
        .map((name) => (QUIET_INKS.has(name) ? `text-faint` : name))
        .join(` `);

// The same glyphs for a subagent a runtime ran in-process, which has no conversation and so no AgentStatus, only the
// roster's word (SubagentStatus). Where the two vocabularies name the same standing they wear the same glyph, so a tray
// holding both kinds reads as one list: working spins as `running` does, a failure is `error`'s, a stop `stopped`'s.
const subagentMeta = () =>
    ({
        // Waiting for a slot under the sandbox's concurrency ceiling; nothing has started.
        pending: { icon: `clock`, label: t(`agents.childRows.queued`), class: `text-subtle` },
        running: statusMeta().running,
        // Its question goes to its parent's own turn, whose card carries the ask; the row only says it is waiting.
        blocked: { icon: `question-circle`, label: t(`agents.childRows.needsInput`), class: `text-warning` },
        paused: { icon: `clock`, label: t(`agents.childRows.paused`), class: `text-warning` },
        completed: { icon: `check-circle`, label: t(`agents.childRows.completed`), class: `text-success` },
        failed: statusMeta().error,
        killed: statusMeta().stopped,
    }) as const satisfies Record<SubagentStatus, { icon: IconName; spin?: boolean; label: string; class: string }>;

// The `??` for the same reason as agentStatusMeta's: a newer daemon's status this build has never heard of.
export const subagentStatusMeta = (status: SubagentStatus): { icon: IconName; spin?: boolean; label: string; class: string } =>
    subagentMeta()[status] ?? statusMeta().idle;

// What to call a conversation whose title the first turn has not minted yet (a new tab, an untitled history entry).
// The composer's own unsent words beat any placeholder: they are what the reader wrote, and what they will recognise.
// Those words are passed in rather than read off the card: they live in `chatPreviews`, keyed by id, so that typing
// rebuilds nothing but the one thing drawing them (useAgents-fleet.FleetAgent.unsent).
export const agentDisplayTitle = (agent: { readonly title?: string; readonly status: AgentStatus | ClientAgentStatus }, preview?: string): string => {
    if (agent.title !== undefined) {
        return agent.title;
    }
    if (preview !== undefined) {
        return preview;
    }
    if (agent.status === `draft`) {
        return useVocabulary().value.draftTitle;
    }
    return agent.status === `resumed` ? t(`agents.agentStatus.untitledChat`) : useVocabulary().value.untitledAgent;
};

// The same two-level fold for what happens when a turn breaks lives in models/conversations/endings/turnBreak.ts (`effectivePolicy`),
// beside the words for each answer: one question per ending, asked in one vocabulary by every surface.

// Sources an agent can be opened by, keyed on `AgentOrigin.provider` (an open string; listener sources are
// extension-declared), so an unrecognized one falls back to its own name rather than disappearing.
const originSources = (): Record<string, { icon: IconName; label: string }> => ({
    discord: { icon: `comments`, label: `Discord` },
    slack: { icon: `comments`, label: `Slack` },
    imap: { icon: `envelope`, label: t(`agents.agentStatus.email`) },
    webchat: { icon: `globe`, label: t(`agents.agentStatus.visitorChat`) },
    webhook: { icon: `bolt`, label: t(`agents.agentStatus.webhook`) },
});

// The card's "came in from outside" line: what opened it, who sent it, and which automation was configured to
// answer. The hint carries only what OriginMark doesn't already print (source and sender), so nothing is said
// twice.
export const originMeta = (origin: AgentOrigin): { icon: IconName; label: string; detail: string | undefined; hint: string } => {
    const source = originSources()[origin.provider] ?? { icon: `wave-pulse` as IconName, label: origin.provider };
    const where = origin.channelId !== undefined ? t(`agents.agentStatus.inChannel`, { channel: origin.channelId }) : ``;
    return {
        icon: source.icon,
        label: source.label,
        detail: origin.author,
        hint: t(`agents.agentStatus.openedByAutomationFirst`, { automationId: origin.automationId, where }),
    };
};

// The concrete step a turn is on: the tool with what it reached for, else the checklist item it is working through.
// A maker reads it as the act ("Reading app.ts"), not as the tool and its arguments ("Bash cd /work && rg ...").
export const currentAction = (activity: AgentSummary["activity"]): string | undefined => {
    if (activity?.tool === undefined) {
        return activity?.todo;
    }
    return useAudience().maker.value
        ? plainToolWords({ name: activity.tool, target: activity.target })
        : [activity.tool, activity.target].filter(Boolean).join(` `);
};

/* A working child's activity takes precedence over its parent's idle tool. */
export const activityLine = (agent: Pick<AgentSummary, "activity" | "subagents">): string | undefined => {
    const activity = agent.activity;
    const own =
        activity === undefined
            ? undefined
            : (activity.todo ?? (activity.tool !== undefined && useAudience().maker.value ? plainToolWords({ name: activity.tool }) : activity.tool));
    const running = agent.subagents?.running ?? 0;
    if (running === 0) {
        return own;
    }
    return [t(`agents.agentStatus.subagents`, { count: running }, running), own].filter(Boolean).join(` · `);
};

// Context-window fill percentage (0–100), clamped; undefined when either side is unknown.
export const contextPct = (tokens: number | undefined, window: number | undefined): number | undefined =>
    tokens === undefined || window === undefined || window === 0 ? undefined : Math.min(100, Math.round((tokens / window) * 100));

// The activity line's icon by tool family, a glanceable "what is it doing" glyph, mock-style.
export const activityIcon = (tool: string | undefined): IconName => {
    if (tool === undefined) {
        return `list-check`; // a todo line without a tool
    }
    if (tool === `Edit` || tool === `Write` || tool.startsWith(`mcp__`)) {
        return `pencil`;
    }
    if (tool === `Bash` || tool === `BashOutput`) {
        return `code`;
    }
    if (tool === `Read`) {
        return `file`;
    }
    if (tool === `Grep` || tool === `Glob` || tool.includes(`search`)) {
        return `search`;
    }
    return `sparkles`;
};

// How a loop reads on a card: one line naming both the destination and the position ("iteration 3/12 · until
// <goal>"), the two facts that separate a loop from an ordinary running agent. Ended states are not folded into
// one "finished": `stalled` needs a person (nothing changed while work remained, a prompt problem, not a capacity
// one), unlike `done` or `exhausted`.
export const loopMeta = (loop: NonNullable<AgentSummary["loop"]>): { readonly text: string; readonly class: string; readonly spin: boolean } => {
    if (loop.state === `running`) {
        return {
            text: t(`agents.agentStatus.loopIteration`, { iteration: loop.iteration, max: loop.maxIterations, goal: loop.goal }),
            class: `text-link`,
            spin: true,
        };
    }
    const ended: Record<Exclude<LoopState, "running">, { readonly text: string; readonly class: string }> = {
        done: { text: t(`agents.agentStatus.loopDone`, { iteration: loop.iteration }), class: `text-success` },
        // Each names what to do about it: exhausted wants more room, stalled wants a better prompt, overspent wants a
        // decision.
        exhausted: { text: t(`agents.agentStatus.loopExhausted`, { iteration: loop.iteration }), class: `text-warning` },
        stalled: { text: t(`agents.agentStatus.loopStalled`, { iteration: loop.iteration }), class: `text-warning` },
        overspent: { text: t(`agents.agentStatus.loopOverspent`, { iteration: loop.iteration }), class: `text-warning` },
        // Wants a priced runtime or no ceiling: its runtime reports no cost, so the ceiling could not hold.
        unpriced: { text: t(`agents.agentStatus.loopUnpriced`, { iteration: loop.iteration }), class: `text-warning` },
        stopped: { text: t(`agents.agentStatus.loopStopped`, { iteration: loop.iteration }), class: `text-muted` },
        error: { text: t(`agents.agentStatus.loopFailed`, { iteration: loop.iteration }), class: `text-danger` },
    };
    return { ...ended[loop.state], spin: false };
};

// Threshold between a wait ("in 27m", readable at a glance) and the instant itself ("Thu 14:05", where "in 244m" would
// be arithmetic); same threshold as the chat strip's own switch (chat/pickUp.ts).
export const CLOCK_FROM_MS = 90 * 60 * 1_000;
