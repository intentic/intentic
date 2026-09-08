import type { ApprovalsList, AutomationApproval, PostApprovalSummary } from "@intentic/sandbox-contract";
import type { Activation, ExtensionContext, HostQuery, IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activate } from "./extension";
import { bindHost } from "./host";
import { owedOf } from "./useApprovals";
import { heldWakesQuery, waitingOf } from "./useHeldWakes";

// The badge seats the tile; it counts proposals owing a decision and automations held for one, never anything already
// underway.

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

const fakeHost = (approvals: ApprovalsList, held: AutomationApproval[]) => {
    const paths: string[] = [];
    const views: ViewRegistration[] = [];
    const api = {
        sandbox: {
            key: (...parts: readonly string[]) => [`sandbox`, `box`, ...parts],
            reachable: () => true,
            json: async (path: string) => {
                paths.push(path);
                return { approvals: held };
            },
            rpc: { approvals: { list: async () => approvals } },
            fetch: async <T>(query: HostQuery<T>): Promise<T> => query.queryFn(),
        },
        views: {
            register: (view: ViewRegistration) => {
                views.push(view);
                return { dispose: () => undefined };
            },
        },
    } as unknown as IntenticApi;
    return { api, paths, views };
};

const subscriptions: { dispose(): void }[] = [];
afterEach(() => {
    for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
    }
    vi.restoreAllMocks();
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

    it(`counts only the held wakes that genuinely need a person`, () => {
        // A hold with `autoRunAt` is a delay the scheduler releases itself; nobody is actually being asked.
        expect(waitingOf([wake(`a`), wake(`b`, { autoRunAt: 2 }), wake(`c`)]).map((entry) => entry.id)).toEqual([`a`, `c`]);
    });

    it(`reads the held wakes from one sandbox-scoped entry, the one the view reads`, async () => {
        const { api, paths } = fakeHost({ approvals: [], invalid: [] }, []);
        bindHost(api);
        const query = heldWakesQuery();
        expect(query.queryKey).toEqual([`sandbox`, `box`, `automation-approvals`]);
        await expect(query.queryFn()).resolves.toEqual([]);
        expect(paths).toEqual([`/automations/pending`]);
    });
});

describe(`the Approvals tile`, () => {
    it(`badges every kind of yes owed, which is also what seats it on the rail`, async () => {
        const { api, views } = fakeHost({ approvals: [post(`a`), post(`b`, { status: `done` })], invalid: [] }, [
            wake(`w`),
            wake(`d`, { autoRunAt: 2 }),
        ]);
        bindHost(api);
        const context: ExtensionContext = { extensionId: `ext-approvals`, subscriptions };

        activate(api, context);

        const registered = views[0];
        expect(registered?.id).toBe(`approvals`);
        // One proposal plus one waiting wake count; the done post and delayed hold don't. Waits for the badge's
        // content, not just its existence, since a first poll could catch an empty value.
        await vi.waitFor(() => expect(registered?.badge?.(tile)).toMatchObject({ count: 2, tooltip: `2 waiting on you`, tone: `info` }));
        // Both queries the badge itself already filled, so the page opens on data, not a spinner.
        expect(registered?.warm?.().map((query) => query.queryKey)).toEqual([
            [`sandbox`, `box`, `approvals`],
            [`sandbox`, `box`, `automation-approvals`],
        ]);
    });

    it(`turns to danger once something is broken rather than merely waiting`, async () => {
        const { api, views } = fakeHost({ approvals: [post(`a`, { status: `failed` })], invalid: [] }, []);
        bindHost(api);
        activate(api, { extensionId: `ext-approvals`, subscriptions });
        await vi.waitFor(() => expect(views[0]?.badge?.(tile)).toMatchObject({ count: 1, tone: `danger` }));
    });

    it(`says nothing at all when nothing is owed, and so holds no seat`, async () => {
        const { api, views } = fakeHost({ approvals: [post(`a`, { status: `approved` })], invalid: [] }, [wake(`d`, { autoRunAt: 2 })]);
        bindHost(api);

        activate(api, { extensionId: `ext-approvals`, subscriptions });

        // Waits rather than asserts immediately: the badge is sandbox-scoped module state that outlives activation, and
        // this is the poll clearing it, the direction that actually matters.
        await vi.waitFor(() => expect(views[0]?.badge?.(tile)).toBeUndefined());
    });
});
