import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@intentic/testing/bun";
import { deliveryReceipts } from "./delivery-receipts.js";
import type { Logger } from "../log.js";

// The daemon's outbox retries a reply whose answer never came back; the gateway posts one reply id once.

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const fileIn = (): string => join(mkdtempSync(join(tmpdir(), "receipts-")), "delivery-receipts.json");

test("a reply id posted once answers its repeat with the first post's result, across a gateway restart", async () => {
    const file = fileIn();
    let posts = 0;
    const post = async () => {
        posts += 1;
        return { url: `https://chat.example/${posts}` };
    };
    expect(await deliveryReceipts(file, silent).once("r1", post)).toEqual({ url: "https://chat.example/1" });
    // The record is written behind the answer; a restarted gateway is asked again only after it landed.
    await waitFor(() => expect(existsSync(file)).toBe(true));
    expect(await deliveryReceipts(file, silent).once("r1", post)).toEqual({ url: "https://chat.example/1" });
    expect(posts).toBe(1);
});

test("a repeat arriving while the first post is under way waits for it instead of posting beside it", async () => {
    const receipts = deliveryReceipts(fileIn(), silent);
    const slow = Promise.withResolvers<{ url: string }>();
    let posts = 0;
    const first = receipts.once("r1", () => {
        posts += 1;
        return slow.promise;
    });
    const repeat = receipts.once("r1", async () => {
        posts += 1;
        return { url: "second" };
    });
    slow.resolve({ url: "first" });
    expect(await first).toEqual({ url: "first" });
    expect(await repeat).toEqual({ url: "first" });
    expect(posts).toBe(1);
});

test("a post that failed keeps nothing, so its retry posts; a reply with no id posts every time", async () => {
    const receipts = deliveryReceipts(fileIn(), silent);
    await expect(receipts.once("r1", () => Promise.reject(new Error("rate limited")))).rejects.toThrow("rate limited");
    let posts = 0;
    const post = async () => {
        posts += 1;
        return {};
    };
    await receipts.once("r1", post);
    await receipts.once(undefined, post);
    await receipts.once(undefined, post);
    expect(posts).toBe(3);
});
