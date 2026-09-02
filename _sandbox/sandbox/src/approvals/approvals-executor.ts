import type { ActionApprovalSummary, AgentTurn, ApprovalSummary, PostApprovalSummary } from "@intentic/sandbox-contract";
import { actionTurnPrompt, DIRECT_PUBLISH_PLATFORMS, publishTurnPrompt } from "@intentic/sandbox-contract";
import { streamAgent } from "../agent/agent.routes.js";
import { startConversationTurn } from "../agent/turn-resume.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { publishRuntimeChange } from "../system/runtime-watch.js";
import { canPublishDirectly, postToDiscord } from "./discord-post.js";

/* THE EXECUTOR, what carries out an approved item, and when.
 *
 * IT SLEEPS UNTIL THE EXACT MOMENT, which is the whole difference from what it replaces. Publishing was a cron
 * automation: a wake every few minutes that ran a shell guard over the queue directory and, essentially
 * always, found nothing to do. That is a poll asking a question only this process could already answer, the
 * daemon writes the files, so it knows the earliest due time down to the millisecond. So it arms ONE timer for
 * that instant and holds nothing else: nothing approved means no timer at all, and a queue of ten due at
 * different times is still one timer, re-armed as each passes.
 *
 * RE-ARMED FROM DISK, NEVER FROM MEMORY. `arm()` re-reads the queue every time rather than tracking a due time
 * alongside it, because the directory has two writers, this daemon, and the agent's own file tools, and a
 * cached deadline is exactly the thing that goes stale when the other one writes. Reading a directory of
 * kilobyte files to answer "what is next" costs nothing next to being wrong about it. The same call re-arms
 * after every pass and at boot, which is what makes a hold survive a restart: the deadline lives in the item's
 * own scheduledAt, so a daemon that was down through it acts the moment it is back rather than losing the item.
 *
 * DISPATCHED BY KIND, and the kinds pick their door (approvals-execution.ts). A post to Discord takes an
 * authenticated POST, so the daemon makes it: milliseconds, no model, and a failure that is an HTTP status
 * rather than a transcript. A post to Reddit or X is a logged-in browser session with no API behind it, so it
 * needs an agent turn, and it gets ONE turn for the whole batch, named files and all, because the expensive
 * thing about a turn is that it exists, not how many posts it carries. An ACTION is always a turn: there is no
 * typed door for "whatever it is", and the instructions the proposing agent left are the whole brief.
 *
 * RUNNING IS MARKED BEFORE IT HAPPENS. `running` is written to the file before any path acts, so a daemon that
 * dies mid-way comes back to an item that is visibly stuck rather than one that looks due and gets done twice.
 * Doing it twice is the only failure here that cannot be taken back. */

// How long a turn may sit before another pass is allowed to reconsider its items. A turn that dies without
// writing a status leaves `running` on disk forever otherwise, and nothing would ever retry it.
const RUNNING_STALE_MS = 30 * 60_000;

const isDue = (item: ApprovalSummary, now: number): boolean => item.status === `approved` && (item.scheduledAt ?? 0) <= now;

/* WHEN THIS PROCESS NEXT HAS SOMETHING TO DO, the soonest approved item's due time, or undefined when the
 * queue holds nothing approved. Items that are already due answer `now`, so a queue that came due while the
 * daemon was down fires immediately on the next arm rather than waiting for a future one. */
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

