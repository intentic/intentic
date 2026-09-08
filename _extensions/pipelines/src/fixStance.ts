import type { AgentSummary } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/extension-ui";

// Derives what became of the agent a CI row sent, joined by conversation id, reading both status and attention since a
// parked turn is `idle` with a flag rather than finished. Mirrors the fleet's own labels except naming the subject
// (`Fix ready`), since here the pipeline is what's read. Pure leaf: no host, no clock.

export type FixStanceKind =
    // A turn is in flight. Nothing is owed by the reader.
    | `working`
    // Parked on the user: a question, a plan, a permission, a setup, a conflict.
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
    // True while this agent is still the failure's live answer; false once ended or landed.
    readonly ongoing: boolean;
    // True only for an ended fix; retrying continues that fix's same derived conversation.
    readonly retry: boolean;
    readonly label: string;
    readonly icon: IconName;
    readonly spin: boolean;
    // Two fields: drawer needs ink without the box; spelled out in full since Tailwind can't read `text-${tone}`.
    readonly ink: string;
    readonly chip: string;
    // Why the chip says what it says, and what pressing it does; no time-relative words.
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
    // `primary-500` is a scale step, not a role, so this tint only works while built in-repo.
    chip: `border-primary-500/40 hover:bg-overlay`,
    hint,
});

// Ranks parked flags like the fleet does: setup outranks a plain question since it blocks the agent outright.
const ATTENTION: readonly { readonly flag: keyof AgentSummary["attention"]; readonly label: string; readonly why: string }[] = [
    { flag: `plan`, label: `Approval needed`, why: `it has proposed a plan and is waiting for a yes` },
    { flag: `capability`, label: `Setup needed`, why: `it needs something connected that is not connected yet` },
    { flag: `question`, label: `Question for you`, why: `it has asked you something` },
    { flag: `permission`, label: `Permission needed`, why: `it wants to use a tool it needs permission for` },
    { flag: `conflict`, label: `Land conflict`, why: `its work cannot be merged until somebody resolves a clash` },
];

// Live turn: running, unwinding a Stop, or waiting on a daemon repair; `awaiting` is handled above.
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

// True only for a clean finish (`ready`, or `idle` with a diff); a crashed turn with files also has a diff, but that
// belongs in the ending's hint, not here.
const holdingWork = (agent: AgentSummary): boolean =>
    agent.status === `ready` || (agent.status === `idle` && agent.diff !== undefined && agent.diff.files > 0);

// Each ending's label states the reader's next move, not just what happened; `idle` counts too, since finishing with no
// changed files fixed nothing.
const ENDINGS: Partial<Record<AgentSummary["status"], { readonly label: string; readonly why: string }>> = {
    error: { label: `Agent failed`, why: `The fix agent's turn failed` },
    interrupted: { label: `Interrupted`, why: `The fix agent's turn was cut off when the sandbox went away` },
    stopped: { label: `Stopped`, why: `The fix agent was stopped before it finished` },
    idle: { label: `Nothing changed`, why: `The fix agent finished without changing any files` },
};

const ended = (agent: AgentSummary): FixStance => {
    const ending = ENDINGS[agent.status] ?? { label: `Agent stopped`, why: `The fix agent's turn ended` };
    // File count left behind by a turn that died mid-edit; not a fix, but worth surfacing.
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
        // Includes the provider's own failure sentence when present; often the only record of an unwatched run.
        hint: `${ending.why}${agent.failure === undefined ? `` : `: ${agent.failure}`}.${partial} Starting it again carries on in the same conversation.`,
    };
};

// List order is priority, so a new status is inserted at its rank rather than appended as a trailing if. A spent
// allowance is checked first, ahead of `error`, since it is not a failure and must not offer a retry that spends the
// same allowance again.
const RULES: readonly ((agent: AgentSummary) => FixStance | undefined)[] = [
    (agent) => (agent.status === `error` && agent.failureCode === `rate_limit` ? WAITING : undefined),
    (agent) => {
        const parked = ATTENTION.find((entry) => agent.attention[entry.flag]);
        return parked === undefined ? undefined : needsYou(parked.label, `The fix agent is waiting on you: ${parked.why}.`);
    },
    // Bare `awaiting`/`conflict` with no flag raised: parked, with nothing more specific to say.
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
