import type { RpcMessage } from "../../agent/tools/turn-mounts.js";
import { boundedWaitOf, describeBoundedWait, sendBoundingWait, waitTimedOut } from "./bounded-wait.js";

// browser_wait_for with a time and a text means "up to this long for this text"; upstream sleeps the time first.

const timedOut: RpcMessage = { result: { isError: true, content: [{ type: "text", text: "### Error\nTimeoutError: locator.waitFor: Timeout 5000ms exceeded." }] } };
const found: RpcMessage = { result: { content: [{ type: "text", text: "### Result\nWaited for Saved" }] } };

describe("a timed text wait", () => {
    it("goes on as the text wait alone, bounded by its time and upstream's 30s ceiling", () => {
        expect(boundedWaitOf({ name: "browser_wait_for", arguments: { time: 10, text: "Saved" } }, 1_000)).toEqual({
            params: { name: "browser_wait_for", arguments: { text: "Saved" } },
            deadline: 11_000,
        });
        expect(boundedWaitOf({ name: "browser_wait_for", arguments: { time: 600, textGone: "Loading" } }, 0)?.deadline).toBe(30_000);
    });

    it("leaves a bare pause, a text wait with no time, and every other tool alone", () => {
        expect(boundedWaitOf({ name: "browser_wait_for", arguments: { time: 3 } })).toBeUndefined();
        expect(boundedWaitOf({ name: "browser_wait_for", arguments: { text: "Saved" } })).toBeUndefined();
        expect(boundedWaitOf({ name: "browser_click", arguments: { time: 3, text: "Saved" } })).toBeUndefined();
    });

    it("is sent again only for a timeout, and only while its time lasts", async () => {
        const sent: unknown[] = [];
        const answers = [timedOut, timedOut, found];
        const answer = await sendBoundingWait({ name: "browser_wait_for", arguments: { time: 30, text: "Saved" } }, undefined, async (params) => {
            sent.push(params["arguments"]);
            return answers[sent.length - 1] ?? found;
        });
        expect(answer).toBe(found);
        expect(sent).toEqual([{ text: "Saved" }, { text: "Saved" }, { text: "Saved" }]);

        const other: RpcMessage = { result: { isError: true, content: [{ type: "text", text: "### Error\nNo open tabs." }] } };
        let calls = 0;
        const counted =
            (reply: RpcMessage) =>
            async (): Promise<RpcMessage> => {
                calls += 1;
                return reply;
            };
        expect(await sendBoundingWait({ name: "browser_wait_for", arguments: { time: 30, text: "Saved" } }, undefined, counted(other))).toBe(other);
        expect(calls).toBe(1);

        const stopped = new AbortController();
        stopped.abort();
        calls = 0;
        expect(await sendBoundingWait({ name: "browser_wait_for", arguments: { time: 30, text: "Saved" } }, stopped.signal, counted(timedOut))).toBe(timedOut);
        expect(calls).toBe(1);
    });

    it("knows a timeout from any other failure", () => {
        expect(waitTimedOut(timedOut)).toBe(true);
        expect(waitTimedOut(found)).toBe(false);
        expect(waitTimedOut({ error: { code: -32603, message: "Timeout 5000ms exceeded" } })).toBe(false);
    });

    it("says in the listed schema what `time` means beside a text", () => {
        const [tool] = describeBoundedWait([
            { name: "browser_wait_for", inputSchema: { type: "object", properties: { time: { type: "number", description: "The time to wait in seconds" } } } },
        ]);
        expect(tool?.inputSchema?.properties?.["time"]).toEqual({ type: "number", description: expect.stringContaining("returns as soon as the text appears") });
        const click = { name: "browser_click", inputSchema: { type: "object", properties: {} } };
        expect(describeBoundedWait([click])[0]).toBe(click);
    });
});
