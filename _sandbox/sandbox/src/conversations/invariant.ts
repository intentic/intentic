import type { InvariantCheck } from "../invariants/invariants.js";
import type { ConversationActors } from "./actor/conversation-actors.js";
import { liveTurnConversations } from "./actor/conversation-holdings.js";
import { unkeptHoldReason } from "./actor/limit-hold.js";
import type { AgentsRegistry } from "./registry/agents-registry.js";
import { isIsolated } from "./registry/agents-store.js";
import type { AgentWorktrees } from "./worktrees/worktrees.js";
import { type StrayStanding, strayStandings } from "./worktrees/stray-work.js";
import { discoverRepos, ROOT_REPO } from "../workspace/layout/repo-discovery.js";
import { mapPool } from "@intentic/base/async";

// Two independent records of whether a conversation is running (the run each actor holds, the conversation actors'
// own phase) that must agree, checked both ways: a live run on an idle card, and a running phase with no live run
// behind it. Each side is aged by its own start stamp (the run's, the phase's `startedAt`), so neither fires on a turn
// one tick from registering. An alert, never a heal: settling a phase by hand could free a turn that is in fact alive.

// Long enough that no ordinary begin is still in flight; short enough to catch a stuck card within one sweep.
const REGISTRY_GRACE_MS = 10_000;
// Conversations whose checkouts the stray-work check reads at once.
const STRAY_READS_AT_ONCE = 8;

export interface FleetRegistryDeps {
    readonly agents: AgentsRegistry;
    readonly conversations: Pick<ConversationActors, "running" | "holdings" | "state">;
    readonly agentWorktrees: AgentWorktrees;
    readonly live?: () => readonly { readonly conversationId: string; readonly startedAt: number }[];
    // On a runner, the turns it runs for its parent (runners/remote-turns.ts): a dispatched turn is no conversation run
    // here, yet it is what keeps the card running, so it counts as the live turn behind it.
    readonly remoteTurns?: { readonly live: () => readonly { readonly conversationId: string }[] };
    readonly now?: () => number;
    // Which checkouts stand off `agent/<id>` and whether their work there is carried; git-backed unless handed in.
    readonly strays?: (id: string, repos: readonly { readonly repo: string }[]) => Promise<readonly StrayStanding[]>;
}

export const owner = "agents";

// Each shared checkout stands in its own repository. In the privacy jail git can record a shared checkout as a
// conversation's worktree, and any later `worktree repair` re-points the shared one into that record (targowisko,
// 2026-11-11). Healed here under each repo's lock (worktrees.ts healShared, worktree-links.ts) and said, since a
// sandbox nobody lands in or presses Back to main in would otherwise stand on a conversation's branch unseen.
const sharedCheckoutsCheck = (agentWorktrees: Pick<AgentWorktrees, "mainDir" | "healShared">): InvariantCheck => ({
    name: "shared-checkouts-stand-in-their-own-repository",
    on: ["sweep"],
    run: async ({ fail }) => {
        const repos = [ROOT_REPO, ...(await discoverRepos(agentWorktrees.mainDir(ROOT_REPO)))];
        const healed = await agentWorktrees.healShared(repos);
        if (healed.length > 0) {
            fail(
                `${healed.length} git link(s) had put a shared checkout into a conversation's worktree record, and were pointed back: ${healed.map(({ repo, kind }) => `${repo} (${kind})`).join(", ")}`,
            );
        }
    },
});

// A conversation may stand its checkout on a branch of its own (a CI branch to push, a pull request it was asked to
// work on), and each turn's close carries what it committed there onto `agent/<id>`, which review and land read
// (worktrees/stray-work.ts). What this watches is the carry failing: a commit that would not copy over leaves the
// work somewhere no land reaches. Asked at turn-settled, after the carry ran; the sweep catches conversations that
// will never run again. Uncommitted edits there are not a finding: they are a turn's work in progress, and the
// review says they are there.
// 2026-09-30: this used to fail on any checkout standing elsewhere, reporting and never repairing; the carry replaced
// pulling the checkout back, which would have taken the other branch's context from an agent asked to work there.
const strayWorkCheck = (
    agents: AgentsRegistry,
    live: () => readonly { readonly conversationId: string }[],
    strays: NonNullable<FleetRegistryDeps["strays"]>,
): InvariantCheck => {
    // Each conversation's last reading, by the card it was read at: 2026-11-24, every turn's end read every
    // conversation's every checkout, the archive's thousands included, 0.3-0.4% of a core in stat calls.
    const read = new Map<string, { readonly stamp: string; readonly stranded: readonly string[] }>();
    return {
    name: "stray-work-reaches-its-own-branch",
    on: ["turn-settled", "sweep"],
    run: async ({ fail, moment }) => {
        const ids = agents.ids();
        // A conversation whose turn is still running is mid-work: its carry has not run yet, and a checkout it is
        // rebasing stands on a detached HEAD until the rebase ends. Its own turn-settled asks again.
        const running = new Set(live().map(({ conversationId }) => conversationId));
        // A few conversations at a time: one after another, the archive's thousands of checkouts outlasted the
        // check's five seconds on a busy disk and the check failed to run (35 times in a week).
        await mapPool(ids, STRAY_READS_AT_ONCE, async (id) => {
            const entry = agents.entry(id);
            // Non-isolated conversations run in the owner's own tree and have no branch of their own to stand on.
            if (entry === undefined || !isIsolated(entry) || running.has(id)) {
                read.delete(id);
                return;
            }
            // A turn settling is news about its own conversation, which its card says by moving: every other one
            // answers as its last reading did. The sweep reads them all, so what changed under an untouched card
            // (a person's `git checkout` in its copy) is still found within one sweep.
            const stamp = `${String(entry.updatedAt)}\u0000${JSON.stringify(entry.placement)}`;
            const held = read.get(id);
            if (moment === "turn-settled" && held?.stamp === stamp) {
                return;
            }
            // A rebase or merge under way is a person or an agent in the middle of git, not work stranded: the
            // shinobi-society audit (2026-11-17) found six "on a detached HEAD" alarms in three days, each mid-rebase.
            const off = (await strays(id, entry.placement.repos)).filter(({ carried, operation }) => !carried && operation === undefined);
            read.set(id, {
                stamp,
                stranded: off.map(({ repo, branch }) => `${id}/${repo} on ${branch ?? "a detached HEAD"}`),
            });
        });
        for (const id of read.keys()) {
            if (agents.entry(id) === undefined) {
                read.delete(id);
            }
        }
        // In the registry's order, however the reads finished.
        const stranded = ids.flatMap((id) => read.get(id)?.stranded ?? []);
        if (stranded.length > 0) {
            fail(
                `${stranded.length} checkout(s) stand off their conversation's own branch with commits the turn's carry could not copy onto agent/<id>, which review and land read: ${stranded.join(", ")}`,
            );
        }
    },
    };
};

export const checks = ({
    agents,
    conversations,
    agentWorktrees,
    live = () => liveTurnConversations(conversations),
    remoteTurns,
    now = Date.now,
    strays = (id, repos) => strayStandings(agentWorktrees, id, repos),
}: FleetRegistryDeps): readonly InvariantCheck[] => [
    strayWorkCheck(agents, live, strays),
    sharedCheckoutsCheck(agentWorktrees),
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
                    `${unkept.length} held turn(s) cannot be written for a restart, so a restart loses the turn and its booking or remedy: ${unkept.join(", ")}`,
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
            const alive = new Set([...runs, ...(remoteTurns?.live() ?? [])].map((run) => run.conversationId));
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
