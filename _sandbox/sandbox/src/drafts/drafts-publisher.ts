import type { AgentTurn, DraftSummary } from "@intentic/sandbox-contract";
import { DIRECT_PUBLISH_PLATFORMS, publishTurnPrompt } from "@intentic/sandbox-contract";
import { streamAgent } from "../agent/agent.routes.js";
import { startConversationTurn } from "../agent/turn-resume.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { publishRuntimeChange } from "../system/runtime-watch.js";
import { canPublishDirectly, postToDiscord } from "./discord-post.js";

/* THE PUBLISHER — what sends an approved post, and when.
 *
 * IT SLEEPS UNTIL THE EXACT MOMENT, which is the whole difference from what it replaces. Publishing was a cron
 * automation: a wake every few minutes that ran a shell guard over the drafts directory and, essentially
 * always, found nothing to do. That is a poll asking a question only this process could already answer — the
 * daemon writes the drafts, so it knows the earliest due time down to the millisecond. So it arms ONE timer for
 * that instant and holds nothing else: no drafts approved means no timer at all, and a queue of ten due at
 * different times is still one timer, re-armed as each passes.
 *
 * RE-ARMED FROM DISK, NEVER FROM MEMORY. `arm()` re-reads the queue every time rather than tracking a due time
 * alongside it, because the drafts directory has two writers — this daemon, and the agent's own file tools —
 * and a cached deadline is exactly the thing that goes stale when the other one writes. Reading a directory of
 * kilobyte files to answer "what is next" costs nothing next to being wrong about it. The same call re-arms
 * after every publish and at boot, which is what makes a hold survive a restart: the deadline lives in the
 * draft's own scheduledAt, so a daemon that was down through it publishes the moment it is back rather than
 * losing the post.
 *
 * TWO WAYS TO SEND, PICKED BY WHAT THE PLATFORM OFFERS (publish-drafts.ts). Discord takes an authenticated
 * POST, so the daemon makes it: milliseconds, no model, and a failure that is an HTTP status rather than a
 * transcript. Reddit and X are a logged-in browser session with no API behind them, so they need an agent turn
 * — and they get ONE turn for the whole batch, named drafts and all, because the expensive thing about a turn
 * is that it exists, not how many posts it carries.
 *
 * POSTING IS MARKED BEFORE IT HAPPENS. `posting` is written to the file before either path acts, so a daemon
 * that dies mid-send comes back to a draft that is visibly stuck rather than one that looks due and gets sent
 * twice. Double-posting is the only failure here that cannot be taken back. */

// How long a publish turn may sit before another sweep is allowed to reconsider its drafts. A turn that dies
// without writing a status leaves `posting` on disk forever otherwise, and nothing would ever retry it.
const POSTING_STALE_MS = 30 * 60_000;

const isDue = (draft: DraftSummary, now: number): boolean => draft.status === `approved` && (draft.scheduledAt ?? 0) <= now;

/* WHEN THIS PROCESS NEXT HAS SOMETHING TO DO — the soonest approved draft's due time, or undefined when the
 * queue holds nothing approved. Drafts that are already due answer `now`, so a queue that came due while the
 * daemon was down fires immediately on the next arm rather than waiting for a future one. */
export const nextDueAt = (drafts: readonly DraftSummary[], now: number): number | undefined => {
    const due = drafts.filter((draft) => draft.status === `approved`).map((draft) => Math.max(draft.scheduledAt ?? 0, now));
    return due.length === 0 ? undefined : Math.min(...due);
};

export interface DraftsPublisher {
    /** Re-read the queue and arm (or disarm) the timer for whatever is soonest. Safe to call on every change. */
    readonly arm: () => Promise<void>;
    readonly stop: () => void;
    /** One publish pass over everything due. `arm` calls it on time; exposed for tests. */
    readonly publishDue: (now?: number) => Promise<void>;
}

