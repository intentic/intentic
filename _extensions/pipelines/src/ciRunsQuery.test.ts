import type { Activation, CapabilityFacts, ExtensionContext, HostQuery, IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { extensionIdOf } from "@intentic/extension-manifest";
import { ciRunsQuery, CI_RUNS_STALE_MS } from "./ciRunsQuery";
import { activate } from "./extension";
import { bindHost } from "./host";
import { messages } from "./i18n";
import { manifest } from "./manifest";

// The host registers this before it calls `activate`; a suite reading the tile's words has to mount it itself.
await registerExtensionMessages(extensionIdOf(manifest), messages);

const answer = { repos: [], runs: [] };

const fakeHost = (reachable = true) => {
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

// WHEN THE TILE EXISTS AT ALL: where a forge is connected, since CI is all it reports on.
describe(`the Pipelines tile`, () => {
    const GITHUB: CapabilityFacts = { id: `github`, kind: `cli`, config: { provider: `github` } };
    const tile: Activation = { key: `pipelines`, title: `Pipelines` };

    it(`stands for CI where a forge is connected, and not at all where none is`, () => {
        const { api, views } = fakeHost();
        const context: ExtensionContext = { extensionId: `ext-pipelines`, subscriptions };
        activate(api, context);
        const view = views[0];

        expect(view?.detect([], [GITHUB]).map((activation) => activation.key)).toEqual([`pipelines`]);
        expect(view?.detect([], [])).toEqual([]);
        expect(view?.badge?.(tile)).toBeUndefined();
        // The one read the board opens on is warmed, so it does not wait behind a spinner.
        expect(view?.warm?.().map((query) => query.queryKey)).toEqual([[`sandbox`, `box`, `ci-runs`]]);
    });
});
