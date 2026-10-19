import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentHarness, AgentProvider, TurnProfile } from "@intentic/sandbox-contract/schemas/agent";
import type { ChildRun } from "@intentic/sandbox-contract/events/requests";
import type { LimitPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import { canonicalHarness, loopLabel, loopOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { TurnInput } from "../../seams/turn-starter.js";
import { opt } from "../../opt.js";
import type { ChildParent, ChildRecord, ChildRehome, ChildSpawnSpec, ChildTurnTally, PendingChildCard } from "./children.js";

// What a spawned child runs as, read off its spec alone: its routing and profile, a move's spec, and which of its
// endings move it on or count against its provider. children.ts holds the records these are asked of.

// Whether the served model is the one asked for, as a parent means it: the asked name may be an alias the served id
// spells out ("opus" served as "claude-opus-5-5") or carry no window suffix ("[1m]"), but a served id shorter than the
// asked one is another model ("kimi-k3" for "kimi-k3-256k").
export const sameModel = (served: string, asked: string): boolean => {
    const plain = (id: string): string => id.toLowerCase().replace(/\[.*\]$/u, "");
    return plain(served).includes(plain(asked));
};

// Refusals no wait soon answers: the account itself refused, a model off the plan, a spent allowance with no re-run booked
// (none named, or one past the child's horizon, children.ts childRerunHorizonMs).
const REFUSED_OUTRIGHT: ReadonlySet<string> = new Set(["account-not-entitled", "claude-not-entitled", "model-unavailable", "trial-exhausted"]);

// Whether this failure moves the child onto its spawn's next fallback rather than ending it.
export const movesOn = (kid: ChildRecord, event: Extract<AgentEvent, { kind: "error" }>): boolean =>
    (kid.spec.fallbacks?.length ?? 0) > 0 &&
    !kid.cancelled &&
    event.code !== undefined &&
    (REFUSED_OUTRIGHT.has(event.code) || (event.code === "rate_limit" && event.autoResume !== "scheduled"));

// Failures that are this sandbox's, not the provider's: they say nothing about the provider's lane.
const SANDBOX_SIDE: ReadonlySet<string> = new Set([
    "sandbox-memory-low",
    "workspace-setup",
    "sandbox-disk-low",
    "privacy-unshielded",
    "privacy-instructions",
    "tools-unenforced",
    "agent-domain-refused",
]);

// What a child's failure tells its siblings about its provider: a refusal its provider's own frame said, never a start
// this sandbox could not make (memory, its own view of the workspace).
export const providerRefusal = (tally: ChildTurnTally): string | undefined =>
    tally.errored && (tally.code === undefined || !SANDBOX_SIDE.has(tally.code)) ? tally.failure : undefined;

// A function that runs once, however often it is called: a seat freed by a move must not be freed again by the settle.
export const onceOnly = (run: () => void): (() => void) => {
    let ran = false;
    return () => {
        if (!ran) {
            ran = true;
            run();
        }
    };
};

// `provider` and `model` are required, with no fallback default. `harness` still defaults to "native" (the provider's
// own loop), which spends no extra allowance and needs no account; a loop the provider doesn't offer reads as that too,
// so the child is placed and floored for the loop that will actually run it.
/** Where a child's turns run: its provider, the loop that runs it, and its model. */
export interface ChildRoute {
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    readonly model: string;
}

export const childRouting = (spec: ChildSpawnSpec): ChildRoute => ({
    provider: spec.provider,
    harness: canonicalHarness(spec.provider, spec.harness),
    model: spec.model,
});

// Every child turn's profile: its own worktree, so parallel children and the parent never edit the same files, and
// nobody at a composer, which also floors the persona so it speaks for no outside account. No `runRole`: the parent's
// own provider and model pick decides, not a settings-row default.
const childProfile = (spec: ChildSpawnSpec): TurnProfile => {
    const { provider, harness, model } = childRouting(spec);
    const profile: TurnProfile = { agent: provider, harness, model, isolated: true, unattended: true };
    // Each knob only where one was named: an absent one is the model's own default.
    if (spec.effort !== undefined) {
        profile.effort = spec.effort;
    }
    if (spec.thinking !== undefined) {
        profile.thinking = spec.thinking;
    }
    if (spec.fast !== undefined) {
        profile.fast = spec.fast;
    }
    if (spec.account !== undefined) {
        profile.account = spec.account;
    }
    return profile;
};

// A spec while it is being put together, before it is handed on as the readonly one.
type SpecDraft = { -readonly [K in keyof ChildSpawnSpec]: ChildSpawnSpec[K] };

// The spec the owner allowed, when they re-pointed the child on the card: their run replaces the agent's whole, so an
// effort or an account the agent named for its own model never rides along onto another.
export const withRun = (spec: ChildSpawnSpec, run: ChildRun): ChildSpawnSpec => {
    const { harness: _harness, account: _account, effort: _effort, thinking: _thinking, fast: _fast, ...task } = spec;
    const next: SpecDraft = { ...task, provider: run.provider, model: run.model };
    if (run.harness !== undefined) {
        next.harness = run.harness;
    }
    if (run.account !== undefined) {
        next.account = run.account;
    }
    if (run.effort !== undefined) {
        next.effort = run.effort;
    }
    if (run.thinking !== undefined) {
        next.thinking = run.thinking;
    }
    if (run.fast !== undefined) {
        next.fast = run.fast;
    }
    return next;
};

// A run in words for the parent's tool result: provider and model as the ids the agent spawns with, since that is its
// vocabulary, and each knob only when one was named.
const runWords = (run: ChildRun): string =>
    [
        `${run.provider}/${run.model}`,
        run.effort !== undefined ? `${run.effort} effort` : undefined,
        run.thinking === false ? "no extended thinking" : undefined,
        run.fast === true ? "fast speed" : undefined,
        run.harness !== undefined && canonicalHarness(run.provider, run.harness) !== "native"
            ? `the ${loopLabel(run.provider, loopOf(run.provider, run.harness))} loop`
            : undefined,
        run.account !== undefined ? `account ${run.account}` : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(", ");

/** What the parent is told when the owner started its child on something else, so its own report names the right model. */
export const repointedNote = (asked: ChildRun, run: ChildRun): string =>
    `The owner changed what it runs on before allowing it: it runs on ${runWords(run)}, not on ${runWords(asked)} as you asked.`;

// A child's task in one line, as its roster row and the gate's card both show it.
export const taskLine = (spec: Pick<ChildSpawnSpec, "prompt" | "description">): string =>
    (spec.description ?? spec.prompt).replaceAll(/\s+/gu, " ").trim().slice(0, 200);

// What the turn that opens a child's conversation says of it beyond its task, which the registry reads off that turn
// alone. Its title is the parent's own words when the parent described it, a name the naming pass keeps, else the
// prompt's head for that pass to name. And nobody watches a child while its parent waits on it, so where the sandbox's
// standing answer to a spent allowance is to wait for a person's press, the child answers that ending itself: its turn
// goes again once the allowance reopens. A sandbox already answering `resend` or `move` is inherited as it stands. A turn
// that stopped short (a vendor loop's hard cap reached mid-work, a crashed harness) is carried on the same way, on the
// stop ladder's bounded tries: two Gemini children that had edited a dozen files each ended as plain failures at the
// 30-minute cap, and their work was rescued by hand (2026-10-17).
export const childOpening = (spec: ChildSpawnSpec, sandboxLimit: LimitPolicy): Pick<TurnInput, "title" | "titleSource" | "postures"> => ({
    title: taskLine(spec).slice(0, 80),
    ...opt("titleSource", spec.description === undefined ? undefined : ("model" as const)),
    postures: { ...opt("limit", sandboxLimit === "wait" ? ("resend" as const) : undefined), stopped: "retry" },
});

// A child's spec on another provider and model: its task, description and placement kept, every knob of the old model
// dropped, since an effort or an account named for one model means nothing on another.
export const rehomedSpec = (spec: ChildSpawnSpec, to: ChildRehome, fallbacks?: readonly ChildRehome[]): ChildSpawnSpec => {
    const { harness: _harness, account: _account, effort: _effort, thinking: _thinking, fast: _fast, fallbacks: _fallbacks, ...task } = spec;
    const next: SpecDraft = { ...task, provider: to.provider, model: to.model };
    if (to.harness !== undefined) {
        next.harness = to.harness;
    }
    if (to.effort !== undefined) {
        next.effort = to.effort;
    }
    if (fallbacks !== undefined && fallbacks.length > 0) {
        next.fallbacks = fallbacks;
    }
    return next;
};

/** Points a settled or paused child at another provider for its next turn. Its session stays with the provider that
 *  minted it, so the next turn opens a fresh one seeded from the child's own record (routing.ts sessionFor) on top of the
 *  same worktree. Answers how to put it back, for a move whose turn could not be started. */
export const rehomeChild = (kid: ChildRecord, spec: ChildSpawnSpec): (() => void) => {
    const before = { spec: kid.spec, profile: kid.profile, sessionId: kid.sessionId };
    const { provider, harness, model } = childRouting(spec);
    kid.spec = { ...spec, provider, harness, model };
    kid.profile = childProfile(spec);
    kid.sessionId = undefined;
    return () => {
        kid.spec = before.spec;
        kid.profile = before.profile;
        kid.sessionId = before.sessionId;
    };
};

// What the child is parked on. `wait` gets only the summary; pendingQuestionOf exposes the full card so a parent can
// answer, not just report.
export const pendingOf = (event: AgentEvent): { readonly card: PendingChildCard; readonly summary: string } | undefined => {
    if (event.kind === "question") {
        return {
            card: { kind: "question", requestId: event.requestId, questions: event.questions },
            summary: event.questions[0]?.question ?? "Waiting on a question.",
        };
    }
    if (event.kind === "permission") {
        return {
            card: { kind: "permission", requestId: event.requestId },
            summary: event.title ?? `Waiting on permission for ${event.toolName}.`,
        };
    }
    if (event.kind === "plan") {
        return { card: { kind: "plan", requestId: event.requestId }, summary: "Waiting for its plan to be approved." };
    }
    return undefined;
};

// A child's record, as it is filed before its first turn: resolved routing rather than the raw spec, so a follow-up
// reaches the same provider and model without drift.
export const childRecordOf = (parent: ChildParent, spec: ChildSpawnSpec, depth: number, held?: ChildRecord["held"]): ChildRecord => {
    const { provider, harness, model } = childRouting(spec);
    return {
        parent: parent.conversationId,
        spec: { ...spec, provider, harness, model },
        profile: childProfile(spec),
        depth,
        cwd: parent.cwd,
        sessionId: undefined,
        running: true,
        startedAt: Date.now(),
        pending: undefined,
        queued: false,
        behind: false,
        held,
        turns: 0,
        oomKillsAtStart: undefined,
        report: undefined,
        result: undefined,
        submitted: undefined,
        cancelled: false,
        movingOn: undefined,
        paused: undefined,
    };
};
