import type { ActionApprovalSummary, AgentTurn, ApprovalSummary, PostApprovalSummary } from "@intentic/sandbox-contract";
import { actionTurnPrompt, DIRECT_PUBLISH_PLATFORMS, publishTurnPrompt } from "@intentic/sandbox-contract";
import { streamAgent } from "../agent/routes/agent.routes.js";
import { startConversationTurn } from "../agent/run/turn/turn-resume.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { publishRuntimeChange } from "../system/runtime-watch.js";
import { canPublishDirectly, postToDiscord } from "./discord-post.js";

// Sleeps until the exact due moment, one timer at a time, armed from disk (never memory) since both this daemon and the
// agent write the queue.
// Dispatched by kind: a Discord post takes an authenticated POST, other posts and all actions need an agent turn.
// `running` is written before any action starts, so a mid-death daemon leaves a stuck item rather than one done twice.

// How long a turn may sit before another pass reconsiders it; else a dead turn leaves `running` forever.
const RUNNING_STALE_MS = 30 * 60_000;

const isDue = (item: ApprovalSummary, now: number): boolean => item.status === `approved` && (item.scheduledAt ?? 0) <= now;

// The soonest approved item's due time, or undefined if nothing is approved.
// Already-due items answer `now`, so a queue that came due while the daemon was down fires on the next arm immediately.
export const nextDueAt = (items: readonly ApprovalSummary[], now: number): number | undefined => {
    const due = items.filter((item) => item.status === `approved`).map((item) => Math.max(item.scheduledAt ?? 0, now));
    return due.length === 0 ? undefined : Math.min(...due);
};

export interface ApprovalsExecutor {
    /** Re-read the queue and arm (or disarm) the timer for whatever is soonest. Safe to call on every change. */
    readonly arm: () => Promise<void>;
    readonly stop: () => void;
    /** One pass over everything due. `arm` calls it on time; exposed for tests. */
    readonly runDue: (now?: number) => Promise<void>;
}

// One turn per persona, not per batch: a turn wears exactly one face, so items under different names never share a
// turn.
// Within one face the batch still holds, since what's expensive about a turn is that it exists; `` is the key for no
// face.
const byPersona = <T extends ApprovalSummary>(items: readonly T[]): Map<string, T[]> => {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const face = item.actsAs ?? ``;
        groups.set(face, [...(groups.get(face) ?? []), item]);
    }
    return groups;
};

const isPost = (item: ApprovalSummary): item is PostApprovalSummary => item.kind === `post`;
const isAction = (item: ApprovalSummary): item is ActionApprovalSummary => item.kind === `action`;

const actionTitle = (actions: readonly ActionApprovalSummary[]): string =>
    actions.length === 1 ? (actions[0]?.summary ?? `Carry out 1 action`) : `Carry out ${actions.length} actions`;

