// WhatsApp's answer to a link-code request, read off the socket. Baileys' requestPairingCode sends the request without
// waiting for the reply and hands back its code either way (Baileys #2559), so a refused request still yields a
// well-formed code that the phone then rejects with "Couldn't link device". Import-free, like types.ts, so it is
// testable without a socket.

// The slice of baileys' socket client this reads: every decoded stanza is emitted as `frame`, and a reply someone
// awaits through query() has a `TAG:<id>` listener registered while it is in flight.
export interface FrameSource {
    readonly on: (event: "frame", listener: (frame: unknown) => void) => unknown;
    readonly off: (event: "frame", listener: (frame: unknown) => void) => unknown;
    readonly listenerCount: (event: string) => number;
}

interface Stanza {
    readonly tag: string;
    // The attributes read here; a stanza carries others.
    readonly attrs: { readonly id?: string; readonly type?: string; readonly code?: string; readonly text?: string };
    readonly content?: unknown;
}

const isStanza = (frame: unknown): frame is Stanza =>
    typeof frame === "object" && frame !== null && typeof (frame as Stanza).tag === "string" && typeof (frame as Stanza).attrs === "object";

// accepted: WhatsApp registered the code. unanswered: nothing came back in time, so nothing says it was refused either.
export type PairingAnswer = "accepted" | "unanswered";

export class PairingRefused extends Error {}

// Starts listening before the request goes out, so a fast reply is not missed. The link-code request is the only
// fire-and-forget iq an unpaired socket sends, so the first iq reply nobody awaits is its answer: a `result` accepts
// it, an `error` refuses it. `cancel` stops listening once the request itself failed.
export const awaitPairingAnswer = (ws: FrameSource, timeoutMs: number): { readonly answer: Promise<PairingAnswer>; readonly cancel: () => void } => {
    let stop = (): void => undefined;
    const answer = new Promise<PairingAnswer>((resolve, reject) => {
        const onFrame = (frame: unknown): void => {
            if (!isStanza(frame) || frame.tag !== "iq" || ws.listenerCount(`TAG:${frame.attrs.id ?? ""}`) > 0) {
                return;
            }
            if (frame.attrs.type === "result") {
                stop();
                resolve("accepted");
                return;
            }
            if (frame.attrs.type === "error") {
                stop();
                const error = (Array.isArray(frame.content) ? (frame.content as unknown[]) : []).find((child) => isStanza(child) && child.tag === "error");
                const attrs = isStanza(error) ? error.attrs : {};
                reject(new PairingRefused(`${attrs.text ?? "error"} (${attrs.code ?? "no code"})`));
            }
        };
        const timer = setTimeout(() => {
            stop();
            resolve("unanswered");
        }, timeoutMs);
        stop = () => {
            clearTimeout(timer);
            ws.off("frame", onFrame);
        };
        ws.on("frame", onFrame);
    });
    // A refusal that lands while the request itself is still failing is reported through the request, not unhandled.
    answer.catch(() => undefined);
    return { answer, cancel: () => stop() };
};
