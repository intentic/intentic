import type { IntenticApi } from "@intentic/extension-api";
import { AgentsListSchema, StartedTurnSchema, WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, effectScope, nextTick } from "vue";
import { bindHost } from "./host";
import { parseManifest, runManifestPath } from "./runs";
import type { Story } from "./stories";
import { useRuns } from "./useRuns";

const story = (slug: string): Story => ({
    repo: `app`,
    path: `app/docs/user-stories/${slug}.md`,
    slug,
    title: slug,
    group: ``,
});

interface Harness {
    api: IntenticApi;
    readonly files: Map<string, string>;
    readonly turns: { readonly conversationId: string; readonly prompt: string }[];
    fail: string | undefined;
}

const harness = (stories: Readonly<Record<string, string>>): Harness => {
    const files = new Map(Object.entries(stories));
    const turns: { conversationId: string; prompt: string }[] = [];
    const state: Harness = {
        files,
        turns,
        fail: undefined,
        api: undefined as unknown as IntenticApi,
    };
    state.api = {
        sandbox: {
            key: (...parts: readonly string[]) => [`sandbox`, ...parts],
            reachable: () => true,
            json: async (path: string, init?: RequestInit) => {
                if (path.startsWith(`/workspace/children`)) {
                    const entries = [...files.keys()]
                        .filter((file) => file.endsWith(`/run.json`))
                        .map((file) => {
                            const dir = file.slice(0, -`/run.json`.length);
                            return { name: dir.split(`/`).at(-1) ?? dir, path: dir, type: `dir` as const };
                        });
                    return WorkspaceChildrenSchema.parse({ entries, hidden: 0 });
                }
                if (path === `/agents`) {
                    return AgentsListSchema.parse({ agents: [] });
                }
                if (path === `/agent` && init?.method === `POST`) {
                    const body = JSON.parse(String(init.body)) as { conversationId: string; prompt: string };
                    turns.push(body);
                    if (state.fail !== undefined && body.conversationId.endsWith(`-${state.fail}`)) {
                        throw new Error(`provider refused ${body.conversationId}`);
                    }
                    return StartedTurnSchema.parse({ run: `started` });
                }
                throw new Error(`404 ${path}`);
            },
            request: async () => new Response(),
            origin: () => undefined,
        },
        workspace: {
            repos: () => [],
            capabilities: () => [],
            onDidChange: () => ({ dispose: () => {} }),
            file: async (path: string) => files.get(path),
            write: async (path: string, content: string) => {
                files.set(path, content);
            },
        },
    } as unknown as IntenticApi;
    return state;
};

const scopes: { stop: () => void }[] = [];
afterEach(() => {
    while (scopes.length > 0) {
        scopes.pop()?.stop();
    }
});

const run = async (api: IntenticApi): Promise<ReturnType<typeof useRuns>> => {
    bindHost(api);
    const app = createApp({});
    app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
    const scope = effectScope();
    const result = scope.run(() => app.runWithContext(useRuns));
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

const input = (stories: readonly Story[]) => ({
    stories,
    targets: { app: `http://localhost:5173` },
    notes: { app: `Use the demo account` },
    provider: `claude`,
    model: `claude-sonnet-4-5`,
});

describe(`useRuns`, () => {
    it(`reads every selected story at launch and records the exact text handed to the agent`, async () => {
        const login = story(`login`);
        const content = `# Sign in\n\n## Acceptance criteria\n\n- The user signs in\n`;
        const test = harness({ [login.path]: content });
        const runs = await run(test.api);

        const runId = await runs.start(input([login]));
        const manifest = parseManifest(test.files.get(runManifestPath(runId)) ?? ``);

        expect(manifest?.stories[0]).toMatchObject({ title: `Sign in`, content, criteria: [`The user signs in`] });
        expect(manifest?.notes).toEqual({ app: `Use the demo account` });
        expect(test.turns[0]?.prompt).toContain(content.trim());
    });

    it(`refuses before writing a manifest or spending a turn when selected story text cannot be read`, async () => {
        const test = harness({});
        const runs = await run(test.api);

        await expect(runs.start(input([story(`missing`)]))).rejects.toThrow(/app\/docs\/user-stories\/missing\.md/);
        expect([...test.files.keys()].some((path) => path.endsWith(`/run.json`))).toBe(false);
        expect(test.turns).toEqual([]);
    });

    it(`keeps successful sessions, records refused ones, and retries only the missing session`, async () => {
        const login = story(`login`);
        const checkout = story(`checkout`);
        const test = harness({ [login.path]: `# login`, [checkout.path]: `# checkout` });
        const runs = await run(test.api);
        test.fail = `checkout`;

        const runId = await runs.start(input([login, checkout]));
        const failed = parseManifest(test.files.get(runManifestPath(runId)) ?? ``);
        expect(failed?.launchFailures[`checkout`]).toContain(`provider refused`);
        expect(test.turns).toHaveLength(2);

        test.fail = undefined;
        await runs.retry(runId, `checkout`);
        const recovered = parseManifest(test.files.get(runManifestPath(runId)) ?? ``);
        expect(recovered?.launchFailures).toEqual({});
        expect(test.turns).toHaveLength(3);
        expect(test.turns[2]?.conversationId).toBe(failed?.stories.find((entry) => entry.slug === `checkout`)?.conversationId);
        expect(test.turns[2]?.prompt).toContain(`Base URL: http://localhost:5173`);
        expect(test.turns[2]?.prompt).toContain(`Use the demo account`);
    });
});
