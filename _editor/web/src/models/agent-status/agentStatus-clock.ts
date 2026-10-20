import type { Tip } from "@intentic/ui";
import { formatClock, formatElapsed, formatWhen } from "@intentic/ui/format";
import type { AgentNext } from "@intentic/sandbox-contract/schemas/agent-next";
import type { AgentWatch } from "@intentic/sandbox-contract/schemas/agents";
import { t } from "@intentic/ui/i18n";
import { CLOCK_FROM_MS } from "./agentStatus-meta";
import { type AgentStanding, limitClosed, promptHeldJob } from "./agentStatus-standing";

// An instant a card's corner counts to (a spent allowance's reopen, a scheduled message's time), in the few characters
// the corner has: whole minutes while that is a wait a person can hold (rounded up, as the chat's own press counts
// them), the clock later today, the day past that. Minutes, never seconds: a reset instant is the provider's guess and
// routinely early, so a corner ticking "26m 26s" claimed a precision nobody had. `wait` says which it is, since a wait
// reads "in 27m" and an instant stands bare ("back 14:05"); `at` is the instant (ms), for a hover that names it
// whatever the corner says. Undefined once the instant has passed. `exact` is an instant somebody chose (a booked send),
// counted to the nearest minute as the chat counts it, where a guessed one rounds up so it is never promised early: the
// hour a person booked reads "60m", not "61m".
interface LimitClock {
    readonly at: number;
    readonly text: string;
    readonly wait: boolean;
}
const countdownTo = (at: number, now: number, exact = false): LimitClock | undefined => {
    if (at <= now) {
        return undefined;
    }
    if (at - now < CLOCK_FROM_MS) {
        const minutes = (exact ? Math.round : Math.ceil)((at - now) / 60_000);
        return { at, text: t(`agents.agentStatus.minutes`, { minutes: Math.max(1, minutes) }), wait: true };
    }
    return { at, text: new Date(at).toDateString() === new Date(now).toDateString() ? formatClock(at) : formatWhen(at, now), wait: false };
};

// When a spent allowance reopens (countdownTo). Undefined once the window is open, and for a provider that published no
// instant (Grok, Cursor).
export const limitCountdown = (agent: AgentStanding, now: number): LimitClock | undefined => {
    const reopensAt = agent.limitResetsAt;
    if (!limitClosed(agent, now) || reopensAt === undefined) {
        return undefined;
    }
    return countdownTo(reopensAt * 1_000, now);
};

// "back in 27m", "back Thu 14:05": when the allowance returns, the one thing a card nothing is booked for can plan around.
export const limitBack = (clock: LimitClock): string =>
    clock.wait ? t(`agents.agentCard.backIn`, { limitBackAt: clock.text }) : t(`agents.agentCard.back`, { limitBackAt: clock.text });

/**
 * WHEN A CARD GOES AGAIN BY ITSELF, read off the one thing that says so: the card's `next` (agent-next.ts), which the
 * sandbox derives from what the conversation holds by the rules its movers act by, so this corner, the lane and the chat
 * cannot disagree about whether or when. The chip beside the title says why it waits (Usage limit, Memory low,
 * Scheduled); this corner, in the date's seat, says what goes and when: a held turn's re-run ("resends 02:00") or move
 * ("moving to …"), a memory hold's send once memory frees, messages booked for a time or another agent's land. Nothing
 * carries it on: a spent allowance's corner says when it is back, for the press the card still owes.
 */
type SelfStart =
    | { readonly kind: `moving`; readonly text: string; readonly account: string }
    | { readonly kind: `resend`; readonly text: string; readonly clock?: LimitClock }
    | { readonly kind: `back`; readonly text: string; readonly clock: LimitClock }
    | { readonly kind: `room`; readonly text: string }
    | { readonly kind: `send`; readonly text: string; readonly count: number; readonly clock?: LimitClock; readonly after?: string };

// The few characters of a title a corner names another agent by; past them the hover has it whole.
const CORNER_TITLE = 24;
const cornerTitle = (title: string): string => (title.length > CORNER_TITLE ? `${title.slice(0, CORNER_TITLE - 1).trimEnd()}…` : title);

// A held turn's re-run: where a move takes it, else when it goes, "in a moment" once that instant has passed (the pass
// lets it go on its next beat).
const rerunCorner = (next: Extract<AgentNext, { kind: `rerun` }>, now: number): SelfStart => {
    if (next.onto !== undefined) {
        return { kind: `moving`, account: next.onto, text: t(`agents.agentCard.movingTo`, { account: next.onto }) };
    }
    const clock = countdownTo(next.at, now);
    if (clock === undefined) {
        return { kind: `resend`, text: t(`agents.agentCard.resendsShortly`) };
    }
    return { kind: `resend`, clock, text: clock.wait ? t(`agents.agentCard.resendsIn`, { limitBackAt: clock.text }) : t(`agents.agentCard.resends`, { limitBackAt: clock.text }) };
};