export const createDraftsPublisher = (services: Services, wake: WakeFn = streamAgent): DraftsPublisher => {
    let timer: NodeJS.Timeout | undefined;
    // One pass at a time. Two overlapping sweeps would both read the same `approved` draft before either wrote
    // `posting` — the read-modify-write race that ends in the same post going out twice.
    let running = false;

    const mark = async (draft: DraftSummary, changes: Partial<DraftSummary>): Promise<void> => {
        await services.drafts.upsert({ ...draft, ...changes });
    };

    /* Send one draft through the API its platform actually offers. Returns whether the draft is now settled —
     * false hands it to the turn instead, which is the answer for a Discord post carrying an attachment or
     * addressed to a channel by name rather than by id (discord-post.ts). */
    const sendDirect = async (draft: DraftSummary): Promise<boolean> => {
        if (!DIRECT_PUBLISH_PLATFORMS.has(draft.platform.toLowerCase()) || !canPublishDirectly(draft)) {
            return false;
        }
        await mark(draft, { status: `posting`, postingAt: Date.now() });
        try {
            const { url } = await postToDiscord(services, draft);
            await mark(draft, { status: `posted`, postedAt: Date.now(), postedUrl: url });
        } catch (error: unknown) {
            // The message is written for the owner to read in the queue's failed row, so it is kept whole
            // rather than reduced to a code — this is the only account of the failure anyone will get.
            await mark(draft, { status: `failed`, error: error instanceof Error ? error.message : `The post did not go through.` });
            services.logger.error({ err: error, draft: draft.id }, `direct publish failed`);
        }
        return true;
    };

    const publishDue = async (now = Date.now()): Promise<void> => {
        if (running) {
            return;
        }
        running = true;
        try {
            const { drafts } = await services.drafts.list();
            const due = drafts.filter((draft) => isDue(draft, now));
            if (due.length === 0) {
                return;
            }

            const forTurn: DraftSummary[] = [];
            for (const draft of due) {
                if (!(await sendDirect(draft))) {
                    forTurn.push(draft);
                }
            }

            if (forTurn.length > 0) {
                /* One turn for the batch. `posting` goes on before it starts for the same reason the direct
                 * path writes it before its request: the turn is detached and may die, and a draft still
                 * reading `approved` after that would be sent again by the next sweep. */
                await Promise.all(forTurn.map((draft) => mark(draft, { status: `posting`, postingAt: Date.now() })));
                const turn: AgentTurn & { conversationId: string } = {
                    prompt: publishTurnPrompt(forTurn),
                    conversationId: `publish-drafts-${now.toString(36)}`,
                    unattended: true,
                    title: forTurn.length === 1 ? `Publish 1 post` : `Publish ${forTurn.length} posts`,
                };
                /* The same detached boundary POST /agent uses — it registers the run, journals it so a daemon
                 * death resumes it, and gives the publish an ordinary card in the fleet instead of work that
                 * happens invisibly. Detached on purpose: this is a timer callback with no request waiting. */
                void startConversationTurn(services, wake, turn).catch((error: unknown) =>
                    services.logger.error({ err: error }, `publish turn failed to start`),
                );
            }

            // The queue on screen has just changed status under the owner without them touching anything.
            publishRuntimeChange(`drafts`);
        } finally {
            running = false;
            // Whatever just happened, the next deadline is a fresh question — a failed draft is no longer
            // approved, and a `posting` one is nobody's deadline until it goes stale.
            void arm();
        }
    };

    const arm = async (): Promise<void> => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        const now = Date.now();
        const { drafts } = await services.drafts.list();

        /* A draft left `posting` by a turn that died is unreachable: it is not approved, so no sweep will take
         * it, and nothing will ever write its outcome. After long enough that no live turn could still be
         * working it, it is put back to failed with a sentence saying so — visible, retryable, and never
         * silently re-sent. */
        for (const draft of drafts) {
            if (draft.status === `posting` && now - (draft.postingAt ?? now) > POSTING_STALE_MS) {
                await mark(draft, {
                    status: `failed`,
                    error: `The run that was posting this stopped before it said what happened. Check the platform before retrying — it may already be up.`,
                });
            }
        }

        const at = nextDueAt(drafts, now);
        if (at === undefined) {
            return;
        }
        timer = setTimeout(() => void publishDue(), Math.max(0, at - now));
        // Never a reason to hold the process open: a due post is sent when the daemon is up, and the deadline
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
        publishDue,
    };
};

/* ONE PUBLISHER PER SANDBOX, reached from the two places that need the same one: the drafts routes, which
 * re-arm it on every write, and boot, which arms it once so a hold that expired while the daemon was down goes
 * out. Two instances would each hold a timer for the same deadline and both wake for it — the double-post this
 * whole module is arranged to prevent — so the instance is keyed to the services object that owns the queue
 * rather than constructed at each call site. Held weakly: a torn-down sandbox's publisher goes with it. */
const publishers = new WeakMap<Services, DraftsPublisher>();

export const draftsPublisherFor = (services: Services): DraftsPublisher => {
    const existing = publishers.get(services);
    if (existing !== undefined) {
        return existing;
    }
    const publisher = createDraftsPublisher(services);
    publishers.set(services, publisher);
    return publisher;
};
