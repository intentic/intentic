import type { Services } from "../../composition.js";
import { unstubbed } from "@intentic/testing";
import { admitOnce } from "./dispatch-keys.js";

// One daemon, by the identity of its automations store, which is all the memory is keyed on.
const daemon = () => ({ automations: unstubbed<Services["automations"]>("automations", {}) });

test("a key is admitted once, and a repeat answers that it already was", async () => {
    const services = daemon();
    let admitted = 0;
    const admit = async () => {
        admitted += 1;
        return ["a1"];
    };
    expect(await admitOnce(services, "slack", "k", admit)).toEqual(["a1"]);
    expect(await admitOnce(services, "slack", "k", admit)).toBeUndefined();
    // Keys are per provider, and per daemon: a restarted daemon remembers nothing.
    expect(await admitOnce(services, "discord", "k", admit)).toEqual(["a1"]);
    expect(await admitOnce(daemon(), "slack", "k", admit)).toEqual(["a1"]);
    expect(admitted).toBe(3);
});

test("a repeat racing its first try waits for it instead of admitting beside it", async () => {
    const services = daemon();
    const first = Promise.withResolvers<readonly string[]>();
    let admitted = 0;
    const running = admitOnce(services, "slack", "k", () => {
        admitted += 1;
        return first.promise;
    });
    const repeat = admitOnce(services, "slack", "k", async () => {
        admitted += 1;
        return [];
    });
    first.resolve(["a1"]);
    expect(await running).toEqual(["a1"]);
    expect(await repeat).toBeUndefined();
    expect(admitted).toBe(1);
});

test("a failed admission keeps nothing, so its retry admits for real", async () => {
    const services = daemon();
    await expect(admitOnce(services, "slack", "k", () => Promise.reject(new Error("inbox write failed")))).rejects.toThrow("inbox write failed");
    expect(await admitOnce(services, "slack", "k", async () => ["a1"])).toEqual(["a1"]);
});

test("a message with no key (an older gateway's) is admitted every time", async () => {
    const services = daemon();
    let admitted = 0;
    const admit = async () => {
        admitted += 1;
        return [];
    };
    await admitOnce(services, "slack", undefined, admit);
    await admitOnce(services, "slack", undefined, admit);
    expect(admitted).toBe(2);
});

test("an admitted key is forgotten after an hour", async () => {
    const services = daemon();
    let now = 0;
    const admit = async () => ["a1"];
    await admitOnce(services, "slack", "k", admit, () => now);
    now = 60 * 60 * 1000 + 1;
    expect(await admitOnce(services, "slack", "k", admit, () => now)).toEqual(["a1"]);
});
