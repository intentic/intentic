import type { IntenticApi } from "@intentic/extension-api";
import { type PanelSummary, PanelsListSchema } from "@intentic/sandbox-contract";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, effectScope, nextTick, ref } from "vue";
import { bindHost } from "./host";
import { aimOf, useTargets } from "./useTargets";

// `running` means the daemon spawned the tmux session; `servers` is what actually answered, often minutes apart. A repo
// serving several apps has no single address until each group says which one it walks.

// Every field the contract requires, so the parse below is a real check, not a shape this file invented.
const panel = (over: Partial<PanelSummary> & { repo: string }): PanelSummary => ({
    hasPanel: true,
    installed: true,
    running: false,
    healthy: false,
    servers: [],
    deployConfig: false,
    desiredState: false,
    directoryUi: false,
    monorepo: false,
    vitest: false,
    userStories: true,
    docs: false,
    ...over,
});

// Three sessions: one daemon-started, one from outside this sandbox, one launched by hand in a terminal.
const MONOREPO = [
    { port: 47145, url: `https://localhost:47145`, dir: `_editor/web`, session: `panel-intentic` },
    { port: 6480, url: `https://localhost:6480`, dir: `_platform/api` },
    { port: 4321, url: `http://localhost:4321`, dir: `_site/site`, session: `web-3f2a` },
];

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
        expect(localUrl(`app`)).toBeUndefined();
    });

    it(`offers the loopback address only once something actually answers`, async () => {
        const { stateOf, localUrl } = await read([
            panel({ repo: `app`, running: true, healthy: true, port: 5173, servers: [{ port: 5173, url: `http://localhost:5173` }] }),
        ]);

        expect(stateOf(`app`)).toBe(`ready`);
        expect(localUrl(`app`)).toBe(`http://localhost:5173`);
    });

    it(`takes the address from what is serving, not from the port the daemon handed out`, async () => {
        const { stateOf, localUrl } = await read([
            panel({
                repo: `app`,
                running: true,
                healthy: true,
                port: 39481,
                servers: [{ port: 47145, url: `https://localhost:47145`, dir: `_editor/web` }],
            }),
        ]);

        expect(stateOf(`app`)).toBe(`ready`);
        expect(localUrl(`app`)).toBe(`https://localhost:47145`);
    });

    it(`counts a dev server the daemon never spawned as ready`, async () => {
        const { stateOf, localUrl } = await read([panel({ repo: `app`, running: false, servers: [{ port: 5173, url: `http://localhost:5173` }] })]);

        expect(stateOf(`app`)).toBe(`ready`);
        expect(localUrl(`app`)).toBe(`http://localhost:5173`);
    });

    it(`opens the terminal a lone dev server is actually served from, and offers none when it has one`, async () => {
        const byHand = await read([
            panel({ repo: `app`, running: false, servers: [{ port: 5173, url: `http://localhost:5173`, session: `web-3f2a` }] }),
        ]);
        expect(byHand.terminalOf(`app`)).toBe(`web-3f2a`);

        // No `session`: answered from outside this sandbox's terminals.
        const outside = await read([panel({ repo: `app`, running: false, servers: [{ port: 5173, url: `http://localhost:5173` }] })]);
        expect(outside.stateOf(`app`)).toBe(`ready`);
        expect(outside.terminalOf(`app`)).toBeUndefined();

        // Multiple servers have no single terminal; each row carries its own.
        const monorepo = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: MONOREPO })]);
        expect(monorepo.terminalOf(`intentic`)).toBeUndefined();
        expect(monorepo.serversOf(`intentic`).map((server) => server.session)).toEqual([`panel-intentic`, undefined, `web-3f2a`]);
    });

    it(`never falls back to the preview URL: a stopped panel answers it with a 502`, async () => {
        const stopped = await read([panel({ repo: `app`, running: false, previewUrl: `https://preview-app-abc.example.dev` })]);
        expect(stopped.stateOf(`app`)).toBe(`stopped`);
        expect(stopped.localUrl(`app`)).toBeUndefined();

        // Same non-answer while starting: the tunnel still returns a 502.
        const starting = await read([panel({ repo: `app`, running: true, healthy: false, previewUrl: `https://preview-app-abc.example.dev` })]);
        expect(starting.localUrl(`app`)).toBeUndefined();
    });

    it(`gives a repo serving several apps no repo-level address, and lets each group pick one`, async () => {
        const targets = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: MONOREPO })]);

        expect(targets.stateOf(`intentic`)).toBe(`ready`);
        expect(targets.serversOf(`intentic`)).toHaveLength(3);
        expect(targets.localUrl(`intentic`)).toBeUndefined();
        expect(targets.addressOf(`intentic`, `01-arrive`)).toBeUndefined();

        targets.aimAt(`intentic`, `01-arrive`, `http://localhost:4321`);
        targets.aimAt(`intentic`, `02-setup`, `https://localhost:47145`);
        expect(targets.addressOf(`intentic`, `01-arrive`)).toBe(`http://localhost:4321`);
        expect(targets.addressOf(`intentic`, `02-setup`)).toBe(`https://localhost:47145`);
    });

    // `remembered` rides the run manifests; a loopback memory still among the repo's live servers counts as a pick, not
    // the stale port the gate blocks.
    it(`keeps a group aimed at the app it was last run against, across a restart of the dev server`, async () => {
        const targets = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: MONOREPO })], {
            "intentic/01-arrive": `http://localhost:4321`,
        });

        expect(targets.addressOf(`intentic`, `01-arrive`)).toBe(`http://localhost:4321`);
        // Drops the remembered port from the servers list: a dead socket, not a pick.
        const moved = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: [MONOREPO[0]!, MONOREPO[1]!] })], {
            "intentic/01-arrive": `http://localhost:4321`,
        });
        expect(moved.addressOf(`intentic`, `01-arrive`)).toBeUndefined();
    });

    it(`refuses to hand a group the one app that happens to be up while the rest of the repo boots`, async () => {
        const booting = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: [MONOREPO[0]!] })]);

        expect(booting.stateOf(`intentic`)).toBe(`ready`);
        expect(booting.addressOf(`intentic`, `01-arrive`)).toBeUndefined();
        expect(booting.needsAddress(`intentic`, `01-arrive`)).toBe(true);

        const up = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: MONOREPO })]);
        up.aimAt(`intentic`, `01-arrive`, `http://localhost:4321`);
        expect(up.addressOf(`intentic`, `01-arrive`)).toBe(`http://localhost:4321`);
    });

    it(`reports a repo the daemon runs nothing for as having no dev server at all`, async () => {
        const { stateOf, localUrl } = await read([panel({ repo: `docs`, hasPanel: false })]);

        expect(stateOf(`docs`)).toBe(`none`);
        expect(localUrl(`docs`)).toBeUndefined();
    });

    it(`reports an unknown repo as having no dev server rather than throwing`, async () => {
        const { stateOf } = await read([]);

        expect(stateOf(`nothing-here`)).toBe(`none`);
    });

    it(`aims each of a repo's groups separately while they share its one dev server`, async () => {
        const targets = await read([panel({ repo: `site`, running: true, healthy: true, servers: [{ port: 5173, url: `http://localhost:5173` }] })], {
            "site/marketing": `https://staging.example.dev`,
        });

        expect(targets.addressOf(`site`, `app`)).toBe(`http://localhost:5173`);
        expect(targets.isElsewhere(`site`, `app`)).toBe(false);
        expect(targets.addressOf(`site`, `marketing`)).toBe(`https://staging.example.dev`);
        expect(targets.isElsewhere(`site`, `marketing`)).toBe(true);
    });

    it(`tells a group serving several apps that it needs an address, and stops once it has one`, async () => {
        const targets = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: MONOREPO })]);

        expect(targets.needsAddress(`intentic`, `01-arrive`)).toBe(true);
        targets.aimAt(`intentic`, `01-arrive`, `http://localhost:4321`);
        expect(targets.needsAddress(`intentic`, `01-arrive`)).toBe(false);
    });

    it(`says nothing about a group whose repo is merely stopped or still starting`, async () => {
        const stopped = await read([panel({ repo: `app`, running: false })]);
        expect(stopped.needsAddress(`app`, `checkout`)).toBe(false);

        const starting = await read([panel({ repo: `app`, running: true, healthy: false, port: 5173 })]);
        expect(starting.needsAddress(`app`, `checkout`)).toBe(false);
    });

    it(`asks for an address on a repo with no dev server, until one is remembered`, async () => {
        const bare = await read([panel({ repo: `docs`, hasPanel: false })]);
        expect(bare.needsAddress(`docs`, `guides`)).toBe(true);

        const known = await read([panel({ repo: `docs`, hasPanel: false })], { "docs/guides": `https://staging.example.dev` });
        expect(known.needsAddress(`docs`, `guides`)).toBe(false);
    });

    it(`asks for nothing while the repo's own dev server answers for the group`, async () => {
        const targets = await read([panel({ repo: `app`, running: true, healthy: true, servers: [{ port: 5173, url: `http://localhost:5173` }] })]);

        expect(targets.needsAddress(`app`, `checkout`)).toBe(false);
    });

    it(`hands a group back to the dev server when its typed address is cleared`, async () => {
        const targets = await read([panel({ repo: `app`, running: true, healthy: true, servers: [{ port: 5173, url: `http://localhost:5173` }] })]);

        targets.aimAt(`app`, ``, `https://preview.example.dev`);
        expect(targets.addressOf(`app`, ``)).toBe(`https://preview.example.dev`);

        // Empty string means nowhere, deliberately; only `undefined` falls back to the dev server.
        targets.aimAt(`app`, ``, ``);
        expect(targets.addressOf(`app`, ``)).toBeUndefined();

        targets.aimAt(`app`, ``, undefined);
        expect(targets.addressOf(`app`, ``)).toBe(`http://localhost:5173`);
    });
});

