import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import type { Services } from "../../composition.js";
import { recordingLogger } from "../../harness/route-fakes.testing.js";
import { type CapacityWatchDeps, watchCapacity } from "./capacity-watch.js";
import { serviceabilities } from "./serviceability.js";
import { type AccountReopened, onAccountReopened } from "./state-log.js";

// A weekly pool read full, then read again with room: the reading is the first place capacity shows back, and the
// accounts are judged on it at once rather than at the next page load or idle refresh (2026-10-20).
const weekly = (utilization: number): AccountUsage => ({ windows: [{ kind: "seven_day", utilization, gates: "all" }], measuredAt: Date.now() });

test("a new usage reading judges its provider's accounts again, and an account read back to ready is announced", async () => {
    let reading = weekly(100);
    let heard: ((provider: AgentProvider, account: string, usage: AccountUsage | undefined) => void) | undefined;
    const deps: CapacityWatchDeps = unstubbed<CapacityWatchDeps>("deps", {
        claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [{ id: "a", label: "Work", connectedAt: 0 }] }),
        claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
        accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({ a: reading }) }),
        providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({}), onChange: () => () => undefined }),
        headroom: unstubbed<Services["headroom"]>("headroom", {
            onChange: (listener: typeof heard) => {
                heard = listener;
                return () => undefined;
            },
        }),
        logger: recordingLogger().logger,
    });
    const reopened: AccountReopened[] = [];
    const unhear = onAccountReopened((event) => reopened.push(event));
    const stop = watchCapacity(deps);
    try {
        expect(await serviceabilities(deps, "claude")).toEqual([{ id: "a", state: { kind: "spent" } }]);
        reading = weekly(30);
        heard?.("claude", "a", reading);
        await waitFor(() => expect(reopened).toEqual([{ provider: "claude", account: "a", label: "Work", from: "spent" }]), { timeout: 3_000, interval: 20 });
    } finally {
        stop();
        unhear();
    }
});
