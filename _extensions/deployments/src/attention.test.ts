import type { IntenticApi } from "@intentic/extension-api";
import { computed, nextTick, ref, watchEffect } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSandboxScope } from "@intentic/extension-api";
import { deployBadge, watchConnections } from "./attention";
import { bindHost } from "./host";

// Pins that watchConnections (called from detect(), inside the host's render computed) must not leave that computed
// depending on its own writes, or a self-dirtying reactive list loops until Vue gives up and hangs the shell.
describe(`watchConnections`, () => {
    // watched/boards are module state; reset before each test so one test's connections don't leak into the next.
    beforeEach(resetSandboxScope);

    it(`leaves the computed that called it with no dependency on its own bookkeeping`, async () => {
        let passes = 0;
        // Stand-in for whatever else the real computed reads; nudging it is what starts and re-triggers the loop.
        const elsewhere = ref(0);
        // Stands in for the rail's `tiles`; detect() returns a fresh array each pass, same as the real one.
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
        // Vue throws in dev when it aborts the flush for the loop; caught so the assertion is on the pass count.
        await nextTick().catch(() => undefined);
        stop();

        expect(passes).toBe(2);
    });

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

        // Same connection again: already watched, so no second round trip.
        watchConnections([`production`]);
        await nextTick();
        expect(asked).toHaveLength(1);
    });
});