/* ONE TURN PER PERSONA, not one per batch. A turn wears exactly one face, so two items going out under
 * different names are two turns however close together they came due, batching them would hand the second to
 * an account that cannot act on it. Within one face the batch still holds, because the expensive thing about a
 * turn is that it exists. `` is the key for no face at all. */
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
    // One pass at a time. Two overlapping passes would both read the same `approved` item before either wrote
    // `running`, the read-modify-write race that ends in the same thing done twice.
    let running = false;

    const mark = async <T extends ApprovalSummary>(item: T, changes: Partial<T>): Promise<void> => {
        await services.approvals.upsert({ ...item, ...changes });
    };
    const fail = (item: ApprovalSummary, error: string): Promise<void> => mark(item, { status: `failed`, error });

    /* Send one post through the API its platform actually offers. Returns whether the post is now settled,
     * false hands it to the turn instead, which is the answer for a Discord post carrying an attachment or
     * addressed to a channel by name rather than by id (discord-post.ts). */
    const sendDirect = async (post: PostApprovalSummary): Promise<boolean> => {
        if (!DIRECT_PUBLISH_PLATFORMS.has(post.platform.toLowerCase()) || !canPublishDirectly(post)) {
            return false;
        }
        await mark(post, { status: `running`, startedAt: Date.now() });
        try {
            const { url } = await postToDiscord(services, post);
            await mark(post, { status: `done`, finishedAt: Date.now(), result: url });
        } catch (error: unknown) {
            // The message is written for the owner to read in the queue's failed row, so it is kept whole
            // rather than reduced to a code, this is the only account of the failure anyone will get.
            await fail(post, error instanceof Error ? error.message : `The post did not go through.`);
            services.logger.error({ err: error, approval: post.id }, `direct publish failed`);
        }
        return true;
    };

    /* The same detached boundary POST /agent uses, it registers the run, journals it so a daemon death resumes
     * it, and gives the work an ordinary card in the fleet instead of something that happens invisibly.
     * Detached on purpose: this is a timer callback with no request waiting. `running` goes on every item
     * before the turn starts for the same reason the direct path writes it before its request: the turn is
     * detached and may die, and an item still reading `approved` after that would be done again by the next
     * pass. */
    const startTurn = async (items: readonly ApprovalSummary[], turn: AgentTurn & { conversationId: string }): Promise<void> => {
        await Promise.all(items.map((item) => mark(item, { status: `running`, startedAt: Date.now() })));
        void startConversationTurn(services, wake, turn).catch((error: unknown) =>
            services.logger.error({ err: error }, `approval turn failed to start`),
        );
    };

    /* WHO CAN BE WORN. A name that resolves to nobody is a failure for every kind, and deliberately not a softer
     * one: turnPersona answers an unknown card by denying everything, so the turn arrives with no account
     * exactly as an unpinned one does. A card can go missing for ordinary reasons, renamed on one side only, a
     * workspace cloned before its personas were committed, which is why this is worth saying in the queue rather
     * than leaving to be rediscovered from inside a turn. Returns the items that CAN go. */
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

    /* A POST THAT NEEDS A TURN AND NAMES NOBODY IS FAILED, NOT SENT. The turn this would wake is unattended, and
     * an unattended turn with no persona is denied every logged-in account (personas.ts spells out why: at 3am
     * the prompt's wording is the only thing standing between a stranger and a public post). So the turn would
     * open the platform in a browser signed into nothing, meet the wall a cold profile always meets, and report
     * the account as disconnected, which is what happened before this check existed, and it cost two approved
     * posts and an afternoon to trace.
     *
     * Failing here says the true thing in the one place the owner reads. Guessing the persona instead is the
     * alternative worth naming and rejecting: one site is often connected several times over, and a post that
     * goes out under the wrong face is public and has no undo.
     *
     * AN ACTION WITHOUT A PERSONA IS NOT THE SAME CASE: it runs with no accounts, which is exactly right for
     * work that needs none, and the skill says so. Returns the posts that CAN go. */
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
            // Short by construction: a persona id may be 60 characters and a conversation id may be 64, so the
            // batch counter distinguishes the turns rather than the name they act as.
            const conversationId = (kind: string): string => `approvals-${kind}-${now.toString(36)}-${(batch += 1).toString(36)}`;

            for (const [actsAs, wearing] of byPersona(posts)) {
                await startTurn(wearing, {
                    prompt: publishTurnPrompt(wearing),
                    conversationId: conversationId(`post`),
                    unattended: true,
                    // The whole point of this pass: the turn wakes holding that persona's accounts.
                    actsAs,
                    title: wearing.length === 1 ? `Publish 1 post` : `Publish ${wearing.length} posts`,
                });
            }
            for (const [actsAs, wearing] of byPersona(actions)) {
                await startTurn(wearing, {
                    prompt: actionTurnPrompt(wearing),
                    conversationId: conversationId(`action`),
                    unattended: true,
                    ...(actsAs === `` ? {} : { actsAs }),
                    title: actionTitle(wearing),
                });
            }

            // The queue on screen has just changed status under the owner without them touching anything.
            publishRuntimeChange(`approvals`);
        } finally {
            running = false;
            // Whatever just happened, the next deadline is a fresh question, a failed item is no longer
            // approved, and a `running` one is nobody's deadline until it goes stale.
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

        /* An item left `running` by a turn that died is unreachable: it is not approved, so no pass will take
         * it, and nothing will ever write its outcome. After long enough that no live turn could still be
         * working it, it is put back to failed with a sentence saying so, visible, retryable, and never
         * silently redone. */
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
        // Never a reason to hold the process open: a due item is done when the daemon is up, and the deadline
        // is on disk for when it is not.
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

/* ONE EXECUTOR PER SANDBOX, reached from the two places that need the same one: the approvals routes, which
 * re-arm it on every write, and boot, which arms it once so a hold that expired while the daemon was down is
 * acted on. Two instances would each hold a timer for the same deadline and both wake for it, the double-post
 * this whole module is arranged to prevent, so the instance is keyed to the services object that owns the
 * queue rather than constructed at each call site. Held weakly: a torn-down sandbox's executor goes with it. */
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
