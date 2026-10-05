import { join } from "node:path";
import {
    type PhoneFacts,
    type PhoneWakeRegistration,
    PhoneWakeRegistrationSchema,
    type PhoneWakeState,
    type PushNotification,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { sendRelay } from "../push/senders/relay.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// How the sandbox wakes a phone that holds no socket. A phone in someone's pocket does not keep a connection open (it
// would cost battery all day, and Android limits the background services that could), so the sandbox pushes it awake
// when a turn calls one of its tools, and the call waits for it to dial in (peers/peer-routes.ts, `wake`).
//
// The push goes through the platform's relay, the same one an iPhone's notifications use: Firebase Cloud Messaging only
// takes sends from the app's publisher. Registering a phone with the relay needs the owner signed in to the platform,
// which the sandbox never is, so the editor does it (it reads the phone's token off its facts, registers it, and hands
// the channel here); the sandbox only keeps the channel and sends. The relay sees a wake and nothing else: the
// notification below carries no content, and the platform's FCM forwarder sends Android channels a data-only message.

const WakeEntrySchema = z.object({ registration: PhoneWakeRegistrationSchema, registeredAt: z.number() });
const PhoneWakeFileSchema = z.object({ phones: z.record(z.string(), WakeEntrySchema) });
type PhoneWakeFile = z.infer<typeof PhoneWakeFileSchema>;

// The relay channel holds a send secret, so the file is the owner's alone, like push.json.
export const phoneWakeDocument = defineDocument({ root: "history", path: "phone-wake.json", schema: PhoneWakeFileSchema });

// What a wake says. The relay requires a title; nothing here is ever shown, since a wake is data-only on the phone.
export const WAKE_NOTIFICATION: PushNotification = { title: "wake", body: "", tag: "intentic-phone-wake", silent: true };

export interface PhoneWake {
    // Keeps the channel the editor registered for this phone's current token.
    readonly register: (id: string, registration: PhoneWakeRegistration) => Promise<void>;
    // Whether the phone can be woken, read against the token it last reported.
    readonly state: (id: string, facts: PhoneFacts | undefined) => Promise<PhoneWakeState>;
    // Sends one wake; false when there is no channel or the relay did not take it. A channel the relay says is dead is
    // forgotten, so the card asks for a registration again rather than waking into nothing.
    readonly send: (id: string) => Promise<boolean>;
    // A renamed card keeps its channel; a removed one loses it.
    readonly rekey: (from: string, to: string) => Promise<void>;
    readonly forget: (id: string) => Promise<void>;
}

export const filePhoneWake = (
    historyRoot: string,
    logger: { warn: (data: object, message: string) => void },
    send: typeof sendRelay = sendRelay,
): PhoneWake => {
    const file = openDocument(phoneWakeDocument, join(historyRoot, phoneWakeDocument.path), {
        fallback: (): PhoneWakeFile => ({ phones: {} }),
        mode: 0o600,
    });
    const forget = async (id: string): Promise<void> => {
        await file.update((current) => {
            const { [id]: _gone, ...phones } = current.phones;
            return { phones };
        });
    };
    return {
        register: async (id, registration) => {
            await file.update((current) => ({ phones: { ...current.phones, [id]: { registration, registeredAt: Date.now() } } }));
        },
        state: async (id, facts) => {
            const held = (await file.read()).phones[id];
            const token = facts?.wake?.fcm;
            if (held !== undefined && (token === undefined || held.registration.token === token)) {
                return "ready";
            }
            return token === undefined ? "none" : "register";
        },
        send: async (id) => {
            const held = (await file.read()).phones[id];
            if (held === undefined) {
                return false;
            }
            const outcome = await send(held.registration.channel, WAKE_NOTIFICATION);
            if (outcome.delivered) {
                return true;
            }
            if ("dead" in outcome && outcome.dead === true) {
                await forget(id).catch((error: unknown) => logger.warn({ err: error, id }, "phones: could not forget a dead wake channel"));
            } else {
                logger.warn({ err: "error" in outcome ? outcome.error : undefined, id }, "phones: the push relay did not take a wake");
            }
            return false;
        },
        rekey: async (from, to) => {
            if (from === to) {
                return;
            }
            await file.update((current) => {
                const { [from]: moved, ...phones } = current.phones;
                return { phones: moved === undefined ? phones : { ...phones, [to]: moved } };
            });
        },
        forget,
    };
};
