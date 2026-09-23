import type { Config } from "../env.config.js";
import { createTrialService, type TrialStatus } from "./trial.js";

// The probe is the platform's answer on its own clock; these pin what a reader waiting on it is owed.

const config = { platform: { url: `https://platform.test/` }, connectToken: `tok` } as Config;

const figures: TrialStatus = { allowance: 20, used: 3, remaining: 17, health: `healthy`, resetsAt: `2026-09-23T00:00:00.000Z` };

// A platform whose answers are released by the test, counting how many probes reached it.
const heldPlatform = () => {
    const pending: ((answer: { status: number; json: unknown }) => void)[] = [];
    return {
        get: () => new Promise<{ status: number; json: unknown }>((resolve) => pending.push(resolve)),
        probes: () => pending.length,
        answer: (answer: { status: number; json: unknown }) => {
            for (const release of pending.splice(0)) {
                release(answer);
            }
        },
    };
};

describe("the trial service", () => {
    it("shares one probe among concurrent readers", async () => {
        const platform = heldPlatform();
        const trial = createTrialService(config, platform.get);
        const readers = Promise.all([trial.refresh(), trial.refresh(), trial.refresh()]);
        expect(platform.probes()).toBe(1);
        platform.answer({ status: 200, json: figures });
        await readers;
        expect(trial.status()).toEqual(figures);
    });

    it("stops waiting at the bound and lands the slow probe for the next read", async () => {
        const platform = heldPlatform();
        const trial = createTrialService(config, platform.get);
        await trial.refresh({ withinMs: 5 });
        expect(trial.available()).toBe(false);
        expect(trial.status()).toBe(undefined);
        platform.answer({ status: 200, json: figures });
        await trial.refresh({ withinMs: 5 });
        expect(trial.available()).toBe(true);
        expect(trial.status()).toEqual(figures);
    });

    it("probes again once the earlier probe has settled", async () => {
        const platform = heldPlatform();
        const trial = createTrialService(config, platform.get);
        const first = trial.refresh();
        platform.answer({ status: 200, json: figures });
        await first;
        const second = trial.refresh();
        expect(platform.probes()).toBe(1);
        platform.answer({ status: 404, json: undefined });
        await second;
        expect(trial.available()).toBe(false);
        expect(trial.status()).toBe(undefined);
    });
});
