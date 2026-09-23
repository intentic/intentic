import type { ApprovalsList, AutomationApproval, HookRequest, HookRequests, PostApprovalSummary } from "@intentic/sandbox-contract";
import type { Activation, ExtensionContext, HostQuery, IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { describe, it, expect, afterEach, jest } from "bun:test";
import { waitFor } from "@intentic/testing/bun";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { extensionIdOf } from "@intentic/extension-manifest";
import { activate } from "./extension";
import { bindHost } from "./host";
import { messages } from "./i18n";
import { manifest } from "./manifest";
import { owedOf } from "./useApprovals";
import { heldWakesQuery, waitingOf } from "./useHeldWakes";
import { waitingHooksOf } from "./useHookRequests";

// The badge seats the tile; it counts proposals owing a decision and automations held for one, never anything already
// underway.

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
            key: (...parts: readonly string[]) => [`sandbox`, `box`, ...parts],
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

const tile: Activation = { key: `approvals`, title: `Approvals` };

describe(`what the queue owes`, () => {
    it(`counts proposals, failures and unreadable files, and nothing on its way or done`, () => {
        const list: ApprovalsList = {
            approvals: [post(`a`), post(`b`, { status: `approved` }), post(`c`, { status: `failed` }), post(`d`, { status: `done` })],
            invalid: [`typo.json`],
        };
        expect(owedOf(list)).toEqual({ owed: 3, broken: 2 });
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

describe(`the Approvals tile`, () => {
    it(`badges every kind of yes owed, which is also what seats it on the rail`, async () => {
        const { api, views } = fakeHost(
            { approvals: [post(`a`), post(`b`, { status: `done` })], invalid: [] },
            [wake(`w`), wake(`d`, { autoRunAt: 2 })],
            { requests: [hookSet(`h`), hookSet(`k`, { dismissed: true })] },
        );
        bindHost(api);
        const context: ExtensionContext = { extensionId: `ext-approvals`, subscriptions };

        activate(api, context);

        const registered = views[0];
        expect(registered?.id).toBe(`approvals`);
        // One proposal, one waiting wake and one hook set count; the done post, the delayed hold and the hook set kept
        // off don't. Waits for the badge's content, not just its existence, since a first poll could catch an empty value.
        await waitFor(() => expect(registered?.badge?.(tile)).toMatchObject({ count: 3, tooltip: `3 waiting on you`, tone: `info` }));
        // The queries the badge itself already filled, so the page opens on data, not a spinner.
        expect(registered?.warm?.().map((query) => query.queryKey)).toEqual([
            [`sandbox`, `box`, `approvals`],
            [`sandbox`, `box`, `automation-approvals`],
            [`sandbox`, `box`, `approvals`, `hooks`],
        ]);
    });

    it(`turns to danger when the record of approved hooks cannot be read, since then no hook runs`, async () => {
        const { api, views } = fakeHost({ approvals: [], invalid: [] }, [], { requests: [hookSet(`h`)], ledgerUnreadable: true });
        bindHost(api);
        activate(api, { extensionId: `ext-approvals`, subscriptions });
        await waitFor(() => expect(views[0]?.badge?.(tile)).toMatchObject({ count: 1, tone: `danger` }));
    });

    it(`leaves hook sets out for a reader the daemon refuses them to, badge and warm read alike`, async () => {
        const { api, views } = fakeHost({ approvals: [post(`a`)], invalid: [] }, []);
        bindHost(api);
        activate(api, { extensionId: `ext-approvals`, subscriptions });
        await waitFor(() => expect(views[0]?.badge?.(tile)).toMatchObject({ count: 1, tone: `info` }));
        expect(views[0]?.warm?.().map((query) => query.queryKey)).toEqual([
            [`sandbox`, `box`, `approvals`],
            [`sandbox`, `box`, `automation-approvals`],
        ]);
    });

    it(`turns to danger once something is broken rather than merely waiting`, async () => {
        const { api, views } = fakeHost({ approvals: [post(`a`, { status: `failed` })], invalid: [] }, []);
        bindHost(api);
        activate(api, { extensionId: `ext-approvals`, subscriptions });
        await waitFor(() => expect(views[0]?.badge?.(tile)).toMatchObject({ count: 1, tone: `danger` }));
    });

    it(`says nothing at all when nothing is owed, and so holds no seat`, async () => {
        const { api, views } = fakeHost({ approvals: [post(`a`, { status: `approved` })], invalid: [] }, [wake(`d`, { autoRunAt: 2 })]);
        bindHost(api);

        activate(api, { extensionId: `ext-approvals`, subscriptions });

        // Waits rather than asserts immediately: the badge is sandbox-scoped module state that outlives activation, and
        // this is the poll clearing it, the direction that actually matters.
        await waitFor(() => expect(views[0]?.badge?.(tile)).toBeUndefined());
    });
});
