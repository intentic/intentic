import type { ApprovalsList, AutomationApproval, PostApprovalSummary } from "@intentic/sandbox-contract";
import type { Activation, ExtensionContext, HostQuery, IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activate } from "./extension";
import { bindHost } from "./host";
import { owedOf } from "./useApprovals";
import { heldWakesQuery, waitingOf } from "./useHeldWakes";

/* The badge is what seats the tile, so what it counts is the whole question: the agent's proposals that owe a
 * decision, the automations held for one, and nothing that is about to happen on its own. */

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
        // A hold with an `autoRunAt` is a DELAY: the scheduler releases it itself, so nobody is being asked for
        // anything and the rail must not say otherwise.
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
        // One proposal plus one wake waiting for a yes; the done post and the countdown hold count for nothing.
        // Settling on the badge's CONTENT, not on its existence: polled separately, the wait could be satisfied
        // by a first, empty badge and the assertion after it read a value that had already moved on.
        await vi.waitFor(() => expect(registered?.badge?.(tile)).toMatchObject({ count: 2, tooltip: `2 waiting on you`, tone: `info` }));
        // Warming both entries the badge already filled: the page opens on the queue rather than on a spinner.
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

        // Waited for rather than asserted on the spot: the badge is module state that outlives one activation
        // (it is scoped to the sandbox, not to the view), so this is the poll's answer landing and CLEARING a
        // count, which is the direction that actually matters, a tile that cannot stand down never stands down.
        await vi.waitFor(() => expect(views[0]?.badge?.(tile)).toBeUndefined());
    });
});
