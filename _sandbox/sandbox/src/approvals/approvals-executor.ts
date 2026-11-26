import { errorMessage } from "@intentic/base/errors";
import type { ApprovedActionOutcome } from "@intentic/extension-api/runtime";
import type { ActionApprovalSummary, ApprovalSummary, PostApprovalSummary } from "@intentic/sandbox-contract/schemas/approvals";
import type { AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import { actionTurnPrompt, publishTurnPrompt } from "@intentic/sandbox-contract/policy/approvals-execution";
import type { Services } from "../composition.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";
import { type ApprovalStanding, approvalStandings, type SpentApproval, spendApprovals } from "./approval-decisions.js";
import { type PerformedAction, performApprovedAction, publishApprovedPost, type PublishedPost } from "./approval-performers.js";
import { type PostChannel, postChannels, postingNotes, publisherOf } from "./post-channels.js";
import { BUILT_IN_ROLES, NO_ACCOUNTS_ROLE } from "@intentic/sandbox-contract/schemas/roles";

// Sleeps until the exact due moment, one timer at a time, armed from disk (never memory) since both this daemon and the
// agent write the queue.
// Dispatched by kind: a post goes to the extension whose card publishes on its platform (its `channel.publish`, a Discord
// bot's), when there is one and the post is one it can address; every other post and every action without a performer
// needs an agent turn.
// `running` is written before any action starts, so a mid-death daemon leaves a stuck item rather than one done twice.
// An item's `approved` is only a claim, since the agent writes the file too: it runs when the owner's yes on the history
// volume (approval-decisions.ts) matches what it says now. An action naming a `performer` never reaches a turn: once its
// yes is spent, the extension's backend carries it out (approval-performers.ts) and its outcome is written here, and so
// does a post its platform's extension publishes (2026-11-26; before, a Discord-only path in the daemon posted it).

// How long a turn may sit before another pass reconsiders it; else a dead turn leaves `running` forever.
const RUNNING_STALE_MS = 30 * 60_000;

const isDue = (item: ApprovalSummary, now: number): boolean => item.status === `approved` && (item.scheduledAt ?? 0) <= now;

// The soonest approved item's due time, or undefined if nothing is approved.
// Already-due items answer `now`, so a queue that came due while the daemon was down fires on the next arm immediately.
export const nextDueAt = (items: readonly ApprovalSummary[], now: number): number | undefined => {
    const due = items.filter((item) => item.status === `approved`).map((item) => Math.max(item.scheduledAt ?? 0, now));
    return due.length === 0 ? undefined : Math.min(...due);
};

// The wake the queue promises, for whoever must not sleep through it (bootstrap/promised-wakes.ts): the soonest approved item,
// read off the store as the executor's own timer reads it, so the two cannot disagree about when the queue next fires.
export const nextApprovedAt = async (services: Pick<Services, "approvals">, now: number = Date.now()): Promise<number | undefined> =>
    nextDueAt((await services.approvals.list()).approvals, now);

export interface ApprovalsExecutor {
    /** Re-read the queue and arm (or disarm) the timer for whatever is soonest. Safe to call on every change. */
    readonly arm: () => Promise<void>;
    readonly stop: () => void;
    /** One pass over everything due. `arm` calls it on time; exposed for tests. */
    readonly runDue: (now?: number) => Promise<void>;
}

// One turn per role, not per batch: a turn wears exactly one face, so items under different names never share a
// turn.
// Within one face the batch still holds, since what's expensive about a turn is that it exists; `` is the key for no
// face.
const byRole = <T extends ApprovalSummary>(items: readonly T[]): Map<string, T[]> => {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const face = item.actsAs ?? ``;
        groups.set(face, [...(groups.get(face) ?? []), item]);
    }
    return groups;
};

const isPost = (item: ApprovalSummary): item is PostApprovalSummary => item.kind === `post`;
const isAction = (item: ApprovalSummary): item is ActionApprovalSummary => item.kind === `action`;
const isPerformed = (item: ApprovalSummary): item is PerformedAction => isAction(item) && item.performer !== undefined;

const actionTitle = (actions: readonly ActionApprovalSummary[]): string =>
    actions.length === 1 ? (actions[0]?.summary ?? `Carry out 1 action`) : `Carry out ${actions.length} actions`;

// Why an item marked approved was not carried out, for its failed row. A retry from the app is the yes given again,
// over the item as it stands then.
const NOT_APPROVED: Readonly<Record<Exclude<ApprovalStanding, `approved`>, string>> = {
    unapproved: `Nothing was done: there is no yes from the owner on record for this. An item is approved in the app, never by writing "approved" into its file. Read it, then retry if it is what you want.`,
    changed: `Nothing was done: this changed after it was approved, and the yes covered it as it was then. Read it as it is now, then retry if it is still what you want.`,
    unreadable: `Nothing was done: the record of what was approved could not be read. Read it, then retry to approve it again.`,
};