export const createApprovalsExecutor = (services: Services, wake: WakeFn = streamAgent): ApprovalsExecutor => {
    let timer: NodeJS.Timeout | undefined;
    // One pass at a time: two overlapping passes could read `approved` before either writes `running`, twice.
    let running = false;

    const mark = async <T extends ApprovalSummary>(item: T, changes: Partial<T>): Promise<void> => {
        await services.approvals.upsert({ ...item, ...changes });
    };
    const fail = (item: ApprovalSummary, error: string): Promise<void> => mark(item, { status: `failed`, error });

    // Sends one post through the API its platform actually offers; returns whether it's now settled.
    // False hands it to the turn instead: the answer for a Discord post with an attachment or a channel named rather
    // than numbered.
    const sendDirect = async (post: PostApprovalSummary): Promise<boolean> => {
        if (!DIRECT_PUBLISH_PLATFORMS.has(post.platform.toLowerCase()) || !canPublishDirectly(post)) {
            return false;
        }
        await mark(post, { status: `running`, startedAt: Date.now() });
        try {
            const { url } = await postToDiscord(services, post);
            await mark(post, { status: `done`, finishedAt: Date.now(), result: url });
        } catch (error: unknown) {
            // The message is written for the owner's failed row, kept whole rather than reduced to a code.
            await fail(post, error instanceof Error ? error.message : `The post did not go through.`);
            services.logger.error({ err: error, approval: post.id }, `direct publish failed`);
        }
        return true;
    };

    // The same detached boundary POST /agent uses: registers the run, journals it so a daemon death resumes it, and
    // gives it an ordinary fleet card.
    // `running` goes on before the turn starts for the same reason the direct path does: a detached turn can die, and
    // `approved` would be redone by the next pass.
    const startTurn = async (items: readonly ApprovalSummary[], turn: AgentTurn & { conversationId: string }): Promise<void> => {
        await Promise.all(items.map((item) => mark(item, { status: `running`, startedAt: Date.now() })));
        void startConversationTurn(services, wake, turn).catch((error: unknown) =>
            services.logger.error({ err: error }, `approval turn failed to start`),
        );
    };

    // A name that resolves to nobody fails every kind: turnPersona denies an unknown card entirely, same as an unpinned
    // turn.
    // Said here in the queue rather than left to be rediscovered from inside a turn; returns the items that can go.
    const settleGhosts = async <T extends ApprovalSummary>(items: readonly T[], cast: ReadonlySet<string>): Promise<T[]> => {
        const ghosts = items.filter((item) => item.actsAs !== undefined && !cast.has(item.actsAs));
        for (const item of ghosts) {
            await fail(
                item,
                `No persona called "${item.actsAs}" exists, so nothing was done. A turn wearing a card nobody carries reaches no account at all. Point "actsAs" at a persona that holds the right account, then approve it again.`,
            );
        }
        return items.filter((item) => !ghosts.includes(item));
    };

    // A post that needs a turn and names nobody is failed, not sent: an unattended turn with no persona is denied every
    // logged-in account.
    // An action without a persona is not the same case: it runs with no accounts, which is right for work that needs
    // none.
    const settleUnnamed = async (posts: readonly PostApprovalSummary[]): Promise<PostApprovalSummary[]> => {
        for (const post of posts.filter((entry) => entry.actsAs === undefined)) {
            await fail(
                post,
                `Nobody is named to post this. ${post.platform} publishes through a logged-in browser, and this post does not say which persona's account to use, so nothing was sent. Set "actsAs" to a persona that holds the right ${post.platform} account, then approve it again.`,
            );
        }
        return posts.filter((entry) => entry.actsAs !== undefined);
    };

    const runDue = async (now = Date.now()): Promise<void> => {
        if (running) {
            return;
        }
        running = true;
        try {
            const { approvals } = await services.approvals.list();
            const due = approvals.filter((item) => isDue(item, now));
            if (due.length === 0) {
                return;
            }

            const forTurn: PostApprovalSummary[] = [];
            for (const post of due.filter(isPost)) {
                if (!(await sendDirect(post))) {
                    forTurn.push(post);
                }
            }

            const cast = new Set((await services.personas.list()).map((card) => card.id));
            const posts = await settleUnnamed(await settleGhosts(forTurn, cast));
            const actions = await settleGhosts(due.filter(isAction), cast);

            let batch = 0;
            // Short by construction: a persona id may run 60 chars, a conversation id 64, so a counter names the turn.
            const conversationId = (kind: string): string => `approvals-${kind}-${now.toString(36)}-${(batch += 1).toString(36)}`;

            for (const [actsAs, wearing] of byPersona(posts)) {
                await startTurn(wearing, {
                    prompt: publishTurnPrompt(wearing),
                    conversationId: conversationId(`post`),
                    unattended: true,
                    runRole: `approval-queue`,
                    // The turn wakes holding this persona's accounts.
                    actsAs,
                    title: wearing.length === 1 ? `Publish 1 post` : `Publish ${wearing.length} posts`,
                });
            }
            for (const [actsAs, wearing] of byPersona(actions)) {
                await startTurn(wearing, {
                    prompt: actionTurnPrompt(wearing),
                    conversationId: conversationId(`action`),
                    unattended: true,
                    runRole: `approval-queue`,
                    ...(actsAs === `` ? {} : { actsAs }),
                    title: actionTitle(wearing),
                });
            }

            // The queue on screen just changed status without the owner touching anything.
            publishRuntimeChange(`approvals`);
        } finally {
            running = false;
            // The next deadline is fresh: a failed item is no longer approved, a running one isn't due till stale.
            void arm();
        }
    };

    const arm = async (): Promise<void> => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        const now = Date.now();
        const { approvals } = await services.approvals.list();

        // An item left `running` by a dead turn is unreachable: not approved, so no pass retries it and nothing writes
        // its outcome.
        // After long enough that no live turn could still be working it, it's put back to failed, visible and
        // retryable, never silently redone.
        for (const item of approvals) {
            if (item.status === `running` && now - (item.startedAt ?? now) > RUNNING_STALE_MS) {
                await fail(
                    item,
                    `The run that was carrying this out stopped before it said what happened. Check before retrying, it may already be done.`,
                );
            }
        }

        const at = nextDueAt(approvals, now);
        if (at === undefined) {
            return;
        }
        timer = setTimeout(() => void runDue(), Math.max(0, at - now));
        // Never a reason to hold the process open: the deadline lives on disk for whenever the daemon comes back.
        timer.unref();
    };

    return {
        arm,
        stop: () => {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
        runDue,
    };
};

// One executor per sandbox, keyed to the services object that owns the queue: two instances would both arm a timer for
// the same deadline and double-post.
// Held weakly: a torn-down sandbox's executor goes with it.
const executors = new WeakMap<Services, ApprovalsExecutor>();

export const approvalsExecutorFor = (services: Services): ApprovalsExecutor => {
    const existing = executors.get(services);
    if (existing !== undefined) {
        return existing;
    }
    const executor = createApprovalsExecutor(services);
    executors.set(services, executor);
    return executor;
};
