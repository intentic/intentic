import pino from "pino";
import { armLoopbackCatch, type LoopbackBridgeDeps, type LoopbackTarget } from "./loopback-bridge.js";
import { CATCHING_BROWSER as BROWSER, CATCHING_DEVICE as CAN_CATCH, catchingHub, type FakePeers, fakeCatcher } from "./loopback-bridge.testing.js";
import type { DeviceFacts, WebExtFacts } from "@intentic/sandbox-contract";

// The bridge against fake peers (loopback-bridge.testing.ts): each records what it was asked to watch and streams what
// the test pushes, ending when the bridge aborts it, exactly as a device agent's stream does over the socket.

const depsOf = (devices: FakePeers<DeviceFacts>, browsers: FakePeers<WebExtFacts> = {}): LoopbackBridgeDeps => ({
    hostHub: catchingHub(devices),
    webextHub: catchingHub(browsers),
    logger: pino({ level: "silent" }),
});

const TARGET: LoopbackTarget = {
    id: "attempt",
    host: "localhost",
    port: 54_321,
    path: "/callback",
    state: "the-state",
    expiresAt: Date.now() + 60_000,
    title: "Claude",
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

test("nobody of the owner's can watch: nothing is asked and the attempt stays a paste", () => {
    const old = fakeCatcher();
    const armed = armLoopbackCatch(depsOf({ rog: { facts: { ...CAN_CATCH, features: [] }, catcher: old } }), TARGET, async () => {});
    expect(armed.catchers).toEqual([]);
    expect(old.asked).toEqual([]);
});

test("one computer is asked once, on its native side, and a paused browser not at all", async () => {
    const native = fakeCatcher();
    const distro = fakeCatcher();
    const otherPc = fakeCatcher();
    const browser = fakeCatcher();
    const paused = fakeCatcher();
    const armed = armLoopbackCatch(
        depsOf(
            {
                "rog::wsl:archlinux": { facts: { ...CAN_CATCH, machineId: "m-rog" }, catcher: distro },
                rog: { facts: { ...CAN_CATCH, machineId: "m-rog" }, catcher: native },
                "omen::wsl:archlinux": { facts: { ...CAN_CATCH, machineId: "m-omen" }, catcher: otherPc },
            },
            { brave: { facts: BROWSER, catcher: browser }, chrome: { facts: { ...BROWSER, paused: true }, catcher: paused } },
        ),
        TARGET,
        async () => {},
    );
    expect(armed.catchers).toEqual([
        { kind: "device", label: "omen" },
        { kind: "device", label: "rog" },
        { kind: "browser", label: "Brave 154 on Windows" },
    ]);
    await settle();
    expect(native.asked).toEqual([{ id: "attempt", host: "localhost", port: 54_321, path: "/callback", expiresAt: TARGET.expiresAt, title: "Claude" }]);
    expect(JSON.stringify(native.asked)).not.toContain("the-state");
    expect(distro.asked).toEqual([]);
    expect(otherPc.asked).toHaveLength(1);
    expect(browser.asked).toHaveLength(1);
    expect(paused.asked).toEqual([]);
    armed.disarm();
});

test("a landing without this attempt's state is ignored; the first genuine one is delivered once and every watch stops", async () => {
    const rog = fakeCatcher();
    const brave = fakeCatcher();
    const delivered: string[] = [];
    armLoopbackCatch(depsOf({ rog: { facts: CAN_CATCH, catcher: rog } }, { brave: { facts: BROWSER, catcher: brave } }), TARGET, async (url) => {
        delivered.push(url);
    });
    await settle();
    rog.push({ type: "listening" });
    rog.push({ type: "landed", url: "http://localhost:54321/callback?code=forged&state=guess" });
    rog.push({ type: "landed", url: "http://localhost:54321/elsewhere?code=x&state=the-state" });
    await settle();
    expect(delivered).toEqual([]);
    expect(rog.aborted()).toBe(false);
    brave.push({ type: "landed", url: "http://localhost:54321/callback?code=real&state=the-state" });
    rog.push({ type: "landed", url: "http://localhost:54321/callback?code=late&state=the-state" });
    await settle();
    expect(delivered).toEqual(["http://localhost:54321/callback?code=real&state=the-state"]);
    expect(rog.aborted()).toBe(true);
    expect(brave.aborted()).toBe(true);
});

test("disarming stops every watch, and a busy catcher leaves the others watching", async () => {
    const rog = fakeCatcher();
    const omen = fakeCatcher();
    const armed = armLoopbackCatch(
        depsOf({ rog: { facts: { ...CAN_CATCH, machineId: "a" }, catcher: rog }, omen: { facts: { ...CAN_CATCH, machineId: "b" }, catcher: omen } }),
        TARGET,
        async () => {},
    );
    await settle();
    omen.push({ type: "busy", reason: "port 54321 is already taken on this machine" });
    await settle();
    expect(rog.aborted()).toBe(false);
    armed.disarm();
    await settle();
    expect(rog.aborted()).toBe(true);
});

test("a failed finish is logged, not thrown out of the watch", async () => {
    const rog = fakeCatcher();
    armLoopbackCatch(depsOf({ rog: { facts: CAN_CATCH, catcher: rog } }), TARGET, async () => {
        throw new Error("Anthropic refused");
    });
    await settle();
    rog.push({ type: "landed", url: "http://localhost:54321/callback?code=c&state=the-state" });
    await settle();
    expect(rog.aborted()).toBe(true);
});
