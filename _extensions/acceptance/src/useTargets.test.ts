import type { IntenticApi } from "@intentic/extension-api";
import { type PanelSummary, PanelsListSchema } from "@intentic/sandbox-contract";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, effectScope, nextTick, ref } from "vue";
import { bindHost } from "./host";
import { aimOf, useTargets } from "./useTargets";

/* THE DISTINCTION THIS SUITE EXISTS FOR: `running` means the daemon spawned the dev server's tmux session,
 * `healthy` means its port answers. The command behind a start installs dependencies first, so the gap between
 * them is routinely minutes. A surface that treats `running` as "serving" hides its Start button, reports
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

const read = async (panels: readonly PanelSummary[], remembered: Readonly<Record<string, string>> = {}): Promise<ReturnType<typeof useTargets>> => {
    bindHost(hostFor(panels));
    const app = createApp({});
    app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
    const scope = effectScope();
    const result = scope.run(() => app.runWithContext(() => useTargets(ref(remembered))));
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

        // This one's groups show an address field rather than a dot — free text is the genuine answer here.
        expect(stateOf(`docs`)).toBe(`none`);
        expect(localUrl(`docs`)).toBeUndefined();
    });

    it(`reports an unknown repo as having no dev server rather than throwing`, async () => {
        const { stateOf } = await read([]);

        expect(stateOf(`nothing-here`)).toBe(`none`);
    });

    /* One repository, two applications: a monorepo's marketing site and its web app are two ports behind one
     * `pnpm dev`, and the story GROUP is the only thing in the tree that says which is which. So the dev server
     * is shared and the addresses are not — which is what the list draws as one chip on the repo's heading and a
     * second one on the group's row. */
    it(`aims each of a repo's groups separately while they share its one dev server`, async () => {
        const targets = await read([panel({ repo: `site`, running: true, healthy: true, port: 5173 })], {
            "site/marketing": `https://staging.example.dev`,
        });

        expect(targets.addressOf(`site`, `app`)).toBe(`http://localhost:5173`);
        expect(targets.isElsewhere(`site`, `app`)).toBe(false);
        expect(targets.addressOf(`site`, `marketing`)).toBe(`https://staging.example.dev`);
        expect(targets.isElsewhere(`site`, `marketing`)).toBe(true);
    });

    it(`hands a group back to the dev server when its typed address is cleared`, async () => {
        const targets = await read([panel({ repo: `app`, running: true, healthy: true, port: 5173 })]);

        targets.aimAt(`app`, ``, `https://preview.example.dev`);
        expect(targets.addressOf(`app`, ``)).toBe(`https://preview.example.dev`);

        // Emptying the field is a real answer — nowhere — and the run says so rather than quietly re-aiming.
        targets.aimAt(`app`, ``, ``);
        expect(targets.addressOf(`app`, ``)).toBeUndefined();

        targets.aimAt(`app`, ``, undefined);
        expect(targets.addressOf(`app`, ``)).toBe(`http://localhost:5173`);
    });
});

/* WHERE A GROUP AIMS — the rule the whole surface is built on, and the one that decides whether a run is allowed
 * to spend an agent session per story. Tested against the pure function rather than through the query, because
 * every interesting case is a combination of four inputs and none of them is about HTTP. */
describe(`aimOf`, () => {
    it(`sends a group at its repo's dev server, which is what almost every group means`, () => {
        expect(aimOf({ typed: undefined, remembered: undefined, state: `ready`, localUrl: `http://localhost:5173` })).toBe(`http://localhost:5173`);
    });

    it(`offers nothing while that server is stopped or still starting — the gate the run waits on`, () => {
        expect(aimOf({ typed: undefined, remembered: undefined, state: `stopped`, localUrl: undefined })).toBeUndefined();
        expect(aimOf({ typed: undefined, remembered: undefined, state: `starting`, localUrl: undefined })).toBeUndefined();
    });

    /* THE BUG THIS RULE EXISTS TO CLOSE. The old derivation compared the remembered address against `localUrl`,
     * which is undefined precisely when the server is down — so a remembered `http://localhost:5173` "differed
     * from" nothing, was read as a deliberate elsewhere, and let a fan-out be aimed at a dead port. */
    it(`does not resurrect a remembered loopback address once its dev server has stopped`, () => {
        expect(aimOf({ typed: undefined, remembered: `http://localhost:5173`, state: `stopped`, localUrl: undefined })).toBeUndefined();
        expect(aimOf({ typed: undefined, remembered: `http://127.0.0.1:5173`, state: `starting`, localUrl: undefined })).toBeUndefined();
    });

    it(`keeps aiming a group at the elsewhere it was last run against, so it is typed once and not once per run`, () => {
        // The marketing-site case: this group is a second app, and the repo's own dev server is not it.
        expect(aimOf({ typed: undefined, remembered: `https://staging.example.dev`, state: `ready`, localUrl: `http://localhost:5173` })).toBe(
            `https://staging.example.dev`,
        );
        // And it is still the answer while that repo's dev server is down — nothing about this group needs it.
        expect(aimOf({ typed: undefined, remembered: `https://staging.example.dev`, state: `stopped`, localUrl: undefined })).toBe(
            `https://staging.example.dev`,
        );
    });

    it(`falls back to the remembered address for a repo the daemon runs nothing for`, () => {
        expect(aimOf({ typed: undefined, remembered: `http://localhost:4321`, state: `none`, localUrl: undefined })).toBe(`http://localhost:4321`);
        // With no dev server and nothing remembered there is genuinely no answer, and the run says so.
        expect(aimOf({ typed: undefined, remembered: undefined, state: `none`, localUrl: undefined })).toBeUndefined();
    });

    it(`lets a typed address win over both, and a typed blank mean blank`, () => {
        expect(
            aimOf({ typed: `  https://preview.example.dev  `, remembered: `https://old.example.dev`, state: `ready`, localUrl: `http://x:1` }),
        ).toBe(`https://preview.example.dev`);
        // An emptied field is "not there", not "surprise me" — it must not snap back to a server or a memory.
        expect(aimOf({ typed: ``, remembered: `https://staging.example.dev`, state: `ready`, localUrl: `http://localhost:5173` })).toBeUndefined();
    });
});