// Messages booked for later, in the resend's grammar: "sends in 12m", "sends 14:05", "sends after <agent> lands", and
// "sends in a moment" once the instant has passed. The soonest booking speaks; `count` is how many wait, for the hover.
const sendCorner = (next: Extract<AgentNext, { kind: `send` | `land` }>, now: number, titleOf?: (conversationId: string) => string | undefined): SelfStart => {
    if (next.kind === `land`) {
        const title = titleOf?.(next.after);
        const after = title ?? t(`chat.sendLater.anotherAgent`);
        return { kind: `send`, count: next.count, after, text: t(`chat.chatHeld.sendsAfter`, { title: title === undefined ? after : cornerTitle(title) }) };
    }
    const clock = countdownTo(next.at, now, true);
    if (clock === undefined) {
        return { kind: `send`, count: next.count, text: t(`chat.chatHeld.sendsShortly`) };
    }
    return { kind: `send`, count: next.count, clock, text: clock.wait ? t(`chat.chatHeld.sendsIn`, { wait: clock.text }) : t(`agents.agentCard.sends`, { at: clock.text }) };
};

export const selfStart = (agent: AgentStanding, now: number, titleOf?: (conversationId: string) => string | undefined): SelfStart | undefined => {
    const next = agent.next;
    switch (next?.kind) {
        case `rerun`:
            return rerunCorner(next, now);
        case `room`:
            return { kind: `room`, text: t(`agents.agentCard.sendsWhenRoom`) };
        case `send`:
        case `land`:
            return sendCorner(next, now, titleOf);
        default: {
            const clock = limitCountdown(agent, now);
            return clock === undefined ? undefined : { kind: `back`, clock, text: limitBack(clock) };
        }
    }
};

// Whether a card's corner counts to an instant, so its clock must tick: a shut allowance, a re-run or a booked send.
export const selfStartTicks = (agent: AgentStanding, now: number = Date.now()): boolean =>
    limitClosed(agent, now) || agent.next?.kind === `rerun` || agent.next?.kind === `send`;

// The watch a card's clock counts to: the first deadline to arrive is the next moment the card definitely moves. One
// definition, since the chat's own watch row asks the same question about the same conversation.
const soonestWatch = (agent: AgentStanding): AgentWatch | undefined =>
    agent.watches?.reduce(
        (first: AgentWatch | undefined, next) => (first === undefined || next.deadlineAt < first.deadlineAt ? next : first),
        undefined,
    );

// Glyph, phrase and clock, matching the shape a running turn's own readout uses (`Bash · 1m 12s`), so the board
// has one grammar for "what is this doing and for how long". The phrase is the agent's own note, not the word
// "Watching", which tells the user nothing actionable; several watches collapse to a count since truncated notes
// in a narrow lane aren't readable. The clock counts to the deadline, the next moment this card definitely moves.
// The hint is a card: one watch's pacing and deadline as two rows, several as one row each (its note, its pacing), and
// the one line that matters about the end of the wait, that it wakes the conversation. The way out is the Stop press
// beside the readout, which says so itself.
export const watchLine = (
    agent: AgentStanding,
    now: number,
): { readonly text: string; readonly countdown: string; readonly hint: Tip } | undefined => {
    const watches = agent.watches;
    const soonest = soonestWatch(agent);
    if (watches === undefined || soonest === undefined) {
        return undefined;
    }
    // The time left, in the same vocabulary as a running turn's elapsed readout.
    const countdown = formatElapsed((soonest.deadlineAt - now) / 1000);
    const hint: Tip =
        watches.length === 1
            ? {
                  title: t(`agents.childRows.watching`),
                  tone: `info`,
                  rows: [
                      { label: t(`agents.agentStatus.checksEvery`), value: formatElapsed(soonest.intervalSeconds) },
                      { label: t(`agents.agentStatus.givesUpIn`), value: countdown },
                  ],
                  note: t(`agents.agentStatus.wakesThisChat`),
              }
            : {
                  title: t(`agents.childRows.watching`),
                  tone: `info`,
                  rows: watches.map((watch) => ({
                      label: watch.note,
                      value: t(`agents.agentStatus.watchPace`, {
                          interval: formatElapsed(watch.intervalSeconds),
                          left: formatElapsed((watch.deadlineAt - now) / 1000),
                      }),
                  })),
                  note: t(`agents.agentStatus.firstWakesChat`),
              };
    return {
        text: watches.length === 1 ? soonest.note : t(`agents.agentStatus.watchingConditions`, { count: watches.length }, watches.length),
        // "5h 46m" alone beside a running card's elapsed readout read as six hours spent, not six hours to go.
        countdown: t(`agents.agentStatus.timeLeft`, { time: countdown }),
        hint,
    };
};

// The card's readout for a job at a prompt, in the slot a watch's countdown takes: what is waiting, for how long, and
// the job a press of Stop ends. Undefined unless one holds a watch (promptHeldJob).
export const promptLine = (
    agent: AgentStanding,
    now: number,
): { readonly jobId: string; readonly program: string; readonly elapsed: string; readonly hint: Tip } | undefined => {
    const job = promptHeldJob(agent);
    if (job?.inputWait === undefined) {
        return undefined;
    }
    const elapsed = formatElapsed((now - job.inputWait.since) / 1000);
    return {
        jobId: job.id,
        program: job.inputWait.program,
        elapsed,
        hint: {
            title: t(`agents.agentStatus.waitingForInput`),
            tone: `warning`,
            rows: [
                { label: t(`agents.agentStatus.inputWaitProcess`), value: job.inputWait.program },
                { label: t(`agents.agentStatus.inputWaitFor`), value: elapsed },
            ],
            note: t(`agents.agentStatus.inputWaitNote`),
        },
    };
};
