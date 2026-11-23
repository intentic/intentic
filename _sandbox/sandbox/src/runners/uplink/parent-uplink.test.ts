import type { FromNode } from "@intentic/sandbox-contract/netd-wire";
import { createParentUplink } from "./parent-uplink.js";

const identity = { parentUrl: "https://sandbox-abc.sbx.example.test", id: "r1", token: "irt_secret" };
const dial: FromNode = { kind: "parentUplink", uplink: { url: identity.parentUrl, runner: "r1", token: "irt_secret" } };
const report = (connected: boolean) => ({ kind: "parentUplink" as const, connected });

test("nothing is sent to a netd that has not reported its parent uplink: an older one closes the link on the frame", () => {
    const told: FromNode[] = [];
    const uplink = createParentUplink();
    uplink.useNetd((message) => told.push(message));
    uplink.want(identity);
    expect(told).toEqual([]);
    // Its first report says it carries parent uplinks: the dial goes then, once.
    uplink.heard(report(false));
    uplink.heard(report(true));
    expect(told).toEqual([dial]);
    expect(uplink.connected()).toBe(true);
});

test("runner mode and the netd door meet in either order, and the same word is said once", () => {
    const told: FromNode[] = [];
    const uplink = createParentUplink();
    uplink.useNetd((message) => told.push(message));
    uplink.heard(report(false));
    // A netd never told to dial is not told to stop.
    uplink.want(undefined);
    expect(told).toEqual([]);
    uplink.want(identity);
    uplink.want(identity);
    expect(told).toEqual([dial]);
});

test("a revoked runner stops dialling, and a restarted link is told again after its report", () => {
    const told: FromNode[] = [];
    const uplink = createParentUplink();
    uplink.want(identity);
    uplink.useNetd((message) => told.push(message));
    uplink.heard(report(true));
    uplink.want(undefined);
    expect(told).toEqual([dial, { kind: "parentUplink" }]);
    // The daemon's link to netd is gone and back (netd restarted): the new one learns nothing until netd reports.
    uplink.useNetd((message) => told.push(message));
    uplink.want(identity);
    expect(told).toHaveLength(2);
    uplink.heard(report(false));
    expect(told.at(-1)).toEqual(dial);
});
