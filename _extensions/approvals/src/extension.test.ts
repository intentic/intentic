import type { ApprovalsList, ApprovalSummary, AutomationApproval, HookRequest, HookRequests, PostApprovalSummary } from "@intentic/sandbox-contract";
import type { ExtensionContext, HostQuery, IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { waitFor } from "@intentic/testing/bun";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { extensionIdOf } from "@intentic/extension-manifest";
import { activate, approvalsAttention } from "./extension";
import { bindHost } from "./host";
import { messages } from "./i18n";
import { manifest } from "./manifest";
import { asksOf } from "./asks";
import { heldWakesQuery, waitingOf } from "./useHeldWakes";
import { waitingHooksOf } from "./useHookRequests";

// What the queue asks of a person, for the host's Needs you inbox: proposals owing a yes, failures owing a retry, hook
// sets owing a yes or a no, never anything already underway; and its presses, which are the page's own writes.

// The host registers this before it calls `activate`; a test that calls `activate` itself has to, or every label it
// asserts on reads as its own dotted key.
await registerExtensionMessages(extensionIdOf(manifest), messages);

const post = (id: string, over: Partial<PostApprovalSummary> = {}): PostApprovalSummary => ({
    id,
    kind: `post`,
    platform: `x`,
    content: `hi`,
    status: `proposed`,
    ...over,
});

const wake = (id: string, over: Partial<AutomationApproval> = {}): AutomationApproval => ({
    id,
    automationId: `nightly`,
    createdAt: 1,
    ...over,
});

const hookSet = (digest: string, over: Partial<HookRequest> = {}): HookRequest => ({
    digest,
    seenAt: 1,
    hooks: [{ source: `project`, event: `PreToolUse`, matcher: `Bash`, type: `command`, run: `./guard.sh` }],
    scripts: [],
    ...over,
});

// Presses that only record, for the asks built without a host.
const pressed: unknown[] = [];
const presses = {
    save: async (item: ApprovalSummary) => void pressed.push(item),
    letHooksRun: async (digest: string) => void pressed.push(digest),
    keepHooksOff: async (digest: string) => void pressed.push(digest),
};

// `hooks` absent reads as a reader below maintainer, whom the daemon refuses: the badge must not count what it can't read.
const fakeHost = (approvals: ApprovalsList, held: AutomationApproval[], hooks?: HookRequests) => {
    const procedures: string[] = [];
    const writes: unknown[] = [];
    const views: ViewRegistration[] = [];
    const api = {
        sandbox: {
            key: (...parts: readonly string[]) => [`sandbox`, `box`, ...parts],
            reachable: () => true,
            role: () => (hooks === undefined ? `viewer` : `owner`),
            rpc: {
                approvals: {
                    list: async () => approvals,
                    upsert: async (item: ApprovalSummary) => {
                        writes.push({ upsert: item });
                        return { ok: true };
                    },
                    approveHooks: async (input: { digest: string }) => {
                        writes.push({ approveHooks: input.digest });
                        return { ok: true };
                    },
                    hookRequests: async () => {
                        if (hooks === undefined) {
                            throw new Error(`requires the maintainer tier`);
                        }
                        return hooks;
                    },
                },
                automations: {
                    pendingList: async () => {
                        procedures.push(`automations.pendingList`);
                        return { approvals: held };
                    },
                },
            },
            fetch: async <T>(query: HostQuery<T>): Promise<T> => query.queryFn(),
        },
        views: {
            register: (view: ViewRegistration) => {
                views.push(view);
                return { dispose: () => undefined };
            },
        },
    } as unknown as IntenticApi;
    return { api, procedures, views, writes };
};

const subscriptions: { dispose(): void }[] = [];
afterEach(() => {
    for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
    }
    jest.restoreAllMocks();
});

