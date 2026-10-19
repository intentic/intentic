import { seal } from "@intentic/sandbox-contract/keyring-seal";
import { type KeyringNativeRequest, KeyringNativeRequestSchema, type KeyringNativeResponse } from "@intentic/sandbox-contract/schemas/keyring-native";
import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { z } from "zod";
import { keyringPaths } from "../address.js";
import { askKeyring, KeyringUnavailable } from "../client.js";
import type { KeyringRequest, KeyringResponse, Refusal } from "../protocol.js";
import { encodeNativeMessage, NativeFrames } from "./framing.js";

// `intentic-keyring native-host`: what the browser starts when the Intentic extension connects to
// `dev.intentic.keyring` (Chrome's native messaging; the manifest intentic-machine writes names this command through a
// small launcher, and lets in only the extension's own origin). It turns the extension's messages
// (schemas/keyring-native.ts) into the keyring's pipe ops. A password captured on a page is sealed to the vault's inbox
// key here, before it reaches the pipe; a fill goes back only after the keyring's verified yes. The host itself decides
// nothing: it is a process of the person's user, and the pipe is no boundary against one.

export type Ask = <R extends KeyringRequest>(request: R) => Promise<KeyringResponse<R["op"]>>;

const pipeAsk: Ask = async (request) => await askKeyring({ address: keyringPaths().address }, request);

const site = (host: string): KeyringOrigin => ({ kind: "site", host: host.toLowerCase() });

const refusedAs = (request: KeyringNativeRequest, refusal: Refusal): KeyringNativeResponse => ({ type: request.type, id: request.id, ok: false, code: refusal.code, refusal: refusal.refusal });

type NativeOf<T extends KeyringNativeRequest["type"]> = Extract<KeyringNativeRequest, { type: T }>;

const hello = async (request: NativeOf<"hello">, ask: Ask): Promise<KeyringNativeResponse> => {
    const state = await ask({ op: "state" });
    return state.ok ? { type: "hello", id: request.id, ok: true, setUp: state.setUp, locked: state.state.locked, remember: state.state.remember?.browser ?? false, version: state.state.version } : refusedAs(request, state);
};

// The password sealed to the vault's inbox key here, before anything reaches the pipe.
const capture = async (request: NativeOf<"capture">, ask: Ask, now: () => number): Promise<KeyringNativeResponse> => {
    const state = await ask({ op: "state" });
    const inbox = state.ok ? state.state.keys?.inbox : undefined;
    if (inbox === undefined) {
        return refusedAs(request, { ok: false, code: "no-keyring", refusal: "Passwords is not set up on this computer." });
    }
    const at = now();
    const item: Extract<KeyringRequest, { op: "capture" }>["item"] = { origin: site(request.host), sealed: seal(inbox, request.password, { kind: "capture", via: request.browser, at }), source: "browser", via: request.browser, kind: "password", at };
    if (request.username !== undefined && request.username !== "") {
        item.username = request.username;
    }
    if (request.title !== undefined) {
        item.title = request.title;
    }
    if (request.failed === true) {
        item.failed = true;
    }
    const answer = await ask({ op: "capture", item });
    if (!answer.ok) {
        return refusedAs(request, answer);
    }
    const captured: Extract<KeyringNativeResponse, { type: "capture"; ok: true }> = { type: "capture", id: request.id, ok: true, outcome: answer.outcome, at };
    if (answer.name !== undefined) {
        captured.name = answer.name;
    }
    if (answer.title !== undefined) {
        captured.title = answer.title;
    }
    return captured;
};

const candidates = async (request: NativeOf<"candidates">, ask: Ask): Promise<KeyringNativeResponse> => {
    const answer = await ask({ op: "candidates", origin: site(request.host) });
    return answer.ok ? { type: "candidates", id: request.id, ok: true, items: answer.matches } : refusedAs(request, answer);
};

// A value goes back only after the keyring's verified yes, and only for an entry that serves this site.
const fill = async (request: NativeOf<"fill">, ask: Ask): Promise<KeyringNativeResponse> => {
    const answer = await ask({ op: "fill-value", origin: site(request.host), name: request.name });
    if (!answer.ok) {
        return refusedAs(request, answer);
    }
    const filled: Extract<KeyringNativeResponse, { type: "fill"; ok: true }> = { type: "fill", id: request.id, ok: true, password: answer.value };
    if (answer.username !== undefined) {
        filled.username = answer.username;
    }
    return filled;
};

const undo = async (request: NativeOf<"undo">, ask: Ask): Promise<KeyringNativeResponse> => {
    const answer = await ask({ op: "undo-capture", name: request.name, at: request.at });
    return answer.ok ? { type: "undo", id: request.id, ok: true } : refusedAs(request, answer);
};

// Adding a place to the never-save list lets nothing in, so it asks nobody.
const never = async (request: NativeOf<"never">, ask: Ask): Promise<KeyringNativeResponse> => {
    const settings = await ask({ op: "settings" });
    if (!settings.ok) {
        return refusedAs(request, settings);
    }
    const answer = await ask({ op: "set-settings", patch: { neverSave: [...settings.settings.neverSave, site(request.host)] } });
    return answer.ok ? { type: "never", id: request.id, ok: true } : refusedAs(request, answer);
};

/** One extension message answered through the keyring's pipe. */
export const answerNative = async (request: KeyringNativeRequest, ask: Ask, now: () => number = Date.now): Promise<KeyringNativeResponse> => {
    switch (request.type) {
        case "hello":
            return await hello(request, ask);
        case "capture":
            return await capture(request, ask, now);
        case "candidates":
            return await candidates(request, ask);
        case "fill":
            return await fill(request, ask);
        case "undo":
            return await undo(request, ask);
        case "never":
            return await never(request, ask);
    }
};

const NamedSchema = z.object({ id: z.string().min(1).max(64) });

// A message that does not parse is answered as a refusal under whatever id and type it named, when it named them.
const unreadable = (text: string): KeyringNativeResponse => {
    let id = "unknown";
    try {
        const named = NamedSchema.safeParse(JSON.parse(text));
        if (named.success) {
            id = named.data.id;
        }
    } catch {
        // allow(silent-catch): a message that is not JSON names no id, and is answered under "unknown"
    }
    return { type: "hello", id, ok: false, code: "bad-grant", refusal: "Passwords did not understand that message." };
};

export interface NativeIo {
    readonly input: AsyncIterable<Buffer | string>;
    readonly write: (frame: Buffer) => void;
    readonly ask?: Ask;
}

/** Answers the browser's messages, one at a time, until it closes standard input. */
export const runNativeHost = async (io: NativeIo): Promise<number> => {
    const frames = new NativeFrames();
    const ask = io.ask ?? pipeAsk;
    for await (const chunk of io.input) {
        for (const text of frames.push(Buffer.from(chunk))) {
            let json: unknown;
            try {
                json = JSON.parse(text);
            } catch {
                io.write(encodeNativeMessage(unreadable(text)));
                continue;
            }
            const parsed = KeyringNativeRequestSchema.safeParse(json);
            if (!parsed.success) {
                io.write(encodeNativeMessage(unreadable(text)));
                continue;
            }
            let answer: KeyringNativeResponse;
            try {
                answer = await answerNative(parsed.data, ask);
            } catch (error) {
                answer = refusedAs(parsed.data, { ok: false, code: "no-keyring", refusal: error instanceof KeyringUnavailable ? error.message : "Passwords could not be asked." });
            }
            io.write(encodeNativeMessage(answer));
        }
    }
    return 0;
};
