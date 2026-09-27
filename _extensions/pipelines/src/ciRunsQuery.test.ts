import type { PushChecks } from "@intentic/sandbox-contract";
import type { Activation, CapabilityFacts, ExtensionContext, HostQuery, IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { waitFor } from "@intentic/testing/bun";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { extensionIdOf } from "@intentic/extension-manifest";
import { ciRunsQuery, CI_RUNS_STALE_MS } from "./ciRunsQuery";
import { activate } from "./extension";
import { bindHost } from "./host";
import { messages } from "./i18n";
import { manifest } from "./manifest";
import { finding, owing, pushCheck } from "./testing";

// The host registers this before it calls `activate`; a suite reading the tile's words has to mount it itself.
await registerExtensionMessages(extensionIdOf(manifest), messages);

const answer = { repos: [], runs: [] };
const NOTHING_PUSHED: PushChecks = { pushed: [], reds: [] };

const fakeHost = (reachable = true, checks: PushChecks = NOTHING_PUSHED) => {
    const procedures: string[] = [];
    const views: ViewRegistration[] = [];
    const fetched: HostQuery[] = [];
    const api = {
        sandbox: {
            key: (...parts: readonly string[]) => [`sandbox`, `box`, ...parts],
            reachable: () => reachable,
            rpc: {
                ci: {
                    runs: async () => {
                        procedures.push(`ci.runs`);
                        return answer;
                    },
                },
                // What pushes left, the badge's second poll and the tile's reason to exist without a forge.
                workspace: {
                    pushChecks: async () => {
                        procedures.push(`workspace.pushChecks`);
                        return checks;
                    },
                },
            },
            fetch: async <T>(query: HostQuery<T>): Promise<T> => {
                fetched.push(query);
                return query.queryFn();
            },
        },
        views: {
            register: (view: ViewRegistration) => {
                views.push(view);
                return { dispose: () => undefined };
            },
        },
    } as unknown as IntenticApi;
    return { api, procedures, views, fetched };
};

const subscriptions: { dispose(): void }[] = [];
afterEach(() => {
    for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
    }
    jest.useRealTimers();
});

describe(`the Pipelines opening query`, () => {
    it(`uses one sandbox-scoped entry and the daemon sweep's freshness window`, async () => {
        const { api, procedures } = fakeHost();
        bindHost(api);

        const query = ciRunsQuery();

        expect(query.queryKey).toEqual([`sandbox`, `box`, `ci-runs`]);
        expect(query.staleTime).toBe(CI_RUNS_STALE_MS);
        await expect(query.queryFn()).resolves.toEqual(answer);
        expect(procedures).toEqual([`ci.runs`]);
    });

    it(`opts the rail view into warming that exact query`, () => {
        jest.useFakeTimers();
        const { api, views, fetched } = fakeHost();
        const context: ExtensionContext = { extensionId: `ext-pipelines`, subscriptions };

        activate(api, context);

        const registered = views[0];
        expect(registered?.id).toBe(`pipelines`);
        // Activation starts the badge poll, which must fill the same entry before the view is ever mounted.
        expect(fetched[0]).toMatchObject({ queryKey: [`sandbox`, `box`, `ci-runs`], staleTime: CI_RUNS_STALE_MS });
        expect(registered?.warm?.()[0]).toMatchObject({
            queryKey: [`sandbox`, `box`, `ci-runs`],
            staleTime: CI_RUNS_STALE_MS,
        });
    });
});

// WHEN THE TILE EXISTS AT ALL. It stands for CI where a forge is connected, and for what a push left where none is: the
// pre-push hook measures a push with no CI anywhere, and this board is the only place its findings wait. The badge's
// polls are module state, so the order below is the order a sandbox lives it in: nothing pushed, then a push measured.
describe(`the Pipelines tile`, () => {
    const GITHUB: CapabilityFacts = { id: `github`, kind: `cli`, config: { provider: `github` } };
    const tile: Activation = { key: `pipelines`, title: `Pipelines` };
    const activated = (checks: PushChecks): ViewRegistration | undefined => {
        const { api, views } = fakeHost(true, checks);
        const context: ExtensionContext = { extensionId: `ext-pipelines`, subscriptions };
        activate(api, context);
        return views[0];
    };

    it(`stands for CI where a forge is connected, and not at all where neither a forge nor a push is`, () => {
        const view = activated(NOTHING_PUSHED);
        expect(view?.detect([], [GITHUB]).map((activation) => activation.key)).toEqual([`pipelines`]);
        expect(view?.detect([], [])).toEqual([]);
        expect(view?.badge?.(tile)).toBeUndefined();
        // Both reads the board opens on are warmed, so neither half of it waits behind a spinner.
        expect(view?.warm?.().map((query) => query.queryKey)).toEqual([
            [`sandbox`, `box`, `ci-runs`],
            [`sandbox`, `box`, `push-checks`],
        ]);
    });

    it(`stands up with no forge connected once the hook has measured a push, and counts what it left in the quieter tone`, async () => {
        const pushed = [pushCheck(`a`, 1_000, [finding(`lint`), finding(`paths`)])];
        const view = activated({ pushed, reds: owing(pushed) });
        await waitFor(() => expect(view?.detect([], []).map((activation) => activation.key)).toEqual([`pipelines`]));
        expect(view?.badge?.(tile)).toEqual({ count: 2, tone: `warning`, tooltip: `2 findings left at push` });
    });
});
