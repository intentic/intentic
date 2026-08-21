import type { AgentEvent, AgentReply } from "@intentic/sandbox-contract";
import { CHECKOUT_LIB_AFTER, CHECKOUT_LIB_BEFORE, CHECKOUT_ROUTE } from "./fixture/workspace";
import type { StreamSink } from "./sse";

/* THE TURN THE VISITOR WATCHES, a recorded `AgentEvent` sequence played back on a timer.
 *
 * `/agent/attach` is an event iterator over AttachFrame, and every part of the streaming transcript is driven by
 * the frames inside it: thinking folds, text deltas type, tool cards appear pending and resolve, the todo list
 * ticks over, the context meter fills. So a script of those frames needs no cooperation from the UI at all,
 * this is the real chat panel reacting to the real protocol, and the only fiction is where the bytes came from.
 *
 * The two INTERACTIVE frames are why this is a demo rather than a video. A `plan` or `question` frame parks the
 * turn until `POST /agent/reply` resolves its requestId, exactly as the daemon parks a real one, so the script
 * stops, the card waits, and the visitor's click is what starts it moving again. */

/** One recorded beat: wait, then emit. `park` holds the script until the app replies to that requestId. */
interface Beat {
    readonly after: number;
    readonly event: AgentEvent;
    readonly park?: string;
}

const TODOS = [
    `Read the pricing page and the current checkout stub`,
    `Add a POST /checkout/session endpoint`,
    `Wire the pricing page's CTA to it`,
    `Cover the redirect with a test`,
];

const todos = (done: number, running: number): AgentEvent => ({
    kind: `todos`,
    items: TODOS.map((content, index) =>
        index === running ? { content, status: `in_progress`, activeForm: content } : { content, status: index < done ? `completed` : `pending` },
    ),
});

/* The featured run: the Stripe-checkout agent, mid-turn. It opens on a plan card (so the very first thing the
 * visitor is asked to do is approve a plan), works through four todos, and ends on a question, the two moments
 * that prove an agent here is co-piloted rather than watched. */
