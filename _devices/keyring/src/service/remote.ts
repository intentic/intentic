import { randomBytes } from "node:crypto";
import { serialLock } from "@intentic/base/async";
import { z } from "zod";
import type { ChoiceAnswer, ChoicePrompt, HelloDriver, HelloResult, PassphrasePrompt, PromptAnswer, ValueAnswer, ValuePrompt } from "../consent/consent.js";
import type { Inspected, Typed, Typist } from "../typing/typist.js";
import type { HelperCall } from "./door.js";
import { helloSigned } from "./hello-verify.js";
import type { LineSocket } from "./lines.js";
import { asRecoveryKey } from "./recovery.js";
import { AvailableSchema, ChosenSchema, EnrolledSchema, InspectedSchema, SignedSchema, TypedPassphraseSchema, TypedSchema, TypedValueSchema } from "./wire.js";

// The protected service's way to a person and a keyboard: the session helper, connected through the door and proven by
// a Hello signature, a polkit yes or the recovery key (door.ts). Every prompt and every typing goes to it, one call at a
// time; with no helper connected, a prompt is answered "nobody is signed in to ask" and a typing "no session to type in".

// A person may take two minutes at Windows Hello; typing a long value takes a while too.
const PROMPT_DEADLINE_MS = 130_000;
// "Can Hello sign here?" is one quick PowerShell call on the helper's side, which keeps its answer a while.
const AVAILABLE_DEADLINE_MS = 20_000;
const TYPING_DEADLINE_MS = 70_000;

type CallBody<C extends HelperCall> = C extends unknown ? Omit<C, "id"> : never;

export class HelperLink {
    #helper: LineSocket | undefined;
    #next = 1;
    readonly #one = serialLock();

    // The proven helper, replacing any before it.
    attach(helper: LineSocket): void {
        this.#helper?.end();
        this.#helper = helper;
    }

    get ready(): boolean {
        return this.#helper !== undefined && !this.#helper.closed;
    }

    // One call answered by the helper as `schema` says, or undefined when there is none or it did not answer in time.
    async call<T>(body: CallBody<HelperCall>, schema: z.ZodType<T>, deadlineMs: number): Promise<T | undefined> {
        return await this.#one(async () => {
            const helper = this.#helper;
            if (helper === undefined || helper.closed) {
                return undefined;
            }
            const id = this.#next++;
            const envelope = z.object({ id: z.number(), reply: schema });
            helper.send({ id, ...body });
            for (;;) {
                const reply = await helper.nextOf(envelope, deadlineMs);
                if (reply === undefined) {
                    return undefined;
                }
                // An answer to an earlier call that timed out is dropped: only this id's answers this call.
                if (reply.id === id) {
                    return reply.reply;
                }
            }
        });
    }
}

const NO_SESSION = "nobody is signed in to ask: Passwords' session helper starts at sign-in";

export interface HelloPin {
    readonly credential: string;
    readonly publicKey: string;
}

// Windows Hello, through the helper: a signature the helper returns counts only as the TPM key's (helloSigned). Before
// setup nothing is pinned, and the helper both says whether Hello can sign and makes the credential setup pins; once a
// key is pinned the service keeps it, and a helper cannot enrol another.
export const remoteHello = (link: HelperLink, pin: () => Promise<HelloPin | undefined>): HelloDriver => {
    const sign = async (credential: string, challenge: string, title: string, message: string): Promise<HelloResult<Buffer>> => {
        const reply = await link.call({ call: "sign", credential, challenge, title, message }, SignedSchema, PROMPT_DEADLINE_MS);
        if (reply === undefined) {
            return { ok: false, cancelled: false, reason: link.ready ? "the session helper did not answer" : NO_SESSION };
        }
        return reply.ok ? { ok: true, value: Buffer.from(reply.signature, "base64") } : { ok: false, cancelled: reply.cancelled, reason: reply.reason };
    };
    return {
        available: async () => {
            if (!link.ready) {
                return false;
            }
            if ((await pin()) !== undefined) {
                return true;
            }
            return (await link.call({ call: "hello-available" }, AvailableSchema, AVAILABLE_DEADLINE_MS))?.available === true;
        },
        enrol: async (credential, challenge, notice) => {
            if ((await pin()) !== undefined) {
                return { ok: false, cancelled: false, reason: "Passwords keeps the Windows Hello key it was set up with" };
            }
            const reply = await link.call({ call: "enrol", credential, challenge, title: notice.title, message: notice.message }, EnrolledSchema, PROMPT_DEADLINE_MS);
            if (reply === undefined) {
                return { ok: false, cancelled: false, reason: link.ready ? "the session helper did not answer" : NO_SESSION };
            }
            return reply.ok ? { ok: true, value: { signature: Buffer.from(reply.signature, "base64"), publicKey: reply.publicKey } } : reply;
        },
        sign: async (credential, challenge, notice) => await sign(credential, challenge, notice.title, notice.message),
        // A yes while unlocked: a signature over a challenge made just now, checked against the pinned key.
        verify: async (notice) => {
            const pinned = await pin();
            if (pinned === undefined) {
                return { ok: false, cancelled: false, reason: "this keyring has no Windows Hello key" };
            }
            const challenge = randomBytes(32).toString("base64url");
            const signed = await sign(pinned.credential, challenge, notice.title, notice.message);
            if (!signed.ok) {
                return signed;
            }
            return helloSigned(pinned.publicKey, challenge, signed.value.toString("base64"))
                ? { ok: true, value: true }
                : { ok: false, cancelled: false, reason: "the signature was not this keyring's Windows Hello key" };
        },
    };
};