// Tests `aimOf` directly, not the composable: every case here combines its four inputs, not an HTTP concern.
describe(`aimOf`, () => {
    // No `dir`: bound at the repo root, so this address is the repo's, not one app's.
    const ONE = [{ port: 5173, url: `http://localhost:5173` }];
    const THREE = MONOREPO;
    // MONOREPO mid-boot: only the first app is up; still not an answer to which app.
    const ONE_OF_THREE = [MONOREPO[0]!];

    it(`sends a group at its repo's dev server, which is what almost every group means`, () => {
        expect(aimOf({ typed: undefined, remembered: undefined, state: `ready`, servers: ONE })).toBe(`http://localhost:5173`);
    });

    it(`offers nothing while that server is stopped or still starting: the gate the run waits on`, () => {
        expect(aimOf({ typed: undefined, remembered: undefined, state: `stopped`, servers: [] })).toBeUndefined();
        expect(aimOf({ typed: undefined, remembered: undefined, state: `starting`, servers: [] })).toBeUndefined();
    });

    it(`refuses to choose for a repo serving several apps, however plainly up it is`, () => {
        expect(aimOf({ typed: undefined, remembered: undefined, state: `ready`, servers: THREE })).toBeUndefined();
    });

    // A server bound at the repo root (`dir` absent) answers for every group; a package-bound server is one app, never
    // the answer to which app.
    it(`refuses the one app that is up while its siblings are still compiling`, () => {
        expect(aimOf({ typed: undefined, remembered: undefined, state: `ready`, servers: ONE_OF_THREE })).toBeUndefined();
        // Contrast: no `dir` here, so the group inherits it without asking.
        expect(aimOf({ typed: undefined, remembered: undefined, state: `ready`, servers: ONE })).toBe(`http://localhost:5173`);
    });

    it(`does not resurrect a remembered loopback address once its dev server has stopped`, () => {
        expect(aimOf({ typed: undefined, remembered: `http://localhost:5173`, state: `stopped`, servers: [] })).toBeUndefined();
        expect(aimOf({ typed: undefined, remembered: `http://127.0.0.1:5173`, state: `starting`, servers: [] })).toBeUndefined();
    });

    it(`keeps a remembered loopback address while it is still one of the repo's servers`, () => {
        expect(aimOf({ typed: undefined, remembered: `http://localhost:4321`, state: `ready`, servers: THREE })).toBe(`http://localhost:4321`);
        // Single dev server: no other app it could be, so the fallback is safe.
        expect(aimOf({ typed: undefined, remembered: `http://localhost:5199`, state: `ready`, servers: ONE })).toBe(`http://localhost:5173`);
    });

    // A group aimed once is never re-aimed by the repo; with the remembered app gone, the honest answer is to ask, not
    // a sibling.
    it(`never substitutes a sibling app for a group's remembered address`, () => {
        expect(aimOf({ typed: undefined, remembered: `http://localhost:4321`, state: `ready`, servers: ONE_OF_THREE })).toBeUndefined();
        expect(
            aimOf({ typed: undefined, remembered: `http://localhost:4321`, state: `ready`, servers: [MONOREPO[0]!, MONOREPO[1]!] }),
        ).toBeUndefined();
    });

    it(`keeps aiming a group at the elsewhere it was last run against, so it is typed once and not once per run`, () => {
        // A second app: the repo's dev server does not serve it, so the remembered address wins.
        expect(aimOf({ typed: undefined, remembered: `https://staging.example.dev`, state: `ready`, servers: ONE })).toBe(
            `https://staging.example.dev`,
        );
        // Still the answer while the dev server is down; this group never depended on it.
        expect(aimOf({ typed: undefined, remembered: `https://staging.example.dev`, state: `stopped`, servers: [] })).toBe(
            `https://staging.example.dev`,
        );
    });

    it(`falls back to the remembered address for a repo the daemon runs nothing for`, () => {
        expect(aimOf({ typed: undefined, remembered: `http://localhost:4321`, state: `none`, servers: [] })).toBe(`http://localhost:4321`);
        expect(aimOf({ typed: undefined, remembered: undefined, state: `none`, servers: [] })).toBeUndefined();
    });

    it(`lets a typed address win over both, and a typed blank mean blank`, () => {
        expect(aimOf({ typed: `  https://preview.example.dev  `, remembered: `https://old.example.dev`, state: `ready`, servers: ONE })).toBe(
            `https://preview.example.dev`,
        );
        // Typed empty string means nothing, deliberately; it must not fall back to remembered or the server.
        expect(aimOf({ typed: ``, remembered: `https://staging.example.dev`, state: `ready`, servers: ONE })).toBeUndefined();
    });
});
