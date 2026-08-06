import { expect, test, vi } from "vitest";
import { createWhatsAppStream, type WhatsAppPoster } from "./stream.js";

// A fake chat that records every send.
const fakePoster = (): { poster: WhatsAppPoster; sent: string[] } => {
    const sent: string[] = [];
    return { sent, poster: { send: async (text) => void sent.push(text) } };
};

test("nothing is sent while the model is still typing — the reply lands once, complete, on end", async () => {
    const fake = fakePoster();
    const painter = createWhatsAppStream(fake.poster, () => {});
    painter.delta("Looking at ");
    painter.delta("the failing run… ");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No streaming edits on WhatsApp: a message rewritten as the model types is the automation fingerprint
    // that gets numbers flagged.
    expect(fake.sent).toEqual([]);
    painter.delta("it is the flaky auth test again.");
    painter.end();
    await vi.waitFor(() => expect(fake.sent).toEqual(["Looking at the failing run… it is the flaky auth test again."]));
});

test("an empty turn sends nothing at all", async () => {
    const fake = fakePoster();
    const painter = createWhatsAppStream(fake.poster, () => {});
    painter.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.sent).toEqual([]);
});

test("a reply past the safety ceiling splits, losing nothing", async () => {
    const fake = fakePoster();
    const painter = createWhatsAppStream(fake.poster, () => {});
    const long = "x".repeat(130_000);
    painter.delta(long);
    painter.end();
    await vi.waitFor(() => expect(fake.sent.join("")).toBe(long));
    expect(fake.sent.length).toBe(3);
    expect(fake.sent.every((message) => message.length <= 65_536)).toBe(true);
});

test("a failed send reports once instead of throwing into the turn, and end() stays one-shot", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const painter = createWhatsAppStream(
        {
            send: async () => {
                calls += 1;
                throw new Error("not connected");
            },
        },
        (error) => errors.push(error),
    );
    painter.delta("hello");
    painter.end();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    painter.delta("more");
    painter.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toHaveLength(1);
    expect(calls).toBe(1);
});
