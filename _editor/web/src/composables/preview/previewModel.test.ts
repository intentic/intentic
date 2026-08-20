import type { PanelSummary } from "@intentic-app/api-contract";
import type { PortSummary, PublicFile } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import {
    addressTarget,
    appTargets,
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

/* The Preview area's model: what counts as previewable, and which target the panel lands on without being
 * asked. Pure functions, so the rules that decide what a new user sees first are pinned without a daemon. */

const panel = (over: Partial<PanelSummary>): PanelSummary => ({
    repo: `shop`,
    hasPanel: true,
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
    forwarded: true,
    previewUrl: `https://port-1-s.zone`,
    ...over,
});

describe(`repoTargets`, () => {
    /* A MONOREPO IS A TARGET IN ITS OWN RIGHT, and this is the regression that matters: when it wasn't, a
     * monorepo whose root `dev` runs turbo (no `_apps/` instances at all) produced a rail badge saying "1
     * running" over a panel saying there was nothing to preview. Its apps replace this row only when it has
     * any — see mergeTargets. */
    it(`previews every runnable repo, monorepos included, and skips a repo with no dev server`, () => {
        const targets = repoTargets([panel({}), panel({ repo: `mono`, monorepo: true }), panel({ repo: `lib`, hasPanel: false })]);
        expect(targets.map((target) => target.id)).toEqual([`repo:shop`, `repo:mono`]);
    });

    it(`names the terminal there IS — the daemon's own pane when running, else the answering server's`, () => {
        expect(repoTargets([panel({ running: true })])[0]?.session).toBe(`panel-shop`);
        expect(repoTargets([panel({ servers: [{ url: `http://127.0.0.1:3000`, session: `web-1` }] })])[0]?.session).toBe(`web-1`);
        expect(repoTargets([panel({})])[0]?.session).toBeUndefined();
    });

    /* The preview hostname routes to the port the DAEMON assigned this panel, so a repo answering from a
     * terminal-started server has a hostname that 502s — a target with no url, which the panel explains
     * instead of framing an error page. */
    it(`carries the preview address only while the daemon runs the panel`, () => {
        const url = `https://preview-shop-s.zone`;
        expect(repoTargets([panel({ previewUrl: url, running: true, healthy: true })])[0]?.url).toBe(url);
        expect(repoTargets([panel({ previewUrl: url, running: false, healthy: true })])[0]?.url).toBeUndefined();
    });
});

describe(`appTargets`, () => {
    it(`gives each app its own target under its repo, with the process manager's session name`, () => {
        const targets = appTargets(`mono`, [
            { app: `web`, running: true, healthy: true, previewUrl: `https://preview-mono--web-s.zone` },
            { app: `api`, running: false, healthy: false },
        ]);
        expect(targets.map((target) => target.id)).toEqual([`app:mono/web`, `app:mono/api`]);
        expect(targets[0]?.session).toBe(`panel-mono--web`);
        expect(targets[1]?.session).toBeUndefined();
    });
});

describe(`publicTarget`, () => {
    it(`is the served page — index.html first, any other served page behind it, never a blocked one`, () => {
        expect(publicTarget([])).toBeUndefined();
        expect(publicTarget([file({ path: `notes.txt` })])).toBeUndefined();
        expect(publicTarget([file({ blocked: `secret-looking name` })])).toBeUndefined();
        expect(publicTarget([file({ path: `game.html`, url: `https://s.zone/game.html` })])?.url).toBe(`https://s.zone/game.html`);
        expect(publicTarget([file({ path: `game.html` }), file({ path: `index.html`, url: `https://s.zone/` })])?.url).toBe(`https://s.zone/`);
    });
});

describe(`portTargets`, () => {
    it(`takes the forwarded ports and leaves the loopback-only ones alone`, () => {
        const targets = portTargets([port({}), port({ port: 4000, forwarded: false }), port({ port: 5000, previewUrl: undefined })]);
        expect(targets.map((target) => target.id)).toEqual([`port:3000`]);
        expect(targets[0]).toMatchObject({ label: `Port 3000`, healthy: true, startable: false });
    });

    it(`says what is answering there, from the tail of the command`, () => {
        expect(portTargets([port({ command: `node /work/app/node_modules/.bin/vite` })])[0]?.detail).toBe(`vite`);
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

/* THE BUG THIS FILE EXISTS FOR, one level up: the rail counted a monorepo and the panel dropped it, so a
 * monorepo with no `_apps/` — a root `dev` running turbo, the ordinary shape — badged "1 running" over an
 * empty screen. Both readings come from these builders now, so the two cannot disagree. */
describe(`mergeTargets`, () => {
    const monorepo = repoTargets([panel({ repo: `mono`, monorepo: true, healthy: true })]);

    it(`keeps a monorepo's own row when it has no apps`, () => {
        expect(mergeTargets(monorepo, [], [], undefined, undefined).map((target) => target.id)).toEqual([`repo:mono`]);
        expect(railTargets([panel({ repo: `mono`, monorepo: true, healthy: true })], [], []).map((target) => target.id)).toEqual([`repo:mono`]);
    });

    it(`replaces it with its apps once it has some — one row per thing, never a vague row beside precise ones`, () => {
        const apps = appTargets(`mono`, [{ app: `web`, running: true, healthy: true }]);
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
            { app: `web`, running: false, healthy: false },
            { app: `api`, running: true, healthy: false },
        ]),
        ...repoTargets([panel({ healthy: true, running: true })]),
        publicTarget([file({})])!,
    ];

    it(`honours an exact pick while it exists`, () => {
        expect(pickTarget(targets, `app:mono/web`)?.id).toBe(`app:mono/web`);
    });

    it(`lands a repo pick on that repo's first target — the tree's door names a monorepo this way`, () => {
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
    it(`has evidence for a runnable repo, a monorepo, a forwarded port or a served page — none for a bare library`, () => {
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
        // The static page is not a running thing, so it never inflates a count that says "running".
        expect(previewHealthyCount([], [], [file({})])).toBe(0);
        expect(previewHealthyCount([], [port({})], [])).toBe(1);
        expect(previewHealthyCount([panel({ repo: `lib`, hasPanel: false, healthy: true })], [], [])).toBe(0);
    });
});
