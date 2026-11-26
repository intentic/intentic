import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { withGitCallerPart } from "@intentic/base/git";
import { createOutboundSniffer, sniffedCommands } from "../../../activity/outbound.js";
import type { Services } from "../../../composition.js";
import { liveRunOf } from "../../../conversations/actor/conversation-holdings.js";
import { opt } from "../../../opt.js";
import type { RoutedTurn } from "../../../seams/turn-starter.js";
import { isSpawnedChild } from "../../subagents/children.js";
import { composeReach, type ReachFrames } from "../../verification/agent-reach.js";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import type { ConversationWorktree } from "../../../conversations/worktrees/worktrees.js";
import { remoteFailuresHere } from "../../../runners/held-turns/remote-failure.js";
import { dispatchToRunner } from "../placement/runner-child-note.js";
import { recordFrame, settleAnswered, type TurnActivity, turnActivity } from "../frames/frame-effects.js";
import { createTurnFrames } from "../frames/frame-reducers.js";
import { performSettlement } from "./settle-turn.js";
import { type MirrorEdits, mirrorEdits } from "./mirror-edits.js";
import { SETTLE_MAX_AGE_MS, type SettlementPlan, settleProvenTurn } from "./turn-settlement.js";

/* A RUNNER'S TURN IS SETTLED HERE TOO, from the frames it relayed. The runner runs the turn through its own local loop
   and settles it into its own stores, which stay as they are (a runner may be a sandbox someone uses directly). The
   parent, the only sandbox the editor reads, used to keep none of it: no ledger row on the Usage page, no activity rows,
   no command record, no proof on the card, no allowance re-read for the account it lent, and no word of where the work
   went. Now the relayed stream goes through the same folds and recorders a local turn's does (frame-effects.ts,
   turn-settlement.ts, settle-turn.ts), into this sandbox's stores, under the account the runner stamped on its frames,
   which is the one this sandbox lent it (runner-credentials.routes.ts), so it lands on the same books a local turn on
   that account would.

   A code file a command wrote is read off the mirror once the runner delivered its branch (mirror-edits.ts). What only
   the runner could read is left out rather than guessed: the installs and clones it left on the runner's disk, and live writes there, which are the runner's own shared state, not this
   sandbox's. A failure's refusal records stay the runner's too. A dispatch the runner never ran (offline, its sync
   failed) settles nothing, as a turn refused before it starts settles nothing here. */

// The account a frame was stamped with, on the kinds the runner stamps (frame-decorators.ts ATTRIBUTED).
const accountOf = (event: AgentEvent): string | undefined =>
    event.kind === "session" || event.kind === "usage" || event.kind === "rate_limit_info" || event.kind === "account_usage" ? event.account : undefined;

// Whether the runner ran a turn at all, told only by frames its runtime produces. The relay speaks too, in frames of its
// own (runner-relay.ts: the link's `agent_status`, its `agent_notice`s, a failure and an end), and a turn the link lost
// before it reached the runner relays only those, so none of them counts: settling them filed an errored turn against
// the provider, and the resend settled a second one.
const RUNTIME_FRAMES: ReadonlySet<AgentEvent["kind"]> = new Set<AgentEvent["kind"]>([
    "init",
    "session",
    "delta",
    "thinking",
    "text_end",
    "tool_call",
    "tool_call_update",
    "usage",
    "todos",
    "context_usage",
    "compact",
    "rate_limit_info",
    "account_usage",
    "provider_retry",
    "subagent",
]);
const ranThere = (event: AgentEvent): boolean => RUNTIME_FRAMES.has(event.kind);

// The local plan, recut for a turn whose request and holds are not this sandbox's. A failure's hold is decided where
// its frame arrives (runners/held-turns/remote-failure.ts), so the plan holds nothing and resets the stop ladder only
// for a turn that did not fail. The allowance is re-read through the headroom sweep for the account the runner was
// lent, since the token it spent was minted here and never travels back.
const runnerPlanOf = (plan: SettlementPlan, turn: { readonly provider: string; readonly account: string | undefined; readonly failed: boolean; readonly aborted: boolean }): SettlementPlan => {
    const routed = KeyedProviderSchema.safeParse(turn.provider).success;
    const headroomRefresh =
        routed || turn.account === undefined || turn.aborted
            ? plan.headroomRefresh
            : { scope: { providers: [plan.usage.provider], account: turn.account }, maxAgeMs: SETTLE_MAX_AGE_MS };
    return { ...plan, hold: turn.failed ? undefined : plan.hold, headroomRefresh };
};

