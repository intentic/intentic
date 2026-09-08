import type { PanelSummary } from "@intentic/api-contract";
import type { PortSummary, PublicFile } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import {
    addressTarget,
    appTargets,
    frameSandbox,
    mergeTargets,
    pickTarget,
    portTargets,
    previewEvidence,
    previewHealthyCount,
    publicTarget,
    railTargets,
    repoTargets,
    repoTargetId,
} from "./previewModel";

// Preview model: what counts as previewable and which target the panel lands on unasked. Pure functions, pinned without
// a daemon.

const panel = (over: Partial<PanelSummary>): PanelSummary => ({
    repo: `shop`,
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
    userStories: false,
    docs: false,
    ...over,
});

const file = (over: Partial<PublicFile>): PublicFile => ({ path: `index.html`, size: 10, modifiedAt: 0, url: `https://s.zone/`, ...over });

const port = (over: Partial<PortSummary>): PortSummary => ({
    port: 3000,
    host: `127.0.0.1`,
    forwardable: true,
    kind: `workspace`,
    // Row's label/purpose/origin: daemon-resolved in reality; the rail just counts and links, so any values do here.
    title: `Vite dev server`,
    purpose: `Started in one of your terminals.`,
    origin: `terminal`,
    forwarded: true,
    previewUrl: `https://port-1-s.zone`,
    ...over,
});

describe(`repoTargets`, () => {
    it(`previews every runnable repo, monorepos included, and skips a repo with no dev server`, () => {
        const targets = repoTargets([panel({}), panel({ repo: `mono`, monorepo: true }), panel({ repo: `lib`, hasPanel: false })]);
        expect(targets.map((target) => target.id)).toEqual([`repo:shop`, `repo:mono`]);
    });

    it(`names the terminal there IS: the daemon's own pane when running, else the answering server's`, () => {
        expect(repoTargets([panel({ running: true })])[0]?.session).toBe(`panel-shop`);
        expect(repoTargets([panel({ servers: [{ port: 3000, url: `http://127.0.0.1:3000`, session: `web-1` }] })])[0]?.session).toBe(`web-1`);
        expect(repoTargets([panel({})])[0]?.session).toBeUndefined();
    });

    it(`carries the preview address exactly as the daemon advertises it`, () => {
        const url = `https://preview-shop-s.zone`;
        expect(repoTargets([panel({ previewUrl: url, running: true, healthy: true })])[0]?.url).toBe(url);
        expect(repoTargets([panel({ previewUrl: url, running: false, healthy: true })])[0]?.url).toBe(url);
        expect(repoTargets([panel({ running: true, healthy: true })])[0]?.url).toBeUndefined();
    });

    it(`carries the repo's answering servers, so the panel can name them instead of framing nothing`, () => {
        const servers = [
            { port: 4321, url: `http://localhost:4321`, dir: `_site/site` },
            { port: 47145, url: `http://localhost:47145`, dir: `_editor/web` },
        ];
        expect(repoTargets([panel({ servers, healthy: true, running: true })])[0]?.servers).toEqual(servers);
        expect(repoTargets([panel({})])[0]?.servers).toEqual([]);
    });

    it(`offers Start only for a repo that has a dev server to start`, () => {
        expect(repoTargets([panel({})])[0]?.startable).toBe(true);
        expect(repoTargets([panel({ repo: `mono`, monorepo: true, hasPanel: false })])[0]?.startable).toBe(false);
    });
});

describe(`appTargets`, () => {
    it(`gives each app its own target under its repo, with the process manager's session name`, () => {
        const targets = appTargets(`mono`, [
            { app: `web`, running: true, healthy: true, installed: true, previewUrl: `https://preview-mono--web-s.zone` },
            { app: `api`, running: false, healthy: false, installed: true },
        ]);
        expect(targets.map((target) => target.id)).toEqual([`app:mono/web`, `app:mono/api`]);
        expect(targets[0]?.session).toBe(`panel-mono--web`);
        expect(targets[1]?.session).toBeUndefined();
    });
});

describe(`publicTarget`, () => {
    it(`is the served page: index.html first, any other served page behind it, never a blocked one`, () => {
        expect(publicTarget([])).toBeUndefined();
        expect(publicTarget([file({ path: `notes.txt` })])).toBeUndefined();
        expect(publicTarget([file({ blocked: `secret-looking name` })])).toBeUndefined();
        expect(publicTarget([file({ path: `game.html`, url: `https://s.zone/game.html` })])?.url).toBe(`https://s.zone/game.html`);
        expect(publicTarget([file({ path: `game.html` }), file({ path: `index.html`, url: `https://s.zone/` })])?.url).toBe(`https://s.zone/`);
    });
});

describe(`frameSandbox`, () => {
    it(`leaves a real server its own origin, and keeps the agent-written outbox page without one`, () => {
        expect(frameSandbox(`repo`)).toBeUndefined();
        expect(frameSandbox(`app`)).toBeUndefined();
        expect(frameSandbox(`port`)).toBeUndefined();
        expect(frameSandbox(`address`)).toBeUndefined();
        expect(frameSandbox(`public`)).toContain(`allow-scripts`);
        expect(frameSandbox(`public`)).not.toContain(`allow-same-origin`);
    });
});

