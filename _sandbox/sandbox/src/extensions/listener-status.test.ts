import type { ListenerStatus } from "@intentic/sandbox-contract";
import { afterEach, expect, jest, test } from "bun:test";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { listenerStatus, onListenerStatusMoved, setListenerStatus } from "./listener-status.js";

const status = (gateway: "ready" | "connecting"): ListenerStatus => ({ connections: [{ capabilityId: "bot", provider: "probe", gateway }] });

afterEach(() => {
    jest.useRealTimers();
});

test("a moved status announces itself, an identical re-post does not, and aging out does", async () => {
    jest.useFakeTimers();
    const announced: number[] = [];
    const unsubscribe = onListenerStatusMoved(() => announced.push(Date.now()));
    try {
        setListenerStatus("probe", status("connecting"), Date.now());
        expect(announced).toHaveLength(1);

        // The gateway's routine ~30s re-post of the same snapshot is not news.
        await advanceTimersByTimeAsync(30_000);
        setListenerStatus("probe", status("connecting"), Date.now());
        await advanceTimersByTimeAsync(1_000);
        expect(announced).toHaveLength(1);

        setListenerStatus("probe", status("ready"), Date.now());
        expect(announced).toHaveLength(2);

        // A gateway that stops posting ages out with nobody posting that it did; the entry announces it.
        await advanceTimersByTimeAsync(90_001);
        expect(listenerStatus("probe", Date.now())).toBeUndefined();
        expect(announced).toHaveLength(3);
    } finally {
        unsubscribe();
    }
});
