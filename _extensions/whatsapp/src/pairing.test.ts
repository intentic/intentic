import { EventEmitter } from "node:events";
import { awaitPairingAnswer, PairingRefused } from "./pairing.js";

/* A CODE WHATSAPP REFUSED IS NOT A CODE. Baileys returns its link code before WhatsApp answers the request, so the
 * answer is read off the socket: an accepted request shows the code, a refused one shows WhatsApp's reason instead of a
 * code the phone would reject with "Couldn't link device". */

const iq = (attrs: Record<string, string>, content?: unknown) => ({ tag: "iq", attrs, content });

it("accepts on the reply WhatsApp sends to the link-code request", async () => {
    const ws = new EventEmitter();
    const { answer } = awaitPairingAnswer(ws, 5_000);

    ws.emit("frame", iq({ type: "result", id: "1.2-1" }, [{ tag: "link_code_companion_reg", attrs: { stage: "companion_hello" } }]));

    expect(await answer).toBe("accepted");
    expect(ws.listenerCount("frame")).toBe(0);
});

it("refuses with WhatsApp's own reason when the request is answered with an error", async () => {
    const ws = new EventEmitter();
    const { answer } = awaitPairingAnswer(ws, 5_000);

    ws.emit("frame", iq({ type: "error", id: "1.2-1" }, [{ tag: "error", attrs: { code: "400", text: "bad-request" } }]));

    const refusal = await answer.then(
        () => undefined,
        (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(PairingRefused);
    expect((refusal as Error).message).toBe("bad-request (400)");
});

it("leaves alone a reply some query() is awaiting, and anything that is not an iq", async () => {
    const ws = new EventEmitter();
    // An in-flight query (a keep-alive ping, say) has its own listener for its reply's id.
    ws.on("TAG:1.2-7", () => undefined);
    const { answer } = awaitPairingAnswer(ws, 5_000);

    ws.emit("frame", iq({ type: "error", id: "1.2-7" }, [{ tag: "error", attrs: { code: "500", text: "internal" } }]));
    ws.emit("frame", { tag: "notification", attrs: { type: "error" } });
    ws.emit("frame", new Uint8Array([1, 2, 3]));
    ws.emit("frame", iq({ type: "result", id: "1.2-1" }));

    expect(await answer).toBe("accepted");
});

it("says unanswered rather than refused when WhatsApp stays silent", async () => {
    const ws = new EventEmitter();
    const { answer } = awaitPairingAnswer(ws, 10);

    expect(await answer).toBe("unanswered");
    expect(ws.listenerCount("frame")).toBe(0);
});

it("stops listening when cancelled, so a later reply settles nothing", () => {
    const ws = new EventEmitter();
    const { cancel } = awaitPairingAnswer(ws, 5_000);

    cancel();

    expect(ws.listenerCount("frame")).toBe(0);
});