// What the recovery prompt adds to the request it is shown for: the passphrase box is where the recovery key goes.
export const RECOVERY_HINT = "Type your recovery key: the one Passwords showed once when it was set up on this computer.";

// The recovery key (or a passphrase from before recovery keys), asked by the helper; the core checks it against the vault,
// so a helper cannot make one up. What the person typed is read as a recovery key first (recovery.ts).
export const remotePassphrasePrompt =
    (link: HelperLink): PassphrasePrompt =>
    async (notice): Promise<PromptAnswer> => {
        const reply = await link.call({ call: "passphrase", title: notice.title, message: `${notice.message}\n\n${RECOVERY_HINT}` }, TypedPassphraseSchema, PROMPT_DEADLINE_MS);
        if (reply === undefined) {
            return { kind: "unavailable", reason: link.ready ? "the session helper did not answer" : NO_SESSION };
        }
        return reply.kind === "answered" ? { kind: "answered", passphrase: asRecoveryKey(reply.passphrase) } : reply;
    };

// The type-once box, shown by the helper. What comes back is the person's own typing, which the core treats as a value
// given in, never as a yes to anything else.
export const remoteValuePrompt =
    (link: HelperLink): ValuePrompt =>
    async (notice): Promise<ValueAnswer> => {
        const call: Extract<CallBody<HelperCall>, { call: "value" }> = { call: "value", title: notice.title, message: notice.message, remember: notice.remember };
        if (notice.username !== undefined) {
            call.username = notice.username.value === undefined ? {} : { value: notice.username.value };
        }
        const reply = await link.call(call, TypedValueSchema, PROMPT_DEADLINE_MS);
        return reply ?? { kind: "unavailable", reason: link.ready ? "the session helper did not answer" : NO_SESSION };
    };

// The choice dialog, shown by the helper: which answer the person picked. The pick grants nothing by itself; the core
// then asks the verified yes (Hello, polkit) for what was picked.
export const remoteChoicePrompt =
    (link: HelperLink): ChoicePrompt =>
    async (notice): Promise<ChoiceAnswer> => {
        const reply = await link.call({ call: "choice", title: notice.title, message: notice.message, choices: notice.choices.map(({ id, label }) => ({ id, label })) }, ChosenSchema, PROMPT_DEADLINE_MS);
        return reply ?? { kind: "unavailable", reason: link.ready ? "the session helper did not answer" : NO_SESSION };
    };

export const remoteTypist = (link: HelperLink): Typist => ({
    inspect: async (place): Promise<Inspected> => {
        const reply = await link.call({ call: "inspect", place }, InspectedSchema, TYPING_DEADLINE_MS);
        return reply ?? { ok: false, reason: link.ready ? "the session helper did not answer" : "no one is signed in to type in" };
    },
    type: async (place, seen, value): Promise<Typed> => {
        const reply = await link.call({ call: "type", place, seen, value }, TypedSchema, TYPING_DEADLINE_MS);
        // Not knowing whether it typed is not knowing whether part of it went in.
        return reply ?? { ok: false, reason: "the session helper did not say whether it typed", partly: true };
    },
});
