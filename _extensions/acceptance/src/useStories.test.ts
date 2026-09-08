import type { IntenticApi } from "@intentic/extension-api";
import { WorkspaceChildrenSchema, WorkspaceFileSchema, type WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, effectScope, nextTick } from "vue";
import { bindHost } from "./host";
import { useStories } from "./useStories";

// Pins that vue-query's useQuery subscribes synchronously, so queryFn runs before the rest of the composable body is
// evaluated; a helper declared below the query TDZs at runtime despite typechecking.

const routes = (json: Readonly<Record<string, unknown>>): IntenticApi =>
    ({
        sandbox: {
            key: (...parts: readonly string[]) => [`sandbox`, ...parts],
            reachable: () => true,
            json: async (path: string) => {
                const hit = json[path];
                if (hit === undefined) {
                    throw new Error(`404 ${path}`);
                }
                return hit;
            },
            request: async () => new Response(),
            origin: () => undefined,
        },
        workspace: {
            repos: () => [
                {
                    repo: `app`,
                    hasPanel: true,
                    installed: true,
                    userStories: true,
                    deployConfig: false,
                    desiredState: false,
                    directoryUi: false,
                    monorepo: false,
                    vitest: false,
                    docs: false,
                },
            ],
            capabilities: () => [],
            onDidChange: () => ({ dispose: () => {} }),
            // Fakes the host's file reader; absent reads as undefined rather than throwing.
            file: async (path: string) => {
                const hit = json[`/workspace/file?path=${encodeURIComponent(path)}`];
                const answer = hit === undefined ? undefined : WorkspaceFileSchema.parse(hit);
                return answer?.present === true ? answer.content : undefined;
            },
        },
    }) as unknown as IntenticApi;

// Fixtures parse through the same schemas the readers use, so a missing field fails here, not silently.
const children = (path: string, entries: readonly WorkspaceTreeEntry[]) =>
    [`/workspace/children?path=${encodeURIComponent(path)}`, WorkspaceChildrenSchema.parse({ entries, hidden: 0 })] as const;
const file = (path: string, content: string) =>
    [
        `/workspace/file?path=${encodeURIComponent(path)}`,
        WorkspaceFileSchema.parse({ present: true, path, content, size: content.length, offset: 0, bytes: content.length, shared: true }),
    ] as const;

// Runs the composable inside an app context and effect scope, like the view does; waits for `isLoading` to go false
// rather than a fixed tick count.
const run = async (api: IntenticApi): Promise<ReturnType<typeof useStories>> => {
    bindHost(api);
    const app = createApp({});
    app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
    const scope = effectScope();
    const result = scope.run(() => app.runWithContext(useStories));
    if (result === undefined) {
        throw new Error(`the composable returned nothing`);
    }
    scopes.push(scope);
    for (let tick = 0; tick < 100 && result.isLoading.value; tick += 1) {
        await nextTick();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(result.isLoading.value, `the query never settled`).toBe(false);
    return result;
};

const scopes: { stop: () => void }[] = [];
afterEach(() => {
    while (scopes.length > 0) {
        scopes.pop()?.stop();
    }
});

describe(`useStories`, () => {
    it(`reads the workspace on its first fetch, which vue-query runs inside useQuery, before the rest of the composable exists`, async () => {
        const api = routes(
            Object.fromEntries([
                children(`app/docs/user-stories`, [{ name: `01-sign-in.md`, path: `app/docs/user-stories/01-sign-in.md`, type: `file` }]),
                file(`app/docs/user-stories/01-sign-in.md`, `# Sign in with Google\n\n## Acceptance criteria\n\n- The button is on the page\n`),
            ]),
        );

        const { stories, contents, error } = await run(api);

        expect(error.value).toBeUndefined();
        expect(stories.value.map((story) => story.title)).toEqual([`Sign in with Google`]);
        expect(contents.value[`app/docs/user-stories/01-sign-in.md`]).toContain(`The button is on the page`);
    });

    it(`treats a repo with no stories directory as empty rather than an error`, async () => {
        const { stories, error } = await run(routes(Object.fromEntries([children(`app/docs/user-stories`, [])])));

        expect(error.value).toBeUndefined();
        expect(stories.value).toEqual([]);
    });

    it(`surfaces a refused workspace read instead of presenting it as an empty story list`, async () => {
        const { stories, error } = await run(routes({}));

        expect(error.value).toContain(`404 /workspace/children`);
        expect(stories.value).toEqual([]);
    });
});
