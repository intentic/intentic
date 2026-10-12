import type { ApprovalsList, AutomationApproval, HookRequest, HookRequests, PostApprovalSummary } from "@intentic/sandbox-contract";
import type { ExtensionContext, HostQuery, IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { waitFor } from "@intentic/testing/bun";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { extensionIdOf } from "@intentic/extension-manifest";
import { activate, approvalsAttention } from "./extension";
import { bindHost } from "./host";
import { messages } from "./i18n";
import { manifest } from "./manifest";
import { owedBadge } from "./owed";
import { heldWakesQuery, waitingOf } from "./useHeldWakes";
import { waitingHooksOf } from "./useHookRequests";

// What the queue owes a person, as its tile's badge: proposals owing a yes, failures owing a retry, hook sets owing a yes
// or a no, never anything already underway, and never a held wake, which the board draws and the Agents tile counts.

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

// `hooks` absent reads as a reader below maintainer, whom the daemon refuses: the badge must not count what it can't read.
const fakeHost = (approvals: ApprovalsList, held: AutomationApproval[], hooks?: HookRequests) => {
    const procedures: string[] = [];
    const views: ViewRegistration[] = [];
    const api = {
        sandbox: {
            readKey: (procedure: string, input?: unknown) => [procedure, ...(input === undefined ? [] : [input]), `box`],
            reachable: () => true,
            role: () => (hooks === undefined ? `viewer` : `owner`),
            rpc: {
                approvals: {
                    list: async () => approvals,
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
    return { api, procedures, views };
};

const subscriptions: { dispose(): void }[] = [];
afterEach(() => {
    for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
    }
    jest.restoreAllMocks();
});

describe(`what the queue owes`, () => {
    it(`counts proposals, failures and unreadable files, and nothing on its way or done`, () => {
        const list: ApprovalsList = {
            approvals: [post(`a`), post(`b`, { status: `approved` }), post(`c`, { status: `failed`, error: `Rate limited.` }), post(`d`, { status: `done` })],
            invalid: [`typo.json`],
        };
        // What already broke sets the tone and leads the words, then what waits for a first yes.
        expect(owedBadge({ list })).toEqual({ count: 3, tone: `danger`, tooltip: `1 failed · 1 file can't be read · 1 to approve` });
    });

    it(`is a warning, not a fault, while everything owed is a first yes`, () => {
        expect(owedBadge({ list: { approvals: [post(`a`), post(`b`)], invalid: [] } })).toEqual({ count: 2, tone: `warning`, tooltip: `2 to approve` });
    });

    it(`counts each hook set still waiting, and names a record it could not read`, () => {
        expect(owedBadge({ hooks: { requests: [hookSet(`h`), hookSet(`k`, { dismissed: true })], ledgerUnreadable: true } })).toEqual({
            count: 2,
            tone: `danger`,
            tooltip: `the record of approved hooks can't be read · 1 hook set waiting`,
        });
    });

    it(`draws nothing when nothing is owed, or nothing was read yet`, () => {
        expect(owedBadge({ list: { approvals: [post(`a`, { status: `approved` })], invalid: [] }, hooks: { requests: [] } })).toBeUndefined();
        expect(owedBadge(undefined)).toBeUndefined();
    });

    it(`counts hook sets waiting for a yes, and not one the owner chose to keep off`, () => {
        expect(waitingHooksOf({ requests: [hookSet(`a`), hookSet(`b`, { dismissed: true })] }).map((request) => request.digest)).toEqual([`a`]);
        expect(waitingHooksOf(undefined)).toEqual([]);
    });

    it(`counts only the held wakes that genuinely need a person`, () => {
        // A hold with `autoRunAt` is a delay the scheduler releases itself; nobody is actually being asked.
        expect(waitingOf([wake(`a`), wake(`b`, { autoRunAt: 2 }), wake(`c`)]).map((entry) => entry.id)).toEqual([`a`, `c`]);
    });

    it(`reads the held wakes from the procedure's own entry, the one the view reads`, async () => {
        const { api, procedures } = fakeHost({ approvals: [], invalid: [] }, []);
        bindHost(api);
        const query = heldWakesQuery();
        expect(query.queryKey).toEqual([`automations.pendingList`, `box`]);
        await expect(query.queryFn()).resolves.toEqual({ approvals: [] });
        expect(procedures).toEqual([`automations.pendingList`]);
    });
});

describe(`the Approvals tile`, () => {
    const activateWith = (...args: Parameters<typeof fakeHost>) => {
        const fake = fakeHost(...args);
        bindHost(fake.api);
        activate(fake.api, { extensionId: `ext-approvals`, subscriptions } satisfies ExtensionContext);
        return fake;
    };

    it(`badges every kind of yes the queue owes, and leaves held wakes to the board`, async () => {
        const { views } = activateWith(
            { approvals: [post(`a`), post(`b`, { status: `done` })], invalid: [] },
            [wake(`w`), wake(`d`, { autoRunAt: 2 })],
            { requests: [hookSet(`h`), hookSet(`k`, { dismissed: true })] },
        );
        const registered = views[0];
        expect(registered?.id).toBe(`approvals`);
        // Nothing for a host inbox to draw: the tile's badge is the whole of what the queue owes.
        expect(registered?.asks).toBeUndefined();
        // Waits for the badge's content, not just its existence, since a first poll could catch an empty value.
        await waitFor(() => expect(registered?.badge?.({ key: `approvals`, title: `Approvals` })?.count).toBe(2));
        // The queries the page reads, so it opens on data, not a spinner.
        expect(registered?.warm?.().map((query) => query.queryKey)).toEqual([
            [`approvals.list`, `box`],
            [`automations.pendingList`, `box`],
            [`approvals.hookRequests`, `box`],
        ]);
    });

    it(`badges nothing for a reader below maintainer, who has no yes to give, and warms no hook sets for them`, async () => {
        const { views } = activateWith({ approvals: [post(`a`)], invalid: [] }, []);
        await waitFor(() => expect(approvalsAttention.state.value?.list?.approvals.map((item) => item.id)).toEqual([`a`]));
        expect(views[0]?.badge?.({ key: `approvals`, title: `Approvals` })).toBeUndefined();
        expect(views[0]?.warm?.().map((query) => query.queryKey)).toEqual([
            [`approvals.list`, `box`],
            [`automations.pendingList`, `box`],
        ]);
    });

    /* COULD NOT READ IS NOT NOTHING THERE: a maintainer's hook sets that failed to load must not fall out of the badge. */
    it(`keeps its last count when a maintainer's hook sets cannot be read, rather than dropping them`, async () => {
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
        const count = () => views[0]?.badge?.({ key: `approvals`, title: `Approvals` })?.count;
        await waitFor(() => expect(count()).toBe(2));

        failing = true;
        const before = hookReads;
        approvalsAttention.refresh();
        await waitFor(() => expect(hookReads).toBe(before + 1));
        // Every step of a read is a settled promise here, so one macrotask later the failed read has finished.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(count()).toBe(2);
    });

    it(`badges nothing at all when nothing is owed`, async () => {
        const { views } = activateWith({ approvals: [post(`a`, { status: `approved` })], invalid: [] }, [wake(`d`, { autoRunAt: 2 })], { requests: [] });
        // Waits rather than asserts immediately: the state is sandbox-scoped module state that outlives activation, and
        // this is the poll clearing it, the direction that actually matters.
        await waitFor(() => expect(approvalsAttention.state.value?.list?.approvals.map((item) => item.status)).toEqual([`approved`]));
        expect(views[0]?.badge?.({ key: `approvals`, title: `Approvals` })).toBeUndefined();
    });
});
