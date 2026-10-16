import { randomBytes } from "node:crypto";
import { serialLock } from "@intentic/base/async";
import { z } from "zod";
import type { HelloDriver, HelloResult, PassphrasePrompt, PromptAnswer } from "../consent/consent.js";
import type { Inspected, Typed, Typist } from "../typing/typist.js";
import type { HelperCall } from "./door.js";
import { helloSigned } from "./hello-verify.js";
import type { LineSocket } from "./lines.js";
import { InspectedSchema, SignedSchema, TypedPassphraseSchema, TypedSchema } from "./wire.js";

// The hardened service's way to a person and a keyboard: the session helper, connected through the door and proven by a
// Hello signature or the passphrase (door.ts). Every prompt and every typing goes to it, one call at a time; with no
// helper connected, a prompt is answered "nobody is signed in to ask" and a typing "no session to type in".

// A person may take two minutes at Windows Hello; typing a long value takes a while too.
const PROMPT_DEADLINE_MS = 130_000;
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

const NO_SESSION = "nobody is signed in to Windows to ask: the keyring's session helper starts at sign-in";

export interface HelloPin {
    readonly credential: string;
    readonly publicKey: string;
}

// Windows Hello, through the helper: a signature the helper returns counts only as the TPM key's (helloSigned).
export const remoteHello = (link: HelperLink, pin: () => Promise<HelloPin | undefined>): HelloDriver => {
    const sign = async (credential: string, challenge: string, title: string, message: string): Promise<HelloResult<Buffer>> => {
        const reply = await link.call({ call: "sign", credential, challenge, title, message }, SignedSchema, PROMPT_DEADLINE_MS);
        if (reply === undefined) {
            return { ok: false, cancelled: false, reason: link.ready ? "the session helper did not answer" : NO_SESSION };
        }
        return reply.ok ? { ok: true, value: Buffer.from(reply.signature, "base64") } : { ok: false, cancelled: reply.cancelled, reason: reply.reason };
    };
    return {
        available: async () => link.ready && (await pin()) !== undefined,
        enrol: () => Promise.resolve({ ok: false, cancelled: false, reason: "a hardened keyring keeps the Windows Hello key it was set up with" }),
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

// The passphrase, asked by the helper; the core checks it against the vault, so a helper cannot make one up.
export const remotePassphrasePrompt =
    (link: HelperLink): PassphrasePrompt =>
    async (notice): Promise<PromptAnswer> => {
        const reply = await link.call({ call: "passphrase", title: notice.title, message: notice.message }, TypedPassphraseSchema, PROMPT_DEADLINE_MS);
        return reply ?? { kind: "unavailable", reason: link.ready ? "the session helper did not answer" : NO_SESSION };
    };

export const remoteTypist = (link: HelperLink): Typist => ({
    inspect: async (place): Promise<Inspected> => {
        const reply = await link.call({ call: "inspect", place }, InspectedSchema, TYPING_DEADLINE_MS);
        return reply ?? { ok: false, reason: link.ready ? "the session helper did not answer" : "no one is signed in to Windows to type in" };
    },
    type: async (place, seen, value): Promise<Typed> => {
        const reply = await link.call({ call: "type", place, seen, value }, TypedSchema, TYPING_DEADLINE_MS);
        // Not knowing whether it typed is not knowing whether part of it went in.
        return reply ?? { ok: false, reason: "the session helper did not say whether it typed", partly: true };
    },
});