// Where the runner's work went, as far as its frames say: what it pushed. Its live writes and stranded clones are on
// the runner's disk, not this sandbox's.
const noteRunnerReach = (deps: Pick<Services, "conversations">, conversationId: string, framed: ReachFrames): void => {
    const reach = composeReach({ framed: { live: [], published: framed.published }, installs: [], covered: new Set(), stranded: [] }, Date.now());
    deps.conversations.send(conversationId, { kind: "reach-noted", reach });
};

/** The runner's relayed frames, passed on unchanged, each folded and recorded as a local turn's are, and the turn settled
 *  here once they end. `root` is the tree as the runner's agent saw it, which its tool calls name paths under. */
async function* settledOnParent(
    services: Services,
    input: RoutedTurn & { readonly conversationId: string },
    root: string,
    mirror: MirrorEdits,
    frames: AsyncIterable<AgentEvent>,
    signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent> {
    const { conversationId } = input;
    const provider = input.agent;
    const turnId = randomUUID();
    const run = liveRunOf(services.conversations, conversationId);
    const folded = createTurnFrames(root, input.sessionId, Date.now(), mirror.scan);
    const sniffer = createOutboundSniffer(services, turnId, await sniffedCommands(services));
    let account = input.account;
    let model = input.model === "" ? undefined : input.model;
    let ran = false;
    const attribution = () => ({ ...opt("account", account), ...opt("actor", input.actor) });
    // Stamped per row: the account is known only once the runner's first attributed frame says it.
    const record = (row: TurnActivity): void =>
        turnActivity(services, { input, provider, turnId, attribution: attribution(), sessionId: () => folded.readings().sessionId })(row);
    const aborted = (): boolean => signal?.aborted === true;
    const startedAt = Date.now();
    // Folded and recorded before it goes on, as a local turn's frame is; nothing is recorded until the runner ran a turn.
    const noteFrame = (event: AgentEvent): void => {
        mirror.note(event);
        const answeredAt = folded.note(event);
        account = accountOf(event) ?? account;
        model = event.kind === "init" ? event.model : model;
        if (!ran && !ranThere(event)) {
            return;
        }
        if (!ran) {
            ran = true;
            record({ type: "turn.started", content: input.prompt.slice(0, 2_000) });
        }
        sniffer.observe(event);
        settleAnswered(services, provider, account, model, answeredAt);
        recordFrame(services, event, { provider, account, record });
    };
    try {
        await mirror.open();
        for await (const event of frames) {
            // A stopped turn's failure is no failure, as at a local turn's door (frame-decorators.ts abortSuppresses).
            if (!(event.kind === "error" && aborted())) {
                noteFrame(event);
            }
            yield event;
        }
    } finally {
        if (ran) {
            // The branch was delivered before the stream ended: what its commands wrote is read off the mirror now.
            await mirror.close();
            const plan = await settleProvenTurn({
                input,
                turnId,
                run: run?.id,
                provider,
                account,
                attribution: attribution(),
                request: { spec: opt("model", model) },
                aborted: aborted(),
                isolated: true,
                spawnedChild: isSpawnedChild(services.conversations, conversationId),
                isolation: undefined,
                experiments: {},
                frames: folded,
                startedAt,
            });
            const settlement = runnerPlanOf(plan, { provider, account, failed: folded.readings().failure !== undefined, aborted: aborted() });
            withGitCallerPart("turn.settle", () =>
                performSettlement(services, settlement, {
                    record,
                    flush: sniffer.flush,
                    reach: (framed) => noteRunnerReach(services, conversationId, framed),
                }),
            );
        }
    }
}

/** A runner turn as this sandbox runs it: dispatched (runner-child-note.ts), every failure decided here
 *  (remote-failure.ts), and settled here from what it relayed. The runner's agent sees the namespace's root where its
 *  runtime enters one, else its own checkout, which sits where this sandbox's mirror does; the mirror's repos are where
 *  the delivered branch is read. */
export const dispatchSettled = (
    services: Services,
    input: RoutedTurn & { readonly conversationId: string },
    runner: string,
    worktree: ConversationWorktree,
    signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent> => {
    const root = capabilitiesOf(input.agent, input.harness).isolation === "namespace" ? services.workspace.root : worktree.cwd;
    const repos = worktree.repos.map(({ repo }) => ({ dir: repo === "root" ? "" : repo, checkout: services.agentWorktrees.worktreeDir(input.conversationId, repo) }));
    return settledOnParent(services, input, root, mirrorEdits(repos, root), remoteFailuresHere(services, input, runner, dispatchToRunner(services, input, runner, worktree, signal)), signal);
};
