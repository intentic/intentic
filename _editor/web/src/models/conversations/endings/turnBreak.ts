import { TURN_BREAK_POLICIES, type TurnBreak, type TurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import { t } from "@intentic/ui/i18n";
import type { IconName } from "@intentic/ui";

// One question per ending, asked in one vocabulary. Every surface that shows what happens next when a turn stops —
// the chat's control, the board card's menu, the settings rows — reads its words and its current answer from here, so
// three copies of the same switch can no longer drift into three different sentences.
//
// The words are built by functions, never a table evaluated at import: `t` reads the active language from a ref, and a
// table born at module load holds the language it was born with (docs/architecture/languages.md).

// Which field holds an ending's answer, on the agent and in the settings alike; the daemon's card keeps the same table
// (agent-summary.ts postures, from the stored postures keyed by the ending), and the two must not drift. The optimistic
// echo of a press writes the same field (useAgents-actions.ts policyPatch), so a memory kill's answer moves the chat's
// control at once rather than after the next roster.
const FIELD = { limit: `limitPolicy`, outage: `outagePolicy`, stopped: `stopPolicy`, memory: `memoryPolicy`, memoryKill: `memoryKillPolicy` } as const;

// Each ending's answer where nobody has given one, as the sandbox's settings default it (SandboxSettingsSchema), for a
// window whose settings have not arrived yet. Memory alone goes by itself: nothing ran, so sending it once there is room
// spends nothing twice; and a turn memory killed comes back once there is room, one at a time, never the one that used
// the memory up (SandboxSettingsSchema memoryKillPolicy says why that one is on where a restart's is off).
const DEFAULT_POLICY: Readonly<Record<TurnBreak, TurnBreakPolicy>> = { limit: `wait`, outage: `wait`, stopped: `wait`, memory: `resend`, memoryKill: `resume` };

// Structural, not `Pick<AgentSummary>`: `AgentSummary` and `SandboxSettings` both satisfy it, and naming the fields
// rather than either owner is what lets one fold answer for both scopes.
type PolicyHolder = Partial<Record<(typeof FIELD)[TurnBreak], TurnBreakPolicy>>;

/** An ending's current answer: the conversation's own override where it has one, else the sandbox-wide policy. */
export const effectivePolicy = (ending: TurnBreak, agent: PolicyHolder | undefined, settings: PolicyHolder | undefined): TurnBreakPolicy =>
    agent?.[FIELD[ending]] ?? settings?.[FIELD[ending]] ?? DEFAULT_POLICY[ending];

/** The sandbox-wide answer alone, for deciding whether a per-conversation write is an override or a clear-to-inherit. */
export const sandboxPolicy = (ending: TurnBreak, settings: PolicyHolder | undefined): TurnBreakPolicy =>
    effectivePolicy(ending, undefined, settings);

export interface BreakAnswer {
    readonly value: TurnBreakPolicy;
    readonly label: string;
    /** What choosing it means, in one sentence: where it is read as text, a menu line or a row's description. */
    readonly note: string;
    /** The one consequence that tells it from the others, in a few words: the note of the control's hover card. */
    readonly brief: string;
    readonly icon: IconName;
}

// `move` names the account it would use, so the choice is a decision about a real credential rather than a category.
// Absent that account it is not offered at all: an answer nothing can act on is worse than one fewer.
// The memory wall holds a message nobody has sent yet rather than a turn, and what it waits for is room, not a reset:
// the same two answers, said about what they are about.
const memoryAnswerOf = (policy: TurnBreakPolicy): BreakAnswer =>
    policy === `wait`
        ? { value: policy, label: t(`chat.turnBreak.wait`), note: t(`chat.turnBreak.waitMemoryNote`), brief: t(`chat.turnBreak.waitBrief`), icon: `pause` }
        : {
              value: policy,
              label: t(`chat.turnBreak.resendMemory`),
              note: t(`chat.turnBreak.resendMemoryNote`),
              brief: t(`chat.turnBreak.resendMemoryBrief`),
              icon: `clock`,
          };

// A turn memory killed ran, so it is held as a turn and carried on with Continue; what it waits for is room, as above.
const memoryKillAnswerOf = (policy: TurnBreakPolicy): BreakAnswer =>
    policy === `wait`
        ? { value: policy, label: t(`chat.turnBreak.wait`), note: t(`chat.turnBreak.waitMemoryKillNote`), brief: t(`chat.turnBreak.waitBrief`), icon: `pause` }
        : {
              value: policy,
              label: t(`chat.turnBreak.resumeMemoryKill`),
              note: t(`chat.turnBreak.resumeMemoryKillNote`),
              brief: t(`chat.turnBreak.resumeMemoryKillBrief`),
              icon: `clock`,
          };

const answerOf = (ending: TurnBreak, policy: TurnBreakPolicy, account: string | undefined): BreakAnswer => {
    if (ending === `memory`) {
        return memoryAnswerOf(policy);
    }
    if (ending === `memoryKill`) {
        return memoryKillAnswerOf(policy);
    }
    switch (policy) {
        case `wait`:
            return { value: policy, label: t(`chat.turnBreak.wait`), note: t(`chat.turnBreak.waitNote`), brief: t(`chat.turnBreak.waitBrief`), icon: `pause` };
        case `resend`:
            return { value: policy, label: t(`chat.turnBreak.resend`), note: t(`chat.turnBreak.resendNote`), brief: t(`chat.turnBreak.resendBrief`), icon: `clock` };
        case `move`:
            return {
                value: policy,
                label: t(`chat.turnBreak.move`, { account: account ?? t(`chat.turnBreak.anotherAccount`) }),
                note: t(`chat.turnBreak.moveNote`),
                brief: t(`chat.turnBreak.moveBrief`),
                icon: `user`,
            };
        default:
            return {
                value: policy,
                label: t(`chat.turnBreak.retry`),
                note: ending === `outage` ? t(`chat.turnBreak.retryOutageNote`) : t(`chat.turnBreak.retryStoppedNote`),
                brief: ending === `outage` ? t(`chat.turnBreak.retryOutageBrief`) : t(`chat.turnBreak.retryStoppedBrief`),
                icon: `repeat`,
            };
    }
};

/**
 * The answers this ending may take, in the order they are offered. `account` is the sibling with room; without one the
 * move is dropped, since there would be nowhere to move to.
 */
export const breakAnswers = (ending: TurnBreak, account?: string): readonly BreakAnswer[] =>
    TURN_BREAK_POLICIES[ending]
        .filter((policy) => policy !== `move` || account !== undefined)
        .map((policy) => answerOf(ending, policy, account));

/** How each ending is named where the question is asked about it in the abstract (the settings rows, the card's menu). */
export const breakLabel = (ending: TurnBreak): string => {
    switch (ending) {
        case `limit`:
            return t(`chat.turnBreak.limitEnding`);
        case `outage`:
            return t(`chat.turnBreak.outageEnding`);
        case `memory`:
            return t(`chat.turnBreak.memoryEnding`);
        case `memoryKill`:
            return t(`chat.turnBreak.memoryKillEnding`);
        default:
            return t(`chat.turnBreak.stoppedEnding`);
    }
};

/**
 * What the memory wall's answer will do, in one line under the control, or nothing while it is `wait`: the selected
 * chip already says that (pickUpNext's rule for the other walls). No instant to promise: room comes back when the
 * running work lets it go.
 */
export const memoryNext = (policy: TurnBreakPolicy): string | undefined => (policy === `wait` ? undefined : t(`chat.turnBreak.goesWhenRoom`));
