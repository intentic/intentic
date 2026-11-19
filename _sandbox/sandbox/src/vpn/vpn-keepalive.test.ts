import { retryDelayMs, startVpnKeepAlive, type VpnKeepAliveDeps } from "./vpn-keepalive.js";
import type { VpnEntry } from "./vpn-links.js";

const entry = (id: string, autoConnect: "on" | "off" = "on"): VpnEntry => ({
    id,
    config: { provider: "wireguard", config: "[Interface]", autoConnect },
});

const silent = { info: () => undefined, warn: () => undefined };

// One fake machine: which tunnels exist, which are marked wanted, which are up, and every dial made against it.
const machine = (entries: VpnEntry[]) => {
    const marked = new Set(entries.map((e) => e.id));
    const up = new Set<string>();
    const dials: string[] = [];
    let refuse = false;
    const deps: VpnKeepAliveDeps = {
        entries: () => Promise.resolve(entries),
        marked: (e) => Promise.resolve(marked.has(e.id)),
        down: (e) => Promise.resolve(!up.has(e.id)),
        dial: (e) => {
            dials.push(e.id);
            if (refuse) {
                return Promise.reject(new Error("the gateway did not answer"));
            }
            up.add(e.id);
            return Promise.resolve();
        },
    };
    return {
        deps,
        marked,
        up,
        dials,
        refuseDials: (value: boolean) => {
            refuse = value;
        },
    };
};

describe("startVpnKeepAlive", () => {
    test("an auto-connect tunnel that dropped is redialled, and one still up is left alone", async () => {
        const m = machine([entry("systemeg"), entry("office")]);
        m.up.add("office");
        const watch = startVpnKeepAlive(m.deps, { logger: silent, checkMs: 1e9 });
        await watch.check();
        expect(m.dials).toEqual(["systemeg"]);
        await watch.check();
        expect(m.dials).toEqual(["systemeg"]);
        watch.stop();
    });

    test("a tunnel taken down on purpose (no up marker) or not set to auto-connect is never dialled", async () => {
        const m = machine([entry("systemeg"), entry("manual", "off")]);
        m.marked.delete("systemeg");
        const watch = startVpnKeepAlive(m.deps, { logger: silent, checkMs: 1e9 });
        await watch.check();
        expect(m.dials).toEqual([]);
        watch.stop();
    });

    test("a failing redial backs off instead of retrying every pass, and recovers once the gateway answers", async () => {
        let clock = 0;
        const m = machine([entry("systemeg")]);
        m.refuseDials(true);
        const watch = startVpnKeepAlive(m.deps, { logger: silent, checkMs: 1e9, now: () => clock });
        await watch.check();
        expect(m.dials).toHaveLength(1);
        clock += retryDelayMs(1) - 1;
        await watch.check();
        expect(m.dials).toHaveLength(1);
        clock += 1;
        await watch.check();
        expect(m.dials).toHaveLength(2);
        m.refuseDials(false);
        clock += retryDelayMs(2);
        await watch.check();
        expect(m.dials).toHaveLength(3);
        expect(m.up.has("systemeg")).toBe(true);
        watch.stop();
    });

    test("the retry delay doubles up to a ten-minute ceiling", () => {
        expect(retryDelayMs(1)).toBe(30_000);
        expect(retryDelayMs(2)).toBe(60_000);
        expect(retryDelayMs(20)).toBe(600_000);
    });
});
