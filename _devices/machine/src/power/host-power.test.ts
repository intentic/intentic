import type { HostPower } from "@intentic/sandbox-contract/schemas/host-power";
import { createPowerWatch, POWER_REFRESH_MS } from "./host-power.js";

/* THE READING THE DEVICE'S FACTS CARRY: read once, kept five minutes, an older one answered while the next is read,
   a failure said once, and forgotten when this agent changed the settings. */

const power = (at: number): HostPower => ({ at, utcOffsetMinutes: 60, findings: [] });

// Lets the reads' own handlers run.
const settle = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

// Reads the test settles by hand; `begun(n)` waits until the n-th has started (an ask checks the stamp first).
const reads = () => {
    const pending: { resolve: (value: HostPower | undefined) => void; reject: (error: Error) => void }[] = [];
    const read = (): Promise<HostPower | undefined> =>
        new Promise((resolve, reject) => {
            pending.push({ resolve, reject });
        });
    const begun = async (count: number): Promise<void> => {
        for (let tries = 0; pending.length < count && tries < 20; tries += 1) {
            await settle();
        }
        expect(pending).toHaveLength(count);
    };
    return { read, pending, begun };
};

test("the first reading is waited for, then kept five minutes, then the old one is answered while the next is read", async () => {
    let clock = 0;
    const { read, pending, begun } = reads();
    const watch = createPowerWatch({ read, now: () => clock, firstWaitMs: 1000 });
    const first = watch.current(() => undefined);
    await begun(1);
    pending[0]?.resolve(power(1));
    expect(await first).toEqual(power(1));
    clock = POWER_REFRESH_MS - 1;
    expect(await watch.current(() => undefined)).toEqual(power(1));
    expect(pending).toHaveLength(1);
    clock = POWER_REFRESH_MS;
    expect(await watch.current(() => undefined)).toEqual(power(1));
    expect(pending).toHaveLength(2);
    pending[1]?.resolve(power(2));
    await settle();
    expect(await watch.current(() => undefined)).toEqual(power(2));
});

test("a first reading slower than the wait answers nothing, never throws, and lands for the next ask", async () => {
    const { read, pending, begun } = reads();
    const watch = createPowerWatch({ read, now: () => 0, firstWaitMs: 5 });
    expect(await watch.current(() => undefined)).toBeUndefined();
    await begun(1);
    pending[0]?.resolve(power(1));
    await settle();
    expect(await watch.current(() => undefined)).toEqual(power(1));
});

test("a failing read is said once until one works, and the last reading stands", async () => {
    let clock = 0;
    const { read, pending, begun } = reads();
    const said: string[] = [];
    const log = (line: string): void => void said.push(line);
    const watch = createPowerWatch({ read, now: () => clock, firstWaitMs: 1000 });
    const first = watch.current(log);
    await begun(1);
    pending[0]?.resolve(power(1));
    await first;
    for (const at of [1, 2]) {
        clock = POWER_REFRESH_MS * at;
        const asked = watch.current(log);
        await begun(at + 1);
        pending[at]?.reject(new Error("Command failed: powershell.exe (it ran past its deadline and was stopped)\nmore"));
        expect(await asked).toEqual(power(1));
        await settle();
    }
    expect(said).toEqual(["reading this computer's power settings failed (the last reading stands): Command failed: powershell.exe (it ran past its deadline and was stopped)"]);
});

test("forgotten after a change, the next ask waits for a fresh read, and a read begun before the change is dropped", async () => {
    let clock = 0;
    const { read, pending, begun } = reads();
    const watch = createPowerWatch({ read, now: () => clock, firstWaitMs: 1000 });
    const first = watch.current(() => undefined);
    await begun(1);
    pending[0]?.resolve(power(1));
    await first;
    // A refresh is underway when the change lands.
    clock = POWER_REFRESH_MS;
    expect(await watch.current(() => undefined)).toEqual(power(1));
    watch.forget();
    const after = watch.current(() => undefined);
    await begun(3);
    pending[1]?.resolve(power(1.5));
    pending[2]?.resolve(power(2));
    expect(await after).toEqual(power(2));
    await settle();
    expect(await watch.current(() => undefined)).toEqual(power(2));
});

// (2026-11-22) The owner's yes runs `power stay-on` as a detached child, or a person runs it in a terminal: either way the
// daemon reads the facts right after, and they must say the new settings, not the five-minute-old ones.
test("a reading taken before stay-on or restore stamped a change is dropped at the next ask, which waits for a fresh one", async () => {
    // A stamp from an earlier change, older than the first reading: no change for that reading.
    let stamp = 1000;
    const { read, pending, begun } = reads();
    const watch = createPowerWatch({ read, changedAt: () => Promise.resolve(stamp), now: () => 0, firstWaitMs: 1000 });
    const first = watch.current(() => undefined);
    await begun(1);
    pending[0]?.resolve(power(1));
    expect(await first).toEqual(power(1));
    expect(await watch.current(() => undefined)).toEqual(power(1));
    expect(pending).toHaveLength(1);
    stamp = 5000;
    const after = watch.current(() => undefined);
    await begun(2);
    pending[1]?.resolve(power(2));
    expect(await after).toEqual(power(2));
    // The new reading began under the new stamp, so it is kept.
    expect(await watch.current(() => undefined)).toEqual(power(2));
    expect(pending).toHaveLength(2);
});
