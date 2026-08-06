// WhatsApp's text ceiling is 65,536 characters — far past anything a reply should be — so the split here is a
// safety net, not a pagination scheme like Slack's and Telegram's.
const WHATSAPP_MAX = 60_000;

// A sink the daemon's ndjson turn-stream drives: delta(text) as the model types, end() when the turn finishes.
export interface Painter {
    readonly delta: (text: string) => void;
    readonly end: () => void;
}

// The one call this painter makes — structural so tests pass a fake.
export interface WhatsAppPoster {
    readonly send: (text: string) => Promise<void>;
}

/* A painter that deliberately does NOT stream. The other gateways grow a message with edits as the model types;
 * on WhatsApp a message being rewritten twice a second is exactly the automation fingerprint that gets numbers
 * flagged, and every edit wears a visible "edited" label. So this painter buffers the whole reply and sends it
 * ONCE on end() — the typing indicator (listener-owned) is what tells the chat something is coming. Same
 * Painter interface as ext-slack's and ext-telegram's, different rendering policy: the daemon drives all three
 * through the identical TurnStream contract and never knows the difference.
 *
 * Best-effort — a failed send logs via onError and kills the painter, because a lost reply must never crash
 * the turn. */
export const createWhatsAppStream = (poster: WhatsAppPoster, onError: (error: unknown) => void): Painter => {
    let buffer = "";
    let ended = false;

    return {
        delta: (text) => {
            if (ended) {
                return;
            }
            buffer += text;
        },
        end: () => {
            if (ended) {
                return;
            }
            ended = true;
            const complete = buffer;
            if (complete === "") {
                return;
            }
            void (async () => {
                for (let base = 0; base < complete.length; base += WHATSAPP_MAX) {
                    await poster.send(complete.slice(base, base + WHATSAPP_MAX));
                }
            })().catch(onError);
        },
    };
};