const FEATURED: Beat[] = [
    { after: 300, event: { kind: `init`, model: `claude-sonnet-5` } },
    { after: 200, event: { kind: `mode`, mode: `plan` } },
    {
        after: 400,
        event: {
            kind: `thinking`,
            text: `The pricing page already has a CTA, so the work is the session endpoint and the redirect. Let me read both sides first.`,
        },
    },
    {
        after: 700,
        event: {
            kind: `tool_call`,
            id: `tc_read_pricing`,
            name: `Read`,
            category: `read`,
            status: `in_progress`,
            target: `web/src/pricing/PricingPage.tsx`,
            locations: [{ path: `web/src/pricing/PricingPage.tsx`, line: 42 }],
        },
    },
    {
        after: 900,
        event: {
            kind: `tool_call_update`,
            id: `tc_read_pricing`,
            status: `completed`,
            content: [{ type: `text`, text: `84 lines · the CTA calls checkout() from ../lib/checkout, which currently throws NotImplemented.` }],
        },
    },
    {
        after: 600,
        event: {
            kind: `plan`,
            requestId: `req_plan_checkout`,
            text: `## Add Stripe checkout

1. **\`api/src/routes/checkout.ts\`**: a \`POST /checkout/session\` route that creates a Stripe Checkout session for the requested price and returns its URL.
2. **\`web/src/lib/checkout.ts\`**: replace the \`NotImplemented\` stub with a call to that route, then redirect.
3. **\`web/src/pricing/CheckoutPanel.tsx\`**: surface the pending + failed states on the CTA.
4. **Test**: cover the redirect and the failure path in \`web/tests/checkout.spec.ts\`.

Prices come from the existing \`STRIPE_PRICE_*\` env vars, so nothing new needs provisioning.`,
        },
        park: `req_plan_checkout`,
    },
    { after: 200, event: { kind: `mode`, mode: `acceptEdits` } },
    { after: 300, event: todos(0, 0) },
    { after: 500, event: { kind: `delta`, text: `Approved, writing the endpoint first.` } },
    { after: 400, event: { kind: `text_end` } },
    { after: 300, event: todos(1, 1) },
    {
        after: 500,
        event: {
            kind: `tool_call`,
            id: `tc_write_route`,
            name: `Write`,
            category: `edit`,
            status: `in_progress`,
            target: `api/src/routes/checkout.ts`,
            locations: [{ path: `api/src/routes/checkout.ts` }],
        },
    },
    {
        after: 1_100,
        event: {
            kind: `tool_call_update`,
            id: `tc_write_route`,
            status: `completed`,
            content: [{ type: `diff`, path: `api/src/routes/checkout.ts`, newText: CHECKOUT_ROUTE }],
        },
    },
    { after: 300, event: { kind: `context_usage`, tokens: 82_400, contextWindow: 200_000 } },
    { after: 400, event: todos(2, 2) },
    {
        after: 400,
        event: {
            kind: `tool_call`,
            id: `tc_edit_cta`,
            name: `Edit`,
            category: `edit`,
            status: `in_progress`,
            target: `web/src/lib/checkout.ts`,
            locations: [{ path: `web/src/lib/checkout.ts`, line: 12 }],
        },
    },
    {
        after: 900,
        event: {
            kind: `tool_call_update`,
            id: `tc_edit_cta`,
            status: `completed`,
            content: [{ type: `diff`, path: `web/src/lib/checkout.ts`, oldText: CHECKOUT_LIB_BEFORE, newText: CHECKOUT_LIB_AFTER }],
        },
    },
    { after: 400, event: { kind: `terminal`, session: `agent-checkout-stripe` } },
    {
        after: 300,
        event: {
            kind: `tool_call`,
            id: `tc_bash_test`,
            name: `Bash`,
            category: `execute`,
            status: `in_progress`,
            target: `pnpm -C web test checkout`,
        },
    },
    { after: 300, event: todos(3, 3) },
    {
        after: 1_400,
        event: {
            kind: `tool_call_update`,
            id: `tc_bash_test`,
            status: `completed`,
            content: [
                { type: `text`, text: `✓ web/tests/checkout.spec.ts (3)\n\nTest Files  1 passed (1)\n     Tests  3 passed (3)\n  Duration  2.14s` },
            ],
        },
    },
    { after: 400, event: { kind: `delta`, text: `Endpoint, client call and test are in. One decision left before I touch the CTA's copy.` } },
    { after: 300, event: { kind: `text_end` } },
    {
        after: 500,
        event: {
            kind: `question`,
            requestId: `req_question_cta`,
            questions: [
                {
                    question: `What should the CTA do while the Stripe redirect is in flight?`,
                    header: `CTA state`,
                    multiSelect: false,
                    options: [
                        {
                            label: `Inline spinner (Recommended)`,
                            description: `Keep the button in place, swap the label for a spinner. No layout shift.`,
                        },
                        { label: `Full-page overlay`, description: `Block the page while redirecting, heavier, but nothing else is clickable.` },
                        { label: `Optimistic navigate`, description: `Move to /welcome immediately and reconcile when Stripe answers.` },
                    ],
                },
            ],
        },
        park: `req_question_cta`,
    },
    { after: 400, event: todos(4, -1) },
    { after: 300, event: { kind: `delta`, text: `Done, the CTA shows an inline spinner, and the whole flow is covered.` } },
    { after: 300, event: { kind: `text_end` } },
    { after: 300, event: { kind: `usage`, account: `ada@acme.dev`, costUsd: 1.84, inputTokens: 184_320, outputTokens: 21_460 } },
    { after: 200, event: { kind: `worktree`, branch: `agent/checkout-stripe`, base: `4f1c8ab` } },
    { after: 200, event: { kind: `done` } },
];

/* The reply to anything the VISITOR sends. Short on purpose: the point of the composer in a demo is that it
 * answers at all, and a long canned monologue is the moment the illusion turns into an advert. */
const replyScript = (prompt: string): Beat[] => [
    { after: 250, event: { kind: `init`, model: `claude-sonnet-5` } },
    {
        after: 350,
        event: {
            kind: `thinking`,
            text: `The visitor asked: "${prompt}". This is the demo workspace, so I can look, but the real answer is their own sandbox.`,
        },
    },
    {
        after: 600,
        event: {
            kind: `tool_call`,
            id: `tc_demo_read`,
            name: `Read`,
            category: `read`,
            status: `in_progress`,
            target: `README.md`,
            locations: [{ path: `README.md`, line: 1 }],
        },
    },
    {
        after: 700,
        event: {
            kind: `tool_call_update`,
            id: `tc_demo_read`,
            status: `completed`,
            content: [{ type: `text`, text: `acme-shop, a two-repo demo workspace.` }],
        },
    },
    {
        after: 500,
        event: {
            kind: `delta`,
            text: `This is a **recorded workspace**, I can show you every surface, but I can't run your code from here.\n\nStart a sandbox on your own machine and the same agent works on your repos, with your keys, under your branch protection.`,
        },
    },
    { after: 300, event: { kind: `text_end` } },
    { after: 200, event: { kind: `done` } },
];

