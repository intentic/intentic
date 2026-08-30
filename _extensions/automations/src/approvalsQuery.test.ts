import type { AutomationApproval } from "@intentic/sandbox-contract";
import type { Activation, ExtensionContext, HostQuery, IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalsQuery, owedOf } from "./approvalsQuery";
import { activate } from "./extension";
import { bindHost } from "./host";

const approval = (id: string, over: Partial<AutomationApproval> = {}): AutomationApproval => ({
    id,
    automationId: `nightly`,
    createdAt: 1,
    ...over,
});

const fakeHost = (approvals: AutomationApproval[]) => {
    const paths: string[] = [];
    const views: ViewRegistration[] = [];
    const api = {
        sandbox: {
            key: (...parts: readonly string[]) => [`sandbox`, `box`, ...parts],
            reachable: () => true,
            json: async (path: string) => {
                paths.push(path);
                return { approvals };
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
    return { api, paths, views };
};

const subscriptions: { dispose(): void }[] = [];
afterEach(() => {
    for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
    }
    vi.restoreAllMocks();
});

const tile: Activation = { key: `automations`, title: `Automations` };

describe(`the held-wake queue`, () => {
    it(`uses one sandbox-scoped entry, the one the view reads`, async () => {
        const { api, paths } = fakeHost([]);
        bindHost(api);

        const query = approvalsQuery();
        expect(query.queryKey).toEqual([`sandbox`, `box`, `automation-approvals`]);
        await expect(query.queryFn()).resolves.toEqual([]);
        expect(paths).toEqual([`/automations/pending`]);
    });

    it(`counts only the wakes that genuinely need a person`, () => {
        // A hold with an `autoRunAt` is a DELAY: the scheduler releases it itself, so nobody is being asked for
        // anything and the rail must not say otherwise.
        const owed = owedOf([approval(`a`), approval(`b`, { autoRunAt: 2 }), approval(`c`)]);
        expect(owed.map((entry) => entry.id)).toEqual([`a`, `c`]);
    });
});

describe(`the Automations tile`, () => {
    it(`badges the wakes waiting for a yes, which is also what seats it on the rail`, async () => {
        const { api, views } = fakeHost([approval(`a`), approval(`b`, { autoRunAt: 2 })]);
        bindHost(api);
        const context: ExtensionContext = { extensionId: `ext-automations`, subscriptions };

        activate(api, context);

        const registered = views[0];
        expect(registered?.id).toBe(`automations`);
        // The poll reads on start, so the tile can be seated on its first render rather than five minutes in.
        // Settling on the badge's CONTENT, not on its existence: polled separately, the wait could be satisfied
        // by a first, empty badge and the assertion after it read a value that had already moved on.
        await vi.waitFor(() => expect(registered?.badge?.(tile)).toMatchObject({ count: 1, tooltip: `1 waiting for a yes` }));
        // Warming the entry the badge already filled: the page opens on the queue rather than on a spinner.
        expect(registered?.warm?.()[0]).toMatchObject({ queryKey: [`sandbox`, `box`, `automation-approvals`] });
    });

    it(`says nothing at all when the queue is empty, and so holds no seat`, async () => {
        const { api, views } = fakeHost([]);
        bindHost(api);

        activate(api, { extensionId: `ext-automations`, subscriptions });

        // Waited for rather than asserted on the spot: the badge is module state that outlives one activation
        // (it is scoped to the sandbox, not to the view), so this is the poll's answer landing and CLEARING a
        // count, which is the direction that actually matters, a tile that cannot stand down never stands down.
        await vi.waitFor(() => expect(views[0]?.badge?.(tile)).toBeUndefined());
    });
});
