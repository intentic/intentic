import type { AgentSummary } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/extension-ui";

/* WHAT BECAME OF THE AGENT THIS ROW SENT, as the one fact a red row has room for.
 *
 * The board could only ever say "Fix with agent". Press it and the row went straight back to saying it, on
 * every browser, forever: the conversation existed, was working, was parked on a question nobody would see,
 * or had a finished diff waiting to be landed, and the surface that started it had no way to ask. The join is
 * the derived conversation id (conversation-ids.ts); this is what the answer READS as.
 *
 * THE WORDS ARE THE FLEET'S OWN (web's agentStatus.ts: `Needs you`, `Ready to land`, `Landed`, `Waiting`), and
 * that is a constraint rather than a coincidence. The card this chip stands for is one click away and says
 * something about the same agent, so two vocabularies for one state is the product disagreeing with itself in
 * front of the reader. Where this deviates it is to name the SUBJECT ("Fix ready", not "Ready to land"),
 * because on a CI board the agent is not the thing being read: the pipeline is.
 *
 * IT READS BOTH HALVES OF THE STATE, for the reason that file gives at length: an agent parked on a question is
 * `idle` in the registry with an attention flag raised, so a status-only reading calls it finished while the
 * fleet has it sitting in Attention, and the one state the reader most needs to see is the one that would
 * disappear.
 *
 * A LEAF: pure, no host, no clock, type-only imports. It deliberately carries nothing that needs a `now`, the
 * elapsed and the age belong to the surface that already owns a clock (the row's drawer), and a hint rebuilt
 * every second is a tooltip that changes under the pointer. */

export type FixStanceKind =
    // A turn is in flight. Nothing is owed by the reader.
    | `working`
    // Parked on the user: a question, a plan, a permission, a spend, a setup, a conflict.
    | `needs-you`
    // The fix is written and held on the agent's branch, waiting to be reviewed and landed.
    | `ready`
    // It is in the workspace. What is left is proving it: re-run the pipeline.
    | `landed`
    // Stopped on a spent allowance, which is a wait rather than a failure and must not be drawn as one.
    | `waiting`
    // Over, with nothing held: it failed, it was interrupted, it was stopped, or it changed nothing.
    | `ended`;

export interface FixStance {
    readonly kind: FixStanceKind;
    /* Whether this agent is still THIS failure's answer, which is what stops a second one being started on the
     * same breakage (see ciFixes.ts, which carries the reading across a branch's other runs). An ended or
     * landed fix is not: the first has nothing in flight, the second is done, and in both cases another agent
     * is a decision the reader is entitled to make. */
    readonly ongoing: boolean;
    // Whether the row offers to start a turn again instead of drawing a state. Only for an ended fix: the id is
    // derived, so "again" continues that conversation rather than opening a rival one on a rival branch.
    readonly retry: boolean;
    readonly label: string;
    readonly icon: IconName;
    readonly spin: boolean;
    // The state's own ink, and the chip's border and hover on top of it. Two fields rather than one because
    // the drawer's line wears the colour without the box; spelled out in full because Tailwind scans source
    // text, so `text-${tone}` would never reach the stylesheet (statusVisual.ts's note).
    readonly ink: string;
    readonly chip: string;
    // Why the chip says what it says, and what pressing it does. No time words: see the header.
    readonly hint: string;
}

const needsYou = (label: string, hint: string): FixStance => ({
    kind: `needs-you`,
    ongoing: true,
    retry: false,
    label,
    icon: `exclamation-circle`,
    spin: false,
    ink: `text-primary-500`,
    // The attention hue the fleet wears for this state, over the app's ORDINARY hover surface: the tinted
    // fills below are promised per colour ROLE (extension-surface.css), and `primary-500` is a scale step
    // rather than a role, so a tint in it is a class that only works while this extension is built in-repo.
    chip: `border-primary-500/40 hover:bg-overlay`,
    hint,
});

// Parked on a person, in the order the fleet ranks the same flags: money and setup outrank a plain question,
// because those are the ones where waiting costs the agent its call or blocks it outright.
const ATTENTION: readonly { readonly flag: keyof AgentSummary["attention"]; readonly label: string; readonly why: string }[] = [
    { flag: `plan`, label: `Approval needed`, why: `it has proposed a plan and is waiting for a yes` },
    { flag: `service`, label: `Spend approval`, why: `it wants to spend on a paid service` },
    { flag: `capability`, label: `Setup needed`, why: `it needs something connected that is not connected yet` },
    { flag: `question`, label: `Question for you`, why: `it has asked you something` },
    { flag: `permission`, label: `Permission needed`, why: `it wants to use a tool it needs permission for` },
    { flag: `conflict`, label: `Land conflict`, why: `its work cannot be merged until somebody resolves a clash` },
];

// The turn is live: running, walking out of a Stop, or waiting out something the daemon is already repairing.
// `awaiting` is deliberately absent, a parked turn is read as the thing it is parked on, one rule earlier.
const IN_FLIGHT: ReadonlySet<AgentSummary["status"]> = new Set([`running`, `resuming`, `stopping`, `dismissing`]);

const WORKING: FixStance = {
    kind: `working`,
    ongoing: true,
    retry: false,
    label: `Agent working`,
    icon: `spinner`,
    spin: true,
    ink: `text-info`,
    chip: `border-info/30 hover:bg-info/10`,
    hint: `An agent is already working on this failure. Open the conversation to watch it.`,
};

