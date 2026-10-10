import type { InvariantCheck } from "../invariants/invariants.js";
import type { ConversationActors } from "./actor/conversation-actors.js";
import { liveTurnConversations } from "./actor/conversation-holdings.js";
import { unkeptHoldReason } from "./actor/limit-hold.js";
import type { AgentsRegistry } from "./registry/agents-registry.js";
import { isIsolated } from "./registry/agents-store.js";
import type { AgentWorktrees } from "./worktrees/worktrees.js";
import { type StrayStanding, strayStandings } from "./worktrees/stray-work.js";

// Two independent records of whether a conversation is running (the run each actor holds, the conversation actors'
// own phase) that must agree, checked both ways: a live run on an idle card, and a running phase with no live run
// behind it. Each side is aged by its own start stamp (the run's, the phase's `startedAt`), so neither fires on a turn
// one tick from registering. An alert, never a heal: settling a phase by hand could free a turn that is in fact alive.

// Long enough that no ordinary begin is still in flight; short enough to catch a stuck card within one sweep.
const REGISTRY_GRACE_MS = 10_000;

export interface FleetRegistryDeps {
    readonly agents: AgentsRegistry;
    readonly conversations: Pick<ConversationActors, "running" | "holdings" | "state">;
    readonly agentWorktrees: AgentWorktrees;
    readonly live?: () => readonly { readonly conversationId: string; readonly startedAt: number }[];
    readonly now?: () => number;
    // Which checkouts stand off `agent/<id>` and whether their work there is carried; git-backed unless handed in.
    readonly strays?: (id: string, repos: readonly { readonly repo: string }[]) => Promise<readonly StrayStanding[]>;
}

export const owner = "agents";

export const checks = ({
    agents,
    conversations,
    agentWorktrees,
    live = () => liveTurnConversations(conversations),
    now = Date.now,
    strays = (id, repos) => strayStandings(agentWorktrees, id, repos),
}: FleetRegistryDeps): readonly InvariantCheck[] => [
    // A conversation may stand its checkout on a branch of its own (a CI branch to push, a pull request it was asked to
    // work on), and each turn's close carries what it committed there onto `agent/<id>`, which review and land read
    // (worktrees/stray-work.ts). What this watches is the carry failing: a commit that would not copy over leaves the
    // work somewhere no land reaches. Asked at turn-settled, after the carry ran; the sweep catches conversations that
    // will never run again. Uncommitted edits there are not a finding: they are a turn's work in progress, and the
    // review says they are there.
    // 2026-09-30: this used to fail on any checkout standing elsewhere, reporting and never repairing; the carry replaced
    // pulling the checkout back, which would have taken the other branch's context from an agent asked to work there.
    {
        name: "stray-work-reaches-its-own-branch",
        on: ["turn-settled", "sweep"],
        run: async ({ fail }) => {
            const stranded: string[] = [];
            for (const id of agents.ids()) {
                const entry = agents.entry(id);
                // Non-isolated conversations run in the owner's own tree and have no branch of their own to stand on.
                if (entry === undefined || !isIsolated(entry)) {
                    continue;
                }
                for (const { repo, branch, carried } of await strays(id, entry.placement.repos)) {
                    if (!carried) {
                        stranded.push(`${id}/${repo} on ${branch ?? "a detached HEAD"}`);
                    }
                }
            }
            if (stranded.length > 0) {
                fail(
                    `${stranded.length} checkout(s) stand off their conversation's own branch with commits the turn's carry could not copy onto agent/<id>, which review and land read: ${stranded.join(", ")}`,
                );
            }
        },
    },
    // A spent allowance's held turn is written onto its entry so a restart keeps the turn and its booking (limit-hold.ts).
    // One the schema refuses lives only as long as the daemon: a restart loses it with no card and no line, as a batch of
    // a person's messages joining more files than a turn may carry once did (2026-10-10). Every turn the daemon builds is
    // meant to parse, so a finding here names the field that does not.
    {
        name: "held-limit-turns-are-kept-for-a-restart",
        on: ["turn-settled", "sweep"],
        run: ({ fail }) => {
            const unkept = agents.ids().flatMap((id) => {
                const reason = unkeptHoldReason(conversations.state(id)?.resume.held);
                return reason === undefined ? [] : [`${id} (${reason})`];
            });
            if (unkept.length > 0) {
                fail(
                    `${unkept.length} turn(s) held on a spent allowance cannot be written for a restart, so a restart before the reset loses the turn and its booking: ${unkept.join(", ")}`,
                );
            }
        },
    },
    {
        name: "live-turns-are-running-on-the-board",
        on: ["sweep", "turn-settled"],
        run: ({ fail }) => {
            const runs = live();
            const due = runs.filter((run) => now() - run.startedAt > REGISTRY_GRACE_MS);
            const known = new Set(agents.ids());
            const unknown = due.filter((run) => !known.has(run.conversationId)).map((run) => run.conversationId);
            if (unknown.length > 0) {
                return fail(`${unknown.length} live turn(s) belong to conversations the fleet registry has no entry for: ${unknown.join(", ")}`);
            }
            const idle = due.filter((run) => !conversations.running(run.conversationId)).map((run) => run.conversationId);
            if (idle.length > 0) {
                return fail(
                    `${idle.length} live turn(s) read as not running on the fleet board, the card shows idle while the turn spends: ${idle.join(", ")}`,
                );
            }
            // The mirror: a phase stuck at running answers every `begin` busy, so the conversation's queue never drains.
            const alive = new Set(runs.map((run) => run.conversationId));
            const stuck = [...known].filter((id) => {
                const phase = conversations.state(id)?.phase;
                return phase?.kind === "running" && now() - phase.startedAt > REGISTRY_GRACE_MS && !alive.has(id);
            });
            if (stuck.length > 0) {
                fail(
                    `${stuck.length} conversation(s) read as running on the fleet board with no live turn behind them, so every new message queues behind nothing: ${stuck.join(", ")}`,
                );
            }
        },
    },
];