// What an extension's outcome becomes on the item's row. A refusal reached nothing outside, so a new yes may run it again;
// an uncertain one may already have happened, and nothing here repeats it.
const performedError = (outcome: { readonly outcome: `refused` | `uncertain`; readonly error: string }): string =>
    outcome.outcome === `refused`
        ? `Nothing was done: ${outcome.error}`
        : `This may already have happened: ${outcome.error}. Check the system it was sent to before approving it again; it is never retried by itself.`;

// Every role an approved item may name: the cards, and the built-ins, which are always there, so naming one is never
// a ghost.
const wearable = async (services: Services): Promise<ReadonlySet<string>> =>
    new Set([...(await services.roles.list()).map((card) => card.id), ...BUILT_IN_ROLES.map((builtIn) => builtIn.id)]);

// One item an extension's backend carries out, with what the audit trail records of who did it.
interface HandedOver {
    readonly item: ApprovalSummary;
    readonly yes: SpentApproval;
    readonly audited: Readonly<Record<string, string>>;
    readonly hand: () => Promise<ApprovedActionOutcome>;
}

// The due items an extension's backend carries out, and the posts left for a turn: an action naming its `performer`, and
// a post whose platform's extension publishes it (post-channels.ts publisherOf). Every other post goes to a turn, the
// answer for one with an attachment or a target its card's pattern does not address (a channel named, not numbered).
const handedToExtensions = (
    services: Services,
    channels: ReadonlyMap<string, PostChannel>,
    due: readonly ApprovalSummary[],
    yeses: ReadonlyMap<string, SpentApproval>,
) => {
    const handed: HandedOver[] = [];
    const forTurn: PostApprovalSummary[] = [];
    for (const post of due.filter(isPost)) {
        const publisher = publisherOf(channels, post);
        const yes = yeses.get(post.id);
        if (publisher === undefined || yes === undefined || post.target === undefined) {
            forTurn.push(post);
            continue;
        }
        const published: PublishedPost = { ...post, target: post.target };
        const extension = publisher.extension.id;
        handed.push({ item: post, yes, audited: { extension, platform: post.platform.toLowerCase() }, hand: () => publishApprovedPost(services, extension, published, yes) });
    }
    for (const item of due.filter(isPerformed)) {
        const yes = yeses.get(item.id);
        if (yes !== undefined) {
            const audited = { extension: item.performer.extension, digest: item.performer.digest };
            handed.push({ item, yes, audited, hand: () => performApprovedAction(services, item, yes) });
        }
    }
    return { handed, forTurn };
};