/* One playing run.
 *
 * It keeps a LOG of the frames it has emitted, because that is the contract `/agent/attach` has with the client:
 * a frame carries the `seq` it was logged at, the head frame says how many were logged when the attach landed,
 * and everything up to that boundary is REPLAY (the app renders it without animating, then switches to live).
 * Any client can therefore join a turn already in progress, which in the demo is not an edge case but the
 * common one: a reload, a second tab, or the panel remounting when the visitor navigates. Without the log, each
 * attach restarted the script and the transcript began again mid-sentence.
 *
 * Parks are promises the reply route resolves, so the script's own `await` is the same suspension the daemon's
 * turn goes through when a card is raised. */
export interface Run {
    readonly id: string;
    readonly conversationId: string;
    readonly prompt: string;
    readonly startedAt: number;
    resolve: (requestId: string, reply: AgentReply) => void;
    /** Attach one consumer: replay the log, then follow live until the run ends or the consumer goes away. */
    attach: (sink: StreamSink) => void;
    stop: () => void;
}

const wait = (ms: number, signal: { stopped: boolean }): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (signal.stopped) {
            clearTimeout(timer);
            resolve();
        }
    });

/** Build a run from a beat script. Frames are numbered as the daemon numbers them: 1-based `seq`. */
const createRun = (conversationId: string, prompt: string, beats: Beat[], now: number): Run => {
    const parks = new Map<string, (reply: AgentReply | undefined) => void>();
    const signal = { stopped: false };
    const log: { seq: number; event: AgentEvent }[] = [];
    const sinks = new Set<StreamSink>();
    let ended = false;
    const id = `run_${conversationId}`;

    const publish = (event: AgentEvent): void => {
        const frame = { seq: log.length + 1, event };
        log.push(frame);
        for (const sink of sinks) {
            if (sink.closed) {
                sinks.delete(sink);
                continue;
            }
            sink.emit({ kind: `frame`, ...frame });
        }
    };

    const finish = (): void => {
        ended = true;
        for (const sink of sinks) {
            if (!sink.closed) {
                sink.emit({ kind: `end` });
                sink.close();
            }
        }
        sinks.clear();
    };

    // Runs the script ONCE, from the moment the run is created, not per attach, or every consumer would start
    // its own copy of the same turn.
    void (async () => {
        for (const beat of beats) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a recorded stream is sequential by definition
            await wait(beat.after, signal);
            if (signal.stopped) {
                return;
            }
            publish(beat.event);
            if (beat.park === undefined) {
                continue;
            }
            const requestId = beat.park;
            // oxlint-disable-next-line eslint/no-await-in-loop -- the park IS the turn waiting on the user
            const reply = await new Promise<AgentReply | undefined>((resolve) => parks.set(requestId, resolve));
            if (signal.stopped) {
                return;
            }
            publish({ kind: `resolved`, requestId, ...(reply === undefined ? {} : { reply }) });
        }
        finish();
    })();

    return {
        id,
        conversationId,
        prompt,
        startedAt: now,
        resolve: (requestId, reply) => {
            const waiter = parks.get(requestId);
            if (waiter === undefined) {
                return;
            }
            parks.delete(requestId);
            waiter(reply);
        },
        stop: () => {
            signal.stopped = true;
            for (const [requestId, waiter] of parks) {
                parks.delete(requestId);
                waiter(undefined);
            }
            finish();
        },
        attach: (sink) => {
            // The head's `seq` is the replay/live boundary: everything at or below it is this run's story so far.
            sink.emit({ kind: `attached`, run: id, prompt, startedAt: now, seq: log.length });
            for (const frame of log) {
                sink.emit({ kind: `frame`, ...frame });
            }
            if (ended) {
                sink.emit({ kind: `end` });
                sink.close();
                return;
            }
            sinks.add(sink);
        },
    };
};

export const featuredRun = (conversationId: string, now: number): Run =>
    createRun(conversationId, `Add Stripe checkout to the pricing page: the CTA is already there, it just throws.`, FEATURED, now);

export const visitorRun = (conversationId: string, prompt: string, now: number): Run => createRun(conversationId, prompt, replyScript(prompt), now);
