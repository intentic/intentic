import type { MemoryReclaimResult } from "@intentic/sandbox-contract/schemas/metrics";
import { useFreeMemory } from "./freeMemory";

// "Free memory" on the composer's strip: idle, running while the daemon reclaims and reads the computer again, then what
// came of it in words, or why it failed. One press at a time.

const GB = 1024 ** 3;
const GAINED: MemoryReclaimResult = { outcome: `reclaimed`, givenBytes: 1.5 * GB, host: { name: `rog`, beforeBytes: 4.2 * GB, afterBytes: 5.4 * GB } };

// A press the test settles by hand, so the running state can be read while it is underway.
const held = () => {
    let settle: (result: MemoryReclaimResult) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    let calls = 0;
    const reclaim = (): Promise<MemoryReclaimResult> => {
        calls++;
        return new Promise<MemoryReclaimResult>((resolve, reject) => {
            settle = resolve;
            fail = reject;
        });
    };
    return { reclaim, settle: (result: MemoryReclaimResult) => settle(result), fail: (error: Error) => fail(error), calls: () => calls };
};

describe(`useFreeMemory`, () => {
    it(`runs while the daemon works, then says what Windows gained`, async () => {
        const press = held();
        const freeing = useFreeMemory(press.reclaim);
        expect(freeing.state.value).toEqual({ kind: `idle` });
        const pressed = freeing.press();
        expect(freeing.state.value).toEqual({ kind: `running` });
        press.settle(GAINED);
        await pressed;
        expect(freeing.state.value).toEqual({ kind: `done`, text: `Windows gained 1.2 GB: it has 5.4 GB available now.` });
    });

    it(`says plainly when nothing came back`, async () => {
        const freeing = useFreeMemory(async () => ({ outcome: `reclaimed`, givenBytes: GB, host: { name: `rog`, beforeBytes: 4.2 * GB, afterBytes: 4.2 * GB } }));
        await freeing.press();
        expect(freeing.state.value).toEqual({ kind: `done`, text: `Windows got nothing back: this sandbox let go of 1.0 GB, but WSL kept it.` });
    });

    it(`says why a refused press did nothing`, async () => {
        const freeing = useFreeMemory(async () => ({ outcome: `refused`, why: `small` }));
        await freeing.press();
        expect(freeing.state.value).toEqual({ kind: `done`, text: `This sandbox holds too little memory to give any back.` });
    });

    it(`says why a press failed`, async () => {
        const press = held();
        const freeing = useFreeMemory(press.reclaim);
        const pressed = freeing.press();
        press.fail(new Error(`the link dropped`));
        await pressed;
        expect(freeing.state.value).toEqual({ kind: `failed`, text: `Couldn't free memory: the link dropped` });
    });

    it(`takes one press at a time, and keeps a running press when asked to clear`, async () => {
        const press = held();
        const freeing = useFreeMemory(press.reclaim);
        const first = freeing.press();
        await freeing.press();
        expect(press.calls()).toBe(1);
        freeing.clear();
        expect(freeing.state.value).toEqual({ kind: `running` });
        press.settle(GAINED);
        await first;
        freeing.clear();
        expect(freeing.state.value).toEqual({ kind: `idle` });
    });
});