const READY: FixStance = {
    kind: `ready`,
    ongoing: true,
    retry: false,
    label: `Fix ready`,
    icon: `download`,
    spin: false,
    ink: `text-link`,
    chip: `border-link/40 hover:bg-link/10`,
    hint: `The fix is written and held on the agent's branch. Open it to review the diff and land it.`,
};

const LANDED: FixStance = {
    kind: `landed`,
    ongoing: false,
    retry: false,
    label: `Fix landed`,
    icon: `check-circle`,
    spin: false,
    ink: `text-success`,
    chip: `border-success/30 hover:bg-success/10`,
    hint: `The fix is in your workspace. Re-running the pipeline is what proves it.`,
};

const WAITING: FixStance = {
    kind: `waiting`,
    ongoing: true,
    retry: false,
    label: `Waiting`,
    icon: `clock`,
    spin: false,
    ink: `text-subtle`,
    chip: `border-line hover:bg-subtle/10`,
    hint: `The fix agent's allowance is spent. Nothing is owed: the turn goes again when the provider's window reopens.`,
};

/* HELD WORK, whether the fleet called it `ready` (a clean finish with auto-land off) or left it `idle` with a
 * diff still on the branch. Both are the same fact for this row, there is a fix and nobody has landed it, and
 * the difference between them is a setting the reader of a CI board is not thinking about.
 *
 * A CLEAN ENDING ONLY, and that restriction is the whole of the rule. An agent that CRASHED after writing two
 * files also has a diff, and reading that as "Fix ready" is the board promising a fix over a turn that never
 * finished one: the fleet's own lane machine puts such a card in Attention whatever is on its branch, and this
 * has to agree with it. What the half-written diff earns instead is a sentence in the ending's hint. */
const holdingWork = (agent: AgentSummary): boolean =>
    agent.status === `ready` || (agent.status === `idle` && agent.diff !== undefined && agent.diff.files > 0);

/* The endings, and each says what the reader's move is rather than only what happened. `idle` is here too: a
 * turn that finished and changed no files did not fix anything, and a row reading "finished" over a still-red
 * pipeline would be the board agreeing with itself and with nobody else. */
const ENDINGS: Partial<Record<AgentSummary["status"], { readonly label: string; readonly why: string }>> = {
    error: { label: `Agent failed`, why: `The fix agent's turn failed` },
    interrupted: { label: `Interrupted`, why: `The fix agent's turn was cut off when the sandbox went away` },
    stopped: { label: `Stopped`, why: `The fix agent was stopped before it finished` },
    idle: { label: `Nothing changed`, why: `The fix agent finished without changing any files` },
};

const ended = (agent: AgentSummary): FixStance => {
    const ending = ENDINGS[agent.status] ?? { label: `Agent stopped`, why: `The fix agent's turn ended` };
    // What a turn that died mid-edit left behind. Not a fix, so the row does not offer one, but it is not
    // nothing either, and the reader deciding whether to go and look is owed the count.
    const files = agent.diff?.files ?? 0;
    const partial = files === 0 ? `` : ` It left ${files} changed file${files === 1 ? `` : `s`} on its branch.`;
    return {
        kind: `ended`,
        ongoing: false,
        retry: true,
        label: ending.label,
        icon: `exclamation-triangle`,
        spin: false,
        ink: `text-warning`,
        chip: `border-warning/40 hover:bg-warning/10`,
        // The provider's own sentence when there is one: for an unattended run nobody watched, the transcript is
        // the last place anybody looks and the first place the answer is.
        hint: `${ending.why}${agent.failure === undefined ? `` : `: ${agent.failure}`}.${partial} Starting it again carries on in the same conversation.`,
    };
};

/* THE ORDER IS A VALUE YOU CAN READ, which is the whole reason this is a list and not a chain of ifs: every
 * rule here outranks the ones below it for a stated reason, and a new condition (a state the daemon grows) is
 * a line inserted at the rank it belongs to rather than an if threaded past five near-identical ones.
 *
 * THE SPENT ALLOWANCE LEADS, ahead of the `error` it is filed as. Nothing is broken, nobody has anything to
 * fix, and what changes the outcome is a clock, so it must not wear the failure vocabulary or offer a retry
 * that would spend the same refused allowance again. */
const RULES: readonly ((agent: AgentSummary) => FixStance | undefined)[] = [
    (agent) => (agent.status === `error` && agent.failureCode === `rate_limit` ? WAITING : undefined),
    (agent) => {
        const parked = ATTENTION.find((entry) => agent.attention[entry.flag]);
        return parked === undefined ? undefined : needsYou(parked.label, `The fix agent is waiting on you: ${parked.why}.`);
    },
    // A bare `awaiting` (or `conflict`) with no flag raised yet: parked, with nothing more specific to say than
    // that it stopped for you.
    (agent) =>
        agent.status === `awaiting` || agent.status === `conflict`
            ? needsYou(`Needs you`, `The fix agent has stopped and is waiting on you.`)
            : undefined,
    (agent) => (IN_FLIGHT.has(agent.status) ? WORKING : undefined),
    (agent) => (holdingWork(agent) ? READY : undefined),
    (agent) => (agent.status === `landed` ? LANDED : undefined),
];

export const fixStance = (agent: AgentSummary): FixStance => {
    for (const rule of RULES) {
        const stance = rule(agent);
        if (stance !== undefined) {
            return stance;
        }
    }
    return ended(agent);
};
