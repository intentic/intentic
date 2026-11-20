import type { FromNode } from "@intentic/sandbox-contract/netd-wire";
import { netdUplinks } from "./netd-uplinks.js";

const reported = (uplinks: readonly (readonly [string, boolean])[]) => ({
    kind: "deviceUplinks" as const,
    uplinks: uplinks.map(([device, connected]) => ({ device, connected })),
});

test("nothing is sent to a netd that has not reported device uplinks: an older one closes the link on the frame", () => {
    const told: FromNode[] = [];
    const uplinks = netdUplinks((message) => told.push(message));
    uplinks.register("rog", "a".repeat(64));
    uplinks.withdraw("rog");
    expect([uplinks.supported(), told]).toEqual([false, []]);
});

test("a registration is sent once per digest, again for another, and a withdrawal forgets it", () => {
    const told: FromNode[] = [];
    const uplinks = netdUplinks((message) => told.push(message));
    uplinks.heard(reported([]));
    uplinks.register("rog", "1".repeat(64));
    uplinks.heard(reported([["rog", false]]));
    uplinks.register("rog", "1".repeat(64));
    uplinks.register("rog", "2".repeat(64));
    uplinks.withdraw("rog");
    uplinks.heard(reported([]));
    uplinks.register("rog", "2".repeat(64));
    expect(told).toEqual([
        { kind: "deviceUplink", device: "rog", tokenSha256: "1".repeat(64) },
        { kind: "deviceUplink", device: "rog", tokenSha256: "2".repeat(64) },
        { kind: "deviceWithdraw", device: "rog" },
        { kind: "deviceUplink", device: "rog", tokenSha256: "2".repeat(64) },
    ]);
});

test("an open waits for netd to report the uplink up, and gives up after its patience", async () => {
    const uplinks = netdUplinks(() => undefined);
    uplinks.heard(reported([["rog", false]]));
    const heard: (readonly string[])[] = [];
    uplinks.onReport((devices) => heard.push(devices));
    const waiting = uplinks.whenConnected("rog", 5_000);
    uplinks.heard(reported([["rog", true], ["omen", false]]));
    expect(await waiting).toBe(true);
    expect([uplinks.connected("rog"), uplinks.connected("omen"), uplinks.registered()]).toEqual([true, false, ["rog", "omen"]]);
    expect(heard).toEqual([["rog", "omen"]]);
    expect(await uplinks.whenConnected("omen", 10)).toBe(false);
});