describe(`portTargets`, () => {
    it(`takes the forwarded ports and leaves the loopback-only ones alone`, () => {
        const targets = portTargets([port({}), port({ port: 4000, forwarded: false }), port({ port: 5000, previewUrl: undefined })]);
        expect(targets.map((target) => target.id)).toEqual([`port:3000`]);
        expect(targets[0]).toMatchObject({ label: `Port 3000`, healthy: true, startable: false });
    });

    it(`says what is answering there, by the name the daemon resolved for it`, () => {
        expect(portTargets([port({ title: `Vite dev server` })])[0]?.detail).toBe(`Vite dev server`);
    });
});

describe(`addressTarget`, () => {
    it(`takes a bare host as https, keeps an explicit scheme, and refuses what is not an address`, () => {
        expect(addressTarget(`example.dev`)?.url).toBe(`https://example.dev/`);
        expect(addressTarget(` http://localhost:3000/app `)?.url).toBe(`http://localhost:3000/app`);
        expect(addressTarget(`example.dev/pricing`)?.detail).toBe(`/pricing`);
        expect(addressTarget(undefined)).toBeUndefined();
        expect(addressTarget(`   `)).toBeUndefined();
        expect(addressTarget(`javascript:alert(1)`)).toBeUndefined();
    });
});

describe(`mergeTargets`, () => {
    const monorepo = repoTargets([panel({ repo: `mono`, monorepo: true, healthy: true })]);

    it(`keeps a monorepo's own row when it has no apps`, () => {
        expect(mergeTargets(monorepo, [], [], undefined, undefined).map((target) => target.id)).toEqual([`repo:mono`]);
        expect(railTargets([panel({ repo: `mono`, monorepo: true, healthy: true })], [], []).map((target) => target.id)).toEqual([`repo:mono`]);
    });

    it(`replaces it with its apps once it has some: one row per thing, never a vague row beside precise ones`, () => {
        const apps = appTargets(`mono`, [{ app: `web`, running: true, healthy: true, installed: true }]);
        expect(mergeTargets(monorepo, apps, [], undefined, undefined).map((target) => target.id)).toEqual([`app:mono/web`]);
    });

    it(`orders the workspace's own rows after the repos, address last`, () => {
        const merged = mergeTargets(monorepo, [], portTargets([port({})]), publicTarget([file({})]), addressTarget(`example.dev`));
        expect(merged.map((target) => target.id)).toEqual([`repo:mono`, `port:3000`, `public`, `address`]);
    });
});

describe(`pickTarget`, () => {
    const targets = [
        ...appTargets(`mono`, [
            { app: `web`, running: false, healthy: false, installed: true },
            { app: `api`, running: true, healthy: false, installed: true },
        ]),
        ...repoTargets([panel({ healthy: true, running: true })]),
        publicTarget([file({})])!,
    ];

    it(`honours an exact pick while it exists`, () => {
        expect(pickTarget(targets, `app:mono/web`)?.id).toBe(`app:mono/web`);
    });

    it(`lands a repo pick on that repo's first target: the tree's door names a monorepo this way`, () => {
        expect(pickTarget(targets, repoTargetId(`mono`))?.id).toBe(`app:mono/web`);
    });

    it(`falls back on the best evidence: healthy, then running, then startable, then the public page`, () => {
        expect(pickTarget(targets, undefined)?.id).toBe(`repo:shop`);
        expect(pickTarget(targets, `repo:gone`)?.id).toBe(`repo:shop`);
        const noHealthy = targets.filter((target) => !target.healthy || target.kind === `public`);
        expect(pickTarget(noHealthy, undefined)?.id).toBe(`app:mono/api`);
        const nothingUp = targets.filter((target) => !target.healthy && !target.running);
        expect(pickTarget(nothingUp, undefined)?.id).toBe(`app:mono/web`);
        expect(pickTarget([publicTarget([file({})])!], undefined)?.id).toBe(`public`);
        expect(pickTarget([], undefined)).toBeUndefined();
    });
});

describe(`the rail's half`, () => {
    it(`has evidence for a runnable repo, a monorepo, a forwarded port or a served page: none for a bare library`, () => {
        expect(previewEvidence([panel({ hasPanel: false })], [], [])).toBe(false);
        expect(previewEvidence([panel({})], [], [])).toBe(true);
        expect(previewEvidence([panel({ hasPanel: false, monorepo: true })], [], [])).toBe(true);
        expect(previewEvidence([], [port({})], [])).toBe(true);
        expect(previewEvidence([], [port({ forwarded: false })], [])).toBe(false);
        expect(previewEvidence([], [], [file({})])).toBe(true);
        expect(previewEvidence([], [], [file({ blocked: `nope` })])).toBe(false);
    });

    it(`counts what is actually answering`, () => {
        expect(
            previewHealthyCount(
                [panel({ healthy: true }), panel({ repo: `mono`, monorepo: true, hasPanel: false, healthy: true }), panel({ repo: `idle` })],
                [],
                [],
            ),
        ).toBe(2);
        expect(previewHealthyCount([], [], [file({})])).toBe(0);
        expect(previewHealthyCount([], [port({})], [])).toBe(1);
        expect(previewHealthyCount([panel({ repo: `lib`, hasPanel: false, healthy: true })], [], [])).toBe(0);
    });
});
