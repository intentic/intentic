import type { PanelSummary } from "@intentic-app/api-contract";
import type { PublicFile } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { appTargets, pickTarget, previewEvidence, previewHealthyCount, publicTarget, repoTargets, repoTargetId } from "./previewModel";

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

describe(`repoTargets`, () => {
    it(`previews a runnable repo, and leaves a monorepo to its apps`, () => {
        const targets = repoTargets([panel({}), panel({ repo: `mono`, monorepo: true }), panel({ repo: `lib`, hasPanel: false })]);
        expect(targets.map((target) => target.id)).toEqual([`repo:shop`]);
    });

    it(`names the terminal there IS — the daemon's own pane when running, else the answering server's`, () => {
        expect(repoTargets([panel({ running: true })])[0]?.session).toBe(`panel-shop`);
        expect(repoTargets([panel({ servers: [{ url: `http://127.0.0.1:3000`, session: `web-1` }] })])[0]?.session).toBe(`web-1`);
        expect(repoTargets([panel({})])[0]?.session).toBeUndefined();
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

describe(`the rail's cheap half`, () => {
    it(`has evidence for a runnable repo, a monorepo, or a served page — and none for a bare library`, () => {
        expect(previewEvidence([panel({ hasPanel: false })], [])).toBe(false);
        expect(previewEvidence([panel({})], [])).toBe(true);
        expect(previewEvidence([panel({ hasPanel: false, monorepo: true })], [])).toBe(true);
        expect(previewEvidence([], [file({})])).toBe(true);
        expect(previewEvidence([], [file({ blocked: `nope` })])).toBe(false);
    });

    it(`counts the repos actually answering`, () => {
        expect(
            previewHealthyCount([
                panel({ healthy: true }),
                panel({ repo: `mono`, monorepo: true, hasPanel: false, healthy: true }),
                panel({ repo: `idle` }),
            ]),
        ).toBe(2);
        expect(previewHealthyCount([panel({ repo: `lib`, hasPanel: false, healthy: true })])).toBe(0);
    });
});
