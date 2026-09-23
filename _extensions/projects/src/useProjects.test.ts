import type { IntenticApi } from "@intentic/extension-api";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { expect, it, mock } from "bun:test";
import { waitFor } from "@intentic/testing/bun";
import { createApp, effectScope } from "vue";
import { bindHost } from "./host.js";
import { useProjects } from "./useProjects.js";

// The dashboard lists every repository, not the open project's, so the host's repo-set push is its only feed.
it(`re-reads the repository list when the host says the set moved, and holds no clock of its own`, async () => {
    let moved: (repos: readonly string[]) => void = () => undefined;
    const disposed = mock();
    const listRepos = mock(async () => ({ repos: [`root`, `web`] }));
    bindHost({
        sandbox: {
            key: (...parts: unknown[]) => [...parts, `sbx-1`],
            reachable: () => true,
            rpc: { workspace: { repos: listRepos } },
        },
        workspace: {
            repos: () => [],
            file: async () => undefined,
            onDidChangeRepos: (listener: (repos: readonly string[]) => void) => {
                moved = listener;
                return { dispose: disposed };
            },
        },
    } as unknown as IntenticApi);
    const app = createApp({});
    app.use(VueQueryPlugin, { queryClient: new QueryClient() });
    const scope = effectScope();
    const projects = app.runWithContext(() => scope.run(() => useProjects()));
    await waitFor(() => expect(projects?.ids.value).toEqual([`web`]));
    expect(listRepos).toHaveBeenCalledTimes(1);

    listRepos.mockResolvedValueOnce({ repos: [`root`, `web`, `cloned`] });
    moved([`root`, `web`, `cloned`]);
    await waitFor(() => expect(projects?.ids.value).toEqual([`cloned`, `web`]));
    expect(listRepos).toHaveBeenCalledTimes(2);

    scope.stop();
    expect(disposed).toHaveBeenCalledTimes(1);
});
