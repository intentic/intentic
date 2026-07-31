import type { IntenticApi } from "@intentic/extension-api";
import { type PanelSummary, PanelsListSchema } from "@intentic/sandbox-contract";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, effectScope, nextTick } from "vue";
import { bindHost } from "./host";
import { useTargets } from "./useTargets";

/* THE DISTINCTION THIS SUITE EXISTS FOR: `running` means the daemon spawned the dev server's tmux session,
 * `healthy` means its port answers. The command behind a start installs dependencies first, so the gap between
 * them is routinely minutes. A dialog that treats `running` as "serving" hides its Start button, reports
 * success, and points a fan-out of agent sessions at a socket nobody is listening on. */

// Every field the contract requires, so the parse below is a real check rather than a shape this file invented.
const panel = (over: Partial<PanelSummary> & { repo: string }): PanelSummary => ({
    hasPanel: true,
    running: false,
    healthy: false,
    deployConfig: false,
    desiredState: false,
    directoryUi: false,
    monorepo: false,
    vitest: false,
    userStories: true,
    ...over,
});

const hostFor = (panels: readonly PanelSummary[]): IntenticApi =>
    ({
        sandbox: {
            key: (...parts: readonly string[]) => [`sandbox`, ...parts],
            reachable: () => true,
            json: async (path: string) => {
                if (path !== `/panels`) {
                    throw new Error(`404 ${path}`);
                }
                return PanelsListSchema.parse({ panels });
            },
            request: async () => new Response(),
            origin: () => undefined,
        },
        workspace: { repos: () => [], capabilities: () => [], onDidChange: () => ({ dispose: () => {} }) },
    }) as unknown as IntenticApi;

const scopes: { stop: () => void }[] = [];
afterEach(() => {
    while (scopes.length > 0) {
        scopes.pop()?.stop();
    }
});

const read = async (panels: readonly PanelSummary[]): Promise<ReturnType<typeof useTargets>> => {
    bindHost(hostFor(panels));
    const app = createApp({});
    app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
    const scope = effectScope();
    const result = scope.run(() => app.runWithContext(useTargets));
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

describe(`useTargets`, () => {
    it(`reads a spawned-but-unanswering dev server as starting, and offers no address for it`, async () => {
        const { stateOf, localUrl } = await read([panel({ repo: `app`, running: true, healthy: false, port: 5173 })]);

        expect(stateOf(`app`)).toBe(`starting`);
        // The gate. A port that exists but does not answer is not somewhere to send five agent sessions.
        expect(localUrl(`app`)).toBeUndefined();
    });

    it(`offers the loopback address only once the port actually answers`, async () => {
        const { stateOf, localUrl } = await read([panel({ repo: `app`, running: true, healthy: true, port: 5173 })]);

        expect(stateOf(`app`)).toBe(`ready`);
        expect(localUrl(`app`)).toBe(`http://localhost:5173`);
    });

    it(`never falls back to the preview URL — a stopped panel answers it with a 502`, async () => {
        const stopped = await read([panel({ repo: `app`, running: false, previewUrl: `https://preview-app-abc.example.dev` })]);
        expect(stopped.stateOf(`app`)).toBe(`stopped`);
        expect(stopped.localUrl(`app`)).toBeUndefined();

        // Still booting behind the tunnel is the same 502, and the same non-answer.
        const starting = await read([panel({ repo: `app`, running: true, healthy: false, previewUrl: `https://preview-app-abc.example.dev` })]);
        expect(starting.localUrl(`app`)).toBeUndefined();
    });

    it(`reports a repo the daemon runs nothing for as having no dev server at all`, async () => {
        const { stateOf, localUrl } = await read([panel({ repo: `docs`, hasPanel: false })]);

        // The dialog opens straight onto the address field for this one — free text is the genuine answer here.
        expect(stateOf(`docs`)).toBe(`none`);
        expect(localUrl(`docs`)).toBeUndefined();
    });

    it(`reports an unknown repo as having no dev server rather than throwing`, async () => {
        const { stateOf } = await read([]);

        expect(stateOf(`nothing-here`)).toBe(`none`);
    });
});
