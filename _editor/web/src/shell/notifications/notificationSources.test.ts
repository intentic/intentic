//
// Needs jsdom: this file's import chain reaches the app's theme, which touches the document as it loads.
import "@intentic/testing/dom";
import { RESTART_PATIENCE_MS, type RestartWork } from "../../features/sandbox/live/sandboxRestart";
import { restartCard } from "./notificationSources";

// The lane's one rule about a sandbox going quiet: whether the silence was asked for decides both what is said and
// how soon. Everything else in this file is wiring; this is the decision.

const rebuild: RestartWork = {
    sandbox: `sbx-1`,
    id: `dev-rebuild`,
    what: `Rebuilding from your checkout`,
    quiet: { title: `Restarting onto the image you built`, detail: `About half a minute, then this page reconnects on its own.` },
    startedAt: 0,
};

describe(`the card for a sandbox that has gone quiet`, () => {
    it(`speaks the moment a restart this browser asked for takes the sandbox away`, () => {
        // `stale` is the first half minute of an outage, which is deliberately invisible for silence nobody can
        // account for. This one is accounted for, and waiting to say so means saying it as the sandbox returns.
        const card = restartCard(rebuild, `stale`, 0);
        expect(card?.title).toBe(rebuild.quiet.title);
        expect(card?.detail).toBe(rebuild.quiet.detail);
    });

    it(`keeps saying it through every shape a swap takes from here`, () => {
        // `detached` is the edge's own verdict, and it arrives 20s into a 30s restart: the card used to disappear at
        // exactly the moment the wait started feeling long.
        for (const availability of [`stale`, `busy`, `detached`] as const) {
            expect(restartCard(rebuild, availability, 25_000)?.title).toBe(rebuild.quiet.title);
        }
    });

    it(`offers nothing to press, since the swap is already under way`, () => {
        expect(restartCard(rebuild, `busy`, 0)?.actions).toBeUndefined();
    });

    it(`stops promising half a minute once the restart has taken far longer than one`, () => {
        expect(restartCard(rebuild, `busy`, RESTART_PATIENCE_MS)).toBeUndefined();
    });

    it(`says nothing while the sandbox is answering, however much is being built`, () => {
        expect(restartCard(rebuild, `live`, 0)).toBeUndefined();
    });

    it(`claims nothing about a silence nobody here asked for`, () => {
        expect(restartCard(undefined, `stale`, 0)).toBeUndefined();
        expect(restartCard(undefined, `busy`, 45_000)).toBeUndefined();
    });
});
