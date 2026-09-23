// Pins the recommended-setup walk: its queue (recommended tiles nothing is connected on, derived, never snapshotted),
// the tile after the one on screen, where a finished or skipped tile goes, and "Not needed" moving on only once the
// daemon took it.
import type { CapabilityRecommendation, CapabilitySummary } from "@intentic/api-contract";
import type { CapabilityCatalogEntry, CapabilityCategory } from "@intentic/capability-catalog";
import type { NoticeModel } from "@intentic/ui";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { effectScope, type EffectScope, ref } from "vue";
import type { PageMove } from "./capabilityRoute";
import { catalogTiles } from "./model/slices";
import { nextAfter, setupQueue, useSetupWalk } from "./setupWalk";

const entry = (id: string, category: CapabilityCategory = `code`): CapabilityCatalogEntry => ({
    id,
    name: id,
    kind: `cli`,
    category,
    description: `${id} as agent tools.`,
    fields: [{ key: `provider`, label: ``, value: id }],
});
const asked = (tile: string): CapabilityRecommendation => ({ entry: tile, evidence: `.gitlab-ci.yml`, reason: `your code asks for it`, prefill: {} });
const connection = (id: string): CapabilitySummary => ({ id, kind: `cli`, status: { state: `active` }, config: { provider: id }, secrets: [] });

const GITLAB = entry(`gitlab`);
const SENTRY = entry(`sentry`, `observability`);
const DOCKERHUB = entry(`dockerhub`, `deploy`);
const GITHUB = entry(`github`);
// Three recommended tiles, one of them already connected, and one nobody asked for.
const RECOMMENDED = new Set([`gitlab`, `sentry`, `dockerhub`, `github`]);
const tilesWith = (connected: readonly CapabilitySummary[]) =>
    catalogTiles([GITHUB, GITLAB, SENTRY, DOCKERHUB, entry(`jira`)], connected, (tile) => (RECOMMENDED.has(tile) ? asked(tile) : undefined));

describe(`the queue`, () => {
    it(`holds the recommended tiles nothing is connected on, in catalog order`, () => {
        expect(setupQueue(tilesWith([connection(`github`)])).map((queued) => queued.id)).toEqual([`gitlab`, `sentry`, `dockerhub`]);
    });

    it(`follows a tile with the next one, and a tile no longer queued with the head`, () => {
        const queue = [GITLAB, SENTRY, DOCKERHUB];
        const cases: [CapabilityCatalogEntry, string | undefined][] = [
            [GITLAB, `sentry`],
            [SENTRY, `dockerhub`],
            [DOCKERHUB, undefined],
            [GITHUB, `gitlab`],
        ];
        for (const [from, next] of cases) {
            expect(nextAfter(queue, from)).toBe(next);
        }
        expect(nextAfter([], GITLAB)).toBeUndefined();
    });
});

const scopes: EffectScope[] = [];
afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

const walkOn = (on: CapabilityCatalogEntry | undefined, walking: boolean) => {
    const state = {
        tiles: ref(tilesWith([connection(`github`)])),
        selected: ref(on),
        walking: ref(walking),
        move: mock<(move: PageMove) => void>(),
        dismissRecommendation: { mutateAsync: mock<(entry: string) => Promise<unknown>>(async () => undefined) },
        error: ref<NoticeModel | null>(null),
    };
    const scope = effectScope();
    scopes.push(scope);
    return { state, walk: scope.run(() => useSetupWalk(state))! };
};

describe(`walking`, () => {
    it(`starts at the queue's head, and has nowhere to start once it is empty`, () => {
        const { state, walk } = walkOn(undefined, false);
        expect(walk.walkQueue.value.map((queued) => queued.id)).toEqual([`gitlab`, `sentry`, `dockerhub`]);

        walk.startSetup();
        state.tiles.value = tilesWith([connection(`github`), connection(`gitlab`), connection(`sentry`), connection(`dockerhub`)]);
        walk.startSetup();
        expect(state.move.mock.calls).toEqual([[{ kind: `walk`, entry: `gitlab` }]]);
    });

    it(`skips to the next tile, and out of the walk after the last`, () => {
        const { state, walk } = walkOn(SENTRY, true);

        walk.skip();
        state.selected.value = DOCKERHUB;
        walk.skip();
        expect(state.move.mock.calls).toEqual([[{ kind: `tile`, entry: `dockerhub` }], [{ kind: `finish` }]]);
    });

    it(`sends a finished tile onward inside the walk, and back to its slice outside it`, () => {
        const inside = walkOn(GITLAB, true);
        expect(inside.walk.onwardFrom(GITLAB)).toBe(`sentry`);
        inside.walk.leaveTile(`sentry`);
        inside.walk.leaveTile(undefined);
        expect(inside.state.move.mock.calls).toEqual([[{ kind: `tile`, entry: `sentry` }], [{ kind: `finish` }]]);

        const outside = walkOn(GITLAB, false);
        expect(outside.walk.onwardFrom(GITLAB)).toBeUndefined();
        outside.walk.leaveTile(undefined);
        expect(outside.state.move.mock.calls).toEqual([[{ kind: `back` }]]);
    });
});

describe(`"Not needed"`, () => {
    it(`quiets the suggestion, then moves on to the tile that followed it before it left the queue`, async () => {
        const { state, walk } = walkOn(GITLAB, true);
        state.error.value = { tone: `danger`, title: `an older failure` };
        state.dismissRecommendation.mutateAsync.mockImplementation(async () => {
            // The daemon's answer drops the tile from the queue before the walk moves.
            state.tiles.value = tilesWith([connection(`github`), connection(`gitlab`)]);
        });

        await walk.dismiss(GITLAB);

        expect(state.dismissRecommendation.mutateAsync.mock.calls).toEqual([[`gitlab`]]);
        expect(state.error.value).toBeNull();
        expect(state.move.mock.calls).toEqual([[{ kind: `tile`, entry: `sentry` }]]);
    });

    it(`stays on the tile and says why when the daemon refuses`, async () => {
        const { state, walk } = walkOn(GITLAB, true);
        state.dismissRecommendation.mutateAsync.mockRejectedValueOnce(new Error(`the scan is still running`));

        await walk.dismiss(GITLAB);

        expect(state.error.value).toEqual({ tone: `danger`, title: `Could not dismiss that suggestion.`, detail: `the scan is still running` });
        expect(state.move.mock.calls).toEqual([]);
    });
});
