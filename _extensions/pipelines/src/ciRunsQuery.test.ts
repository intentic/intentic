import type { ExtensionContext, HostQuery, IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ciRunsQuery, CI_RUNS_STALE_MS } from "./ciRunsQuery";
import { activate } from "./extension";
import { bindHost } from "./host";

const answer = { repos: [], runs: [] };

const fakeHost = (reachable = true) => {
    const paths: string[] = [];
    const views: ViewRegistration[] = [];
    const fetched: HostQuery[] = [];
    const api = {
        sandbox: {
            key: (...parts: readonly string[]) => [`sandbox`, `box`, ...parts],
            reachable: () => reachable,
            json: async (path: string) => {
                paths.push(path);
                return answer;
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
    return { api, paths, views, fetched };
};

const subscriptions: { dispose(): void }[] = [];
afterEach(() => {
    for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
    }
    vi.useRealTimers();
});

describe(`the Pipelines opening query`, () => {
    it(`uses one sandbox-scoped entry and the daemon sweep's freshness window`, async () => {
        const { api, paths } = fakeHost();
        bindHost(api);

        const query = ciRunsQuery();

        expect(query.queryKey).toEqual([`sandbox`, `box`, `ci-runs`]);
        expect(query.staleTime).toBe(CI_RUNS_STALE_MS);
        await expect(query.queryFn()).resolves.toEqual(answer);
        expect(paths).toEqual([`/ci/runs`]);
    });

    it(`opts the rail view into warming that exact query`, () => {
        vi.useFakeTimers();
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