describe(`what the queue owes`, () => {
    it(`asks about proposals, failures and unreadable files, and nothing on its way or done`, () => {
        const list: ApprovalsList = {
            approvals: [post(`a`), post(`b`, { status: `approved` }), post(`c`, { status: `failed`, error: `Rate limited.` }), post(`d`, { status: `done` })],
            invalid: [`typo.json`],
        };
        const asks = asksOf({ list }, presses);
        // What already broke leads, then what waits for a first yes, then the files no row can stand for.
        expect(asks.map((ask) => [ask.id, ask.tone])).toEqual([
            [`c`, `danger`],
            [`a`, undefined],
            [`invalid`, `danger`],
        ]);
        expect(asks[0]).toMatchObject({ kind: `Post`, title: `hi`, context: `X`, note: `Rate limited.`, open: `/ext/approvals?scope=x` });
        expect(asks[0]?.actions?.map((action) => action.label)).toEqual([`Retry`]);
        expect(asks[1]?.actions?.map((action) => [action.label, action.tone])).toEqual([[`Approve`, `primary`]]);
        expect(asks[2]).toMatchObject({ title: `1 approval file can't be read`, body: `typo.json` });
    });

    it(`says where a post goes and as whom, and lets an action's specifics be read before the yes`, () => {
        const action: ApprovalSummary = {
            id: `r`,
            kind: `action`,
            summary: `Refund order 1182`,
            details: `Stripe refund of $40`,
            instructions: `Refund order 1182 in Stripe.`,
            status: `proposed`,
            actsAs: `billing`,
        };
        const asks = asksOf({ list: { approvals: [post(`p`, { platform: `reddit`, target: `r/selfhosted`, title: `Show HN` }), action], invalid: [] } }, presses);
        expect(asks.map((ask) => [ask.kind, ask.title, ask.context, ask.body, ask.open])).toEqual([
            [`Post`, `Show HN`, `Reddit · r/selfhosted`, `hi`, `/ext/approvals?scope=reddit`],
            [`Action`, `Refund order 1182`, `as billing`, `Stripe refund of $40`, `/ext/approvals?scope=actions`],
        ]);
        // A post goes out as the characters it is; an action's specifics are Markdown, and drawn as such.
        expect(asks.map((ask) => ask.bodyFormat)).toEqual([`text`, `markdown`]);
    });

    it(`leads an untitled post with its opening line cut to a headline, since the whole post is the body under it`, () => {
        const opening = `Checkout is live on the pricing page: pick a plan, pay with Stripe, and you are in. No sales call.`;
        const [ask] = asksOf({ list: { approvals: [post(`p`, { content: `${opening}\nTry it today.` })], invalid: [] } }, presses);
        expect(ask?.title).toBe(`Checkout is live on the pricing page: pick a plan, pay with Stripe, and you are…`);
        expect(ask?.body).toBe(`${opening}\nTry it today.`);
    });

    it(`asks a yes or a no of each hook set still waiting, and names a record it could not read`, () => {
        const asks = asksOf({ hooks: { requests: [hookSet(`h`), hookSet(`k`, { dismissed: true })], ledgerUnreadable: true } }, presses);
        expect(asks.map((ask) => [ask.id, ask.title, ask.tone])).toEqual([
            [`hooks:h`, `Let 1 Claude Code hook run`, undefined],
            [`hook-ledger`, `The record of approved hooks can't be read`, `danger`],
        ]);
        expect(asks[0]?.body).toBe(`PreToolUse  Bash  ./guard.sh`);
        expect(asks[0]?.actions?.map((action) => action.label)).toEqual([`Let them run`, `Keep off`]);
    });

    it(`counts hook sets waiting for a yes, and not one the owner chose to keep off`, () => {
        expect(waitingHooksOf({ requests: [hookSet(`a`), hookSet(`b`, { dismissed: true })] }).map((request) => request.digest)).toEqual([`a`]);
        expect(waitingHooksOf(undefined)).toEqual([]);
    });

    it(`counts only the held wakes that genuinely need a person`, () => {
        // A hold with `autoRunAt` is a delay the scheduler releases itself; nobody is actually being asked.
        expect(waitingOf([wake(`a`), wake(`b`, { autoRunAt: 2 }), wake(`c`)]).map((entry) => entry.id)).toEqual([`a`, `c`]);
    });

    it(`reads the held wakes from one sandbox-scoped entry, the one the view reads`, async () => {
        const { api, procedures } = fakeHost({ approvals: [], invalid: [] }, []);
        bindHost(api);
        const query = heldWakesQuery();
        expect(query.queryKey).toEqual([`sandbox`, `box`, `automation-approvals`]);
        await expect(query.queryFn()).resolves.toEqual([]);
        expect(procedures).toEqual([`automations.pendingList`]);
    });
});

