import { gcm } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { S2S_INFO, type S2sPublicKeys, type S2sSigningKeys } from "../../schemas/s2s-identity.js";
import { S2S_CALL_SKEW_MS, type S2sCallMethod, type S2sCallSealed, type S2sSessionOpen } from "../../schemas/s2s-wire.js";
import { canonicalBytes, equalBytes, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./canonical.js";
import { decapsulate, deriveKey, encapsulate } from "./kem.js";
import { fingerprintOf, type RandomBytes, type S2sKeySet, secretKeysOf } from "./keys.js";
import { hybridSign, hybridVerify } from "./sign.js";

// CALL SESSIONS (docs/architecture/messages.md, "Calls"): records and operating are request and response, so one hybrid
// key agreement, signed by the caller, opens a session whose key then seals every call and answer for an hour. A call
// costs a symmetric seal, never a signature, and carries a fresh nonce and a timestamp the callee holds to its replay
// window, so a call replayed or held back is refused.

const SESSION_INFO = `${S2S_INFO} session`;

// The session key both sides derive: 32 bytes, held in memory only.
export type SessionKey = Uint8Array;

const unsignedOf = (request: S2sSessionOpen): Omit<S2sSessionOpen, "sig"> => {
    const { sig: _sig, ...rest } = request;
    return rest;
};

const keyFor = (secret: Uint8Array, request: S2sSessionOpen): SessionKey => deriveKey(secret, sha256(canonicalBytes(unsignedOf(request))), SESSION_INFO);

export interface SessionOpenInput {
    readonly from: string;
    readonly to: string;
    readonly as?: string | undefined;
    readonly caller: S2sKeySet;
    readonly callee: S2sPublicKeys;
    readonly now: number;
    readonly random?: RandomBytes;
}

// What the caller posts to POST /s2s/session, and the key it holds for the session's calls.
export interface SessionOpening {
    readonly request: S2sSessionOpen;
    readonly key: SessionKey;
}

// The caller's half: a fresh agreement to the callee's key set, signed.
export const openSession = ({ from, to, as, caller, callee, now, random = randomBytes }: SessionOpenInput): SessionOpening => {
    const agreement = encapsulate(callee, random);
    const unsigned: Omit<S2sSessionOpen, "sig"> = {
        v: 1,
        from,
        fromFp: caller.fingerprint,
        to,
        toFp: fingerprintOf(callee),
        at: now,
        nonce: toBase64Url(random(16)),
        enc: agreement.enc,
    };
    if (as !== undefined) {
        unsigned.as = as;
    }
    const request: S2sSessionOpen = { ...unsigned, sig: hybridSign("session", canonicalBytes(unsigned), secretKeysOf(caller.secret)) };
    return { request, key: keyFor(agreement.secret, request) };
};

export interface SessionAcceptInput {
    // The pinned caller's public signing keys.
    readonly caller: S2sSigningKeys;
    // Every key set this sandbox can open with.
    readonly keys: readonly S2sKeySet[];
    readonly now: number;
    readonly skewMs?: number;
}

// `signature`: the caller's keys did not sign it. `stale`: its time is outside the skew. `recipient`: sealed to no key
// set offered. `malformed`: its key agreement cannot be decapsulated.
export type SessionAccepted =
    | { readonly ok: true; readonly key: SessionKey }
    | { readonly ok: false; readonly reason: "signature" | "stale" | "recipient" | "malformed" };

// The callee's half: verify, check the clock, and derive the same key. A replayed request is the caller's replay
// window's to refuse (createReplayWindow, keyed by the request's nonce).
export const acceptSession = (request: S2sSessionOpen, { caller, keys, now, skewMs = S2S_CALL_SKEW_MS }: SessionAcceptInput): SessionAccepted => {
    if (!hybridVerify("session", canonicalBytes(unsignedOf(request)), request.sig, caller)) {
        return { ok: false, reason: "signature" };
    }
    if (Math.abs(now - request.at) > skewMs) {
        return { ok: false, reason: "stale" };
    }
    const keySet = keys.find((candidate) => candidate.fingerprint === request.toFp);
    if (keySet === undefined) {
        return { ok: false, reason: "recipient" };
    }
    const secret = decapsulate(request.enc, secretKeysOf(keySet.secret));
    return secret === undefined ? { ok: false, reason: "malformed" } : { ok: true, key: keyFor(secret, request) };
};

// The callee's proof it derived the same key: HMAC-SHA256 under it over the session id (S2sSessionAnswer `confirm`).
export const sessionConfirm = (key: SessionKey, session: string): string => toBase64Url(hmac(sha256, key, utf8(`${SESSION_INFO} confirm ${session}`)));

export const confirmsSession = (key: SessionKey, session: string, confirm: string): boolean => {
    const given = fromBase64Url(confirm);
    return given !== undefined && equalBytes(given, hmac(sha256, key, utf8(`${SESSION_INFO} confirm ${session}`)));
};

// Which way a sealed body travels. An answer is bound to the call it answers by that call's nonce (`re`), so no answer
// can be handed back for another call.
export type CallLeg = { readonly direction: "call" } | { readonly direction: "answer"; readonly re: string };

export interface CallContext {
    readonly session: string;
    readonly method: S2sCallMethod;
    readonly leg: CallLeg;
}

const aadOf = ({ session, method, leg }: CallContext, at: number, nonce: string): Uint8Array =>
    canonicalBytes(leg.direction === "call" ? { session, method, direction: "call", at, nonce } : { session, method, direction: "answer", re: leg.re, at, nonce });

// Seals a call's input or its answer, as JSON, under the session key.
export const sealCall = <T>(key: SessionKey, context: CallContext, payload: T, now: number, random: RandomBytes = randomBytes): S2sCallSealed => {
    const nonceBytes = random(12);
    const nonce = toBase64Url(nonceBytes);
    const body = gcm(key, nonceBytes, aadOf(context, now, nonce)).encrypt(utf8(JSON.stringify(payload)));
    return { at: now, nonce, body: toBase64Url(body) };
};

// The answer to admitting one nonce: fresh, outside the clock skew, or seen before.
export type ReplayVerdict = "fresh" | "stale" | "replay";

export interface ReplayWindow {
    // Admits a nonce made at `at`, remembering it until it would be stale anyway.
    readonly admit: (nonce: string, at: number, now: number) => ReplayVerdict;
    readonly size: () => number;
}

// One session's (or one caller's session requests') nonces: a time outside `skewMs` of now is stale, a nonce seen within
// the window is a replay, and nothing older than the window is kept, since it would be refused as stale.
export const createReplayWindow = (skewMs: number = S2S_CALL_SKEW_MS): ReplayWindow => {
    const seen = new Map<string, number>();
    return {
        admit: (nonce, at, now) => {
            for (const [known, when] of seen) {
                if (when < now - skewMs) {
                    seen.delete(known);
                }
            }
            if (Math.abs(now - at) > skewMs) {
                return "stale";
            }
            if (seen.has(nonce)) {
                return "replay";
            }
            seen.set(nonce, at);
            return "fresh";
        },
        size: () => seen.size,
    };
};

export type CallOpened = { readonly ok: true; readonly json: string } | { readonly ok: false; readonly reason: "stale" | "replay" | "decrypt" };

// Opens a sealed call or answer: its time within the window, its nonce never seen, its body sealed under this key for
// this session, method and leg. Answers the JSON text, for the method's own schema to parse (S2S_CALLS).
export const openCall = (key: SessionKey, context: CallContext, sealed: S2sCallSealed, now: number, replay: ReplayWindow): CallOpened => {
    const nonceBytes = fromBase64Url(sealed.nonce);
    const body = fromBase64Url(sealed.body);
    if (nonceBytes?.length !== 12 || body === undefined) {
        return { ok: false, reason: "decrypt" };
    }
    let json: string;
    try {
        json = fromUtf8(gcm(key, nonceBytes, aadOf(context, sealed.at, sealed.nonce)).decrypt(body));
    } catch {
        // allow(silent-catch): a tag that does not verify is a tampered body, another session's, or another call's.
        return { ok: false, reason: "decrypt" };
    }
    // After the tag, so a forged nonce cannot fill the window.
    const verdict = replay.admit(sealed.nonce, sealed.at, now);
    return verdict === "fresh" ? { ok: true, json } : { ok: false, reason: verdict };
};