export const createApprovalsExecutor = (services: Services): ApprovalsExecutor => {
    let timer: NodeJS.Timeout | undefined;
    // One pass at a time: two overlapping passes could read `approved` before either writes `running`, twice.
    let running = false;

    const mark = async <T extends ApprovalSummary>(item: T, changes: Partial<T>): Promise<void> => {
        await services.approvals.upsert({ ...item, ...changes });
    };
    const fail = (item: ApprovalSummary, error: string): Promise<void> => mark(item, { status: `failed`, error });

    // Fails unsent every due item without a yes matching it, then spends the yes of the rest before anything acts on
    // them, so the file being put back to approved later runs nothing a second time. Returns the items this pass spent a
    // yes for, with the yes: an item whose yes another caller spent first is that caller's to carry out.
    const settleUnapproved = async <T extends ApprovalSummary>(items: readonly T[]): Promise<{ due: T[]; yeses: ReadonlyMap<string, SpentApproval> }> => {
        const roots = { historyRoot: services.config.historyRoot, workspaceRoot: services.workspace.root };
        const standingOf = await approvalStandings(roots);
        const cleared: T[] = [];
        for (const item of items) {
            const standing = await standingOf(item);
            if (standing === `approved`) {
                cleared.push(item);
                continue;
            }
            services.logger.warn(
                { approval: item.id, standing },
                `approvals: an item marked approved has no yes matching it, so it was not carried out`,
            );
            await fail(item, NOT_APPROVED[standing]);
        }
        const yeses = await spendApprovals(roots, cleared);
        for (const item of cleared.filter((entry) => !yeses.has(entry.id))) {
            services.logger.warn({ approval: item.id }, `approvals: another pass spent this item's yes first, so this one leaves it alone`);
        }
        return { due: cleared.filter((item) => yeses.has(item.id)), yeses };
    };

    // An item its extension carries out itself: `running` first, as for every door, then the backend's own outcome.
    // Its yes is already spent, so nothing here can carry it out twice; an uncertain outcome is failed, never redone.
    const handOver = async ({ item, yes, audited, hand }: HandedOver): Promise<void> => {
        await mark(item, { status: `running`, startedAt: Date.now() });
        let outcome: ApprovedActionOutcome;
        try {
            outcome = await hand();
        } catch (error) {
            // Whatever throws out of it threw before the door was asked (its request is caught inside): nothing went out.
            outcome = { outcome: `refused`, error: errorMessage(error) };
        }
        services.audit.record({
            actor: { kind: `system`, reason: `approvals executor` },
            action: `approvals.performed`,
            target: item.id,
            outcome: outcome.outcome === `done` ? `ok` : outcome.outcome === `refused` ? `refused` : `failed`,
            details: { ...audited, approver: yes.approver ?? null, approvedAt: yes.approvedAt },
        });
        if (outcome.outcome === `done`) {
            await mark(item, { status: `done`, finishedAt: Date.now(), result: outcome.result });
            return;
        }
        services.logger.warn({ approval: item.id, outcome: outcome.outcome }, `approvals: an extension did not carry out an approved item`);
        await fail(item, performedError(outcome));
    };

    // The same detached boundary POST /agent uses: registers the run, journals it so a daemon death resumes it, and
    // gives it an ordinary fleet card.
    // `running` goes on before the turn starts for the same reason the direct path does: a detached turn can die, and
    // `approved` would be redone by the next pass.
    const startTurn = async (items: readonly ApprovalSummary[], turn: AgentTurn & { conversationId: string }): Promise<void> => {
        await Promise.all(items.map((item) => mark(item, { status: `running`, startedAt: Date.now() })));
        void services.turns.start(turn).catch((error: unknown) => services.logger.error({ err: error }, `approval turn failed to start`));
    };

    // A name that resolves to nobody fails every kind: turnRole denies an unknown card every account and every tool.
    //
    // Said here in the queue rather than left to be rediscovered from inside a turn; returns the items that can go.
    const settleGhosts = async <T extends ApprovalSummary>(items: readonly T[], cast: ReadonlySet<string>): Promise<T[]> => {
        const ghosts = items.filter((item) => item.actsAs !== undefined && !cast.has(item.actsAs));
        for (const item of ghosts) {
            await fail(
                item,
                `No role called "${item.actsAs}" exists, so nothing was done. A turn wearing a card nobody carries reaches no account at all. Point "actsAs" at a role that holds the right account, then approve it again.`,
            );
        }
        return items.filter((item) => !ghosts.includes(item));
    };

    // A post that needs a turn and names nobody is failed, not sent: an unattended turn with no role wears No accounts,
    // which is denied every logged-in account. Naming No accounts outright is the same post.
    // An action without a role is not the same case: it runs with no accounts, which is right for work that needs
    // none.
    const settleUnnamed = async (posts: readonly PostApprovalSummary[]): Promise<PostApprovalSummary[]> => {
        for (const post of posts.filter((entry) => entry.actsAs === undefined || entry.actsAs === NO_ACCOUNTS_ROLE)) {
            await fail(
                post,
                `Nobody is named to post this. ${post.platform} publishes through a logged-in browser, and this post does not say which role's account to use, so nothing was sent. Set "actsAs" to a role that holds the right ${post.platform} account, then approve it again.`,
            );
        }
        return posts.filter((entry) => entry.actsAs !== undefined && entry.actsAs !== NO_ACCOUNTS_ROLE);
    };

    const runDue = async (now = Date.now()): Promise<void> => {
        if (running) {
            return;
        }
        running = true;
        try {
            const { approvals } = await services.approvals.list();
            const marked = approvals.filter((item) => isDue(item, now));
            if (marked.length === 0) {
                return;
            }
            const { due, yeses } = await settleUnapproved(marked);

            const channels = await postChannels(services);
            const { handed, forTurn } = handedToExtensions(services, channels, due, yeses);
            for (const each of handed) {
                await handOver(each);
            }

            const cast = await wearable(services);
            const posts = await settleUnnamed(await settleGhosts(forTurn, cast));
            const actions = await settleGhosts(
                due.filter(isAction).filter((item) => item.performer === undefined),
                cast,
            );

            let batch = 0;
            // Short by construction: a role id may run 60 chars, a conversation id 64, so a counter names the turn.
            const conversationId = (kind: string): string => `approvals-${kind}-${now.toString(36)}-${(batch += 1).toString(36)}`;

            for (const [actsAs, wearing] of byRole(posts)) {
                await startTurn(wearing, {
                    prompt: publishTurnPrompt(wearing, postingNotes(channels, wearing.map((post) => post.platform))),
                    conversationId: conversationId(`post`),
                    unattended: true,
                    runRole: `approval-queue`,
                    // The turn wakes holding this role's accounts.
                    actsAs,
                    title: wearing.length === 1 ? `Publish 1 post` : `Publish ${wearing.length} posts`,
                });
            }
            for (const [actsAs, wearing] of byRole(actions)) {
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