describe(`the asks in Needs you`, () => {
    const activateWith = (...args: Parameters<typeof fakeHost>) => {
        const fake = fakeHost(...args);
        bindHost(fake.api);
        activate(fake.api, { extensionId: `ext-approvals`, subscriptions } satisfies ExtensionContext);
        return fake;
    };

    it(`asks about every kind of yes the queue owes, and leaves held wakes to the host's own list`, async () => {
        const { views } = activateWith(
            { approvals: [post(`a`), post(`b`, { status: `done` })], invalid: [] },
            [wake(`w`), wake(`d`, { autoRunAt: 2 })],
            { requests: [hookSet(`h`), hookSet(`k`, { dismissed: true })] },
        );
        const registered = views[0];
        expect(registered?.id).toBe(`approvals`);
        // No count of its own: the inbox carries the one number for everything waiting on a person.
        expect(registered?.badge).toBeUndefined();
        // Waits for the asks' content, not just their existence, since a first poll could catch an empty value.
        await waitFor(() => expect(registered?.asks?.().map((ask) => ask.id)).toEqual([`a`, `hooks:h`]));
        // The queries the page reads, so it opens on data, not a spinner.
        expect(registered?.warm?.().map((query) => query.queryKey)).toEqual([
            [`sandbox`, `box`, `approvals`],
            [`sandbox`, `box`, `automation-approvals`],
            [`sandbox`, `box`, `approvals`, `hooks`],
        ]);
    });

    it(`asks nothing of a reader below maintainer, who has no yes to give, and warms no hook sets for them`, async () => {
        const { views } = activateWith({ approvals: [post(`a`)], invalid: [] }, []);
        await waitFor(() => expect(approvalsAttention.state.value?.list?.approvals.map((item) => item.id)).toEqual([`a`]));
        expect(views[0]?.asks?.()).toEqual([]);
        expect(views[0]?.warm?.().map((query) => query.queryKey)).toEqual([
            [`sandbox`, `box`, `approvals`],
            [`sandbox`, `box`, `automation-approvals`],
        ]);
    });

    it(`approves with the page's own write, the whole item re-posted with its status moved`, async () => {
        const { views, writes } = activateWith({ approvals: [post(`a`)], invalid: [] }, [], { requests: [hookSet(`h`)] });
        await waitFor(() => expect(views[0]?.asks?.().length).toBe(2));
        await views[0]?.asks?.()[0]?.actions?.[0]?.run();
        await views[0]?.asks?.()[1]?.actions?.[0]?.run();
        expect(writes).toEqual([{ upsert: { ...post(`a`), status: `approved` } }, { approveHooks: `h` }]);
    });

    /* COULD NOT ASK IS NOT NOTHING THERE: a maintainer's hook sets that failed to load must not fall out of the inbox. */
    it(`keeps its last asks when a maintainer's hook sets cannot be read, rather than dropping them`, async () => {
        const { api, views } = fakeHost({ approvals: [post(`a`)], invalid: [] }, [], { requests: [hookSet(`h`)] });
        let hookReads = 0;
        let failing = false;
        (api.sandbox.rpc.approvals as { hookRequests: () => Promise<HookRequests> }).hookRequests = async () => {
            hookReads += 1;
            if (failing) {
                throw new Error(`the daemon is restarting`);
            }
            return { requests: [hookSet(`h`)] };
        };
        bindHost(api);
        activate(api, { extensionId: `ext-approvals`, subscriptions });
        await waitFor(() => expect(views[0]?.asks?.().length).toBe(2));

        failing = true;
        const before = hookReads;
        approvalsAttention.refresh();
        await waitFor(() => expect(hookReads).toBe(before + 1));
        // Every step of a read is a settled promise here, so one macrotask later the failed read has finished.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(views[0]?.asks?.().map((ask) => ask.id)).toEqual([`a`, `hooks:h`]);
    });

    it(`asks nothing at all when nothing is owed`, async () => {
        const { views } = activateWith({ approvals: [post(`a`, { status: `approved` })], invalid: [] }, [wake(`d`, { autoRunAt: 2 })], { requests: [] });
        // Waits rather than asserts immediately: the state is sandbox-scoped module state that outlives activation, and
        // this is the poll clearing it, the direction that actually matters.
        await waitFor(() => expect(approvalsAttention.state.value?.list?.approvals.map((item) => item.status)).toEqual([`approved`]));
        expect(views[0]?.asks?.()).toEqual([]);
    });
});
