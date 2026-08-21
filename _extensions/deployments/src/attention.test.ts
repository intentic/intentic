import type { IntenticApi } from "@intentic/extension-api";
import { computed, nextTick, ref, watchEffect } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSandboxScope } from "@intentic/extension-api";
import { deployBadge, watchConnections } from "./attention";
import { bindHost } from "./host";

/* THE RAIL CALLS detect() FROM INSIDE ITS RENDER COMPUTED, and this extension is the only one that writes
 * anything from there: it is where the live capability list is, so it is where the badge poller learns which
 * Komodos to ask about (attention.ts).
 *
 * That made it the one place where a `Ref` could turn the whole shell into a loop. `watchConnections` reads its
 * own list to spot new connections and then replaces it, so a reactive list is read AND written on every pass
 * of the computed that calls it, and because detect() maps a fresh array each time, the write always counts as
 * a change. The computed comes out of its own run already dirty, so the next thing that asks whether it moved
 * re-runs it, which dirties it again: a frame that never settles, abandoned by Vue after a hundred passes with
 * every unrelated update queued behind the rail thrown away with it. The report is never "the Deployments tile
 * is wrong", it is "the window stopped responding", over a recursion error naming whichever component was on
 * top when Vue gave up.
 *
 * So the test is not really about deployments: it is that the host's computed comes away depending on nothing
 * this function touched. */
describe(`watchConnections`, () => {
    // The watched list and the boards are module state, which is exactly what makes a badge outlive its view:
    // and what makes one test's connections visible to the next. This is the same door the shell opens on a
    // sandbox switch, so each case starts where a freshly connected box does.
    beforeEach(resetSandboxScope);

    it(`leaves the computed that called it with no dependency on its own bookkeeping`, async () => {
        let passes = 0;
        // Everything else the rail's own computed reads: the panels, the capability manifest, another
        // extension's badge landing. Something moves here several times a minute on a live sandbox, and it is
        // what asks the computed whether it has changed. Without that question a self-dirtying computed just
        // sits there, which is why the loop needs a nudge to start and nothing to stop it.
        const elsewhere = ref(0);
        // Stands in for the rail's `tiles`: a computed that calls detect(), which hands back a freshly built
        // array of the connections it found: a new identity every pass, as the real one is.
        const activations = computed(() => {
            passes += 1;
            void elsewhere.value;
            const connections = [`production`, `staging`];
            watchConnections(connections);
            return [...connections];
        });
        const stop = watchEffect(() => void activations.value);
        await nextTick();

        elsewhere.value += 1;
        // Vue aborts the flush the moment it recognises the loop, and in dev it throws while doing so. Catching
        // that here keeps the assertion on the pass count, which says the same thing without depending on how
        // Vue reports it.
        await nextTick().catch(() => undefined);
        stop();

        // Once for the first render, once for the nudge. Any pass beyond those two is the computed answering
        // its own write, which is the loop, however many rounds a bare harness like this one gets through
        // before the awaited tick resolves.
        expect(passes).toBe(2);
    });

    // The bookkeeping has to keep WORKING, not merely stop being reactive: the list is what the poller reads
    // on every tick, and dropping reactivity from a cell nothing renders should cost nothing downstream. This
    // walks the whole path the extension exists for: a connection appears in detect(), the off-cycle read
    // fires because it is new, and the tile badges without waiting out the minute.
    it(`polls a newly seen connection at once, so its tile badges on first render`, async () => {
        const asked: string[] = [];
        bindHost({
            sandbox: {
                reachable: () => true,
                json: (path: string) => {
                    asked.push(path);
                    return Promise.resolve({ reachable: true, alerts: [], resources: [], servers: [] });
                },
            },
        } as unknown as IntenticApi);

        watchConnections([`production`]);
        await vi.waitFor(() => expect(asked).toHaveLength(1));

        expect(asked[0]).toContain(`/komodo/production/overview`);
        expect(deployBadge(`production`)).toBeUndefined();

        // Seen again on the next facts poll: already watched, so no second round trip.
        watchConnections([`production`]);
        await nextTick();
        expect(asked).toHaveLength(1);
    });
});
