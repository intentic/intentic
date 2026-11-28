import { S2S_CALL_SKEW_MS, type S2sCallSealed, S2sSessionOpenSchema } from "../../schemas/s2s-wire.js";
import { equalBytes, fromBase64Url, toBase64Url } from "./canonical.js";
import { keySetFor, seededRandom } from "./s2s.testing.js";
import {
    acceptSession,
    type CallContext,
    confirmsSession,
    createReplayWindow,
    openCall,
    openSession,
    sealCall,
    sessionConfirm,
} from "./session.js";

const NOW = 1_800_000_000_000;
const caller = keySetFor(`caller`);
const callee = keySetFor(`callee`);
const calleeBefore = keySetFor(`callee before`);
const mallory = keySetFor(`mallory`);
const opening = openSession({ from: `caller.example`, to: `callee.example`, caller, callee: callee.public, now: NOW, random: seededRandom(`open`) });

const call: CallContext = { session: `s-1`, method: `operate.read`, leg: { direction: `call` } };

const flipByte = (text: string, at: number): string => {
    const bytes = fromBase64Url(text) ?? new Uint8Array();
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    return toBase64Url(bytes);
};

describe("a call session", () => {
    it("gives the callee the caller's key, after JSON and the schema", () => {
        const arrived = S2sSessionOpenSchema.parse(JSON.parse(JSON.stringify(opening.request)));
        const accepted = acceptSession(arrived, { caller: caller.public, keys: [callee], now: NOW + 1_000 });
        expect(accepted.ok).toBe(true);
        expect(accepted.ok && equalBytes(accepted.key, opening.key)).toBe(true);
        expect(opening.key.length).toBe(32);
        expect(opening.request).toMatchObject({ v: 1, from: `caller.example`, fromFp: caller.fingerprint, to: `callee.example`, toFp: callee.fingerprint, at: NOW });
    });

    it("opens with a kept previous key set it was made to", () => {
        const late = openSession({ from: `caller.example`, to: `callee.example`, caller, callee: calleeBefore.public, now: NOW });
        const accepted = acceptSession(late.request, { caller: caller.public, keys: [callee, calleeBefore], now: NOW });
        expect(accepted.ok && equalBytes(accepted.key, late.key)).toBe(true);
        expect(acceptSession(late.request, { caller: caller.public, keys: [callee], now: NOW })).toEqual({ ok: false, reason: `recipient` });
    });

    it("refuses another caller's keys and any changed field", () => {
        expect(acceptSession(opening.request, { caller: mallory.public, keys: [callee], now: NOW })).toEqual({ ok: false, reason: `signature` });
        for (const change of [{ at: NOW + 1 }, { from: `mallory.example` }, { as: `ada@acme.example` }, { nonce: flipByte(opening.request.nonce, 0) }]) {
            expect(acceptSession({ ...opening.request, ...change }, { caller: caller.public, keys: [callee], now: NOW })).toEqual({ ok: false, reason: `signature` });
        }
        const enc = { ...opening.request.enc, mlkem768: flipByte(opening.request.enc.mlkem768, 7) };
        expect(acceptSession({ ...opening.request, enc }, { caller: caller.public, keys: [callee], now: NOW })).toEqual({ ok: false, reason: `signature` });
    });

    it("refuses a request whose time is past the skew either way, and admits one at its edge", () => {
        const accept = (now: number) => acceptSession(opening.request, { caller: caller.public, keys: [callee], now });
        expect(accept(NOW + S2S_CALL_SKEW_MS).ok).toBe(true);
        expect(accept(NOW - S2S_CALL_SKEW_MS).ok).toBe(true);
        expect(accept(NOW + S2S_CALL_SKEW_MS + 1)).toEqual({ ok: false, reason: `stale` });
        expect(accept(NOW - S2S_CALL_SKEW_MS - 1)).toEqual({ ok: false, reason: `stale` });
    });

    it("confirms the session only under the same key and the same id", () => {
        const confirm = sessionConfirm(opening.key, `s-1`);
        expect(confirmsSession(opening.key, `s-1`, confirm)).toBe(true);
        expect(confirmsSession(opening.key, `s-2`, confirm)).toBe(false);
        expect(confirmsSession(new Uint8Array(32), `s-1`, confirm)).toBe(false);
    });
});

describe("a sealed call", () => {
    const input = { path: `README.md`, limit: 20 };
    const sealed = sealCall(opening.key, call, input, NOW, seededRandom(`call`));

    it("opens to its JSON under the session key, once", () => {
        const window = createReplayWindow();
        expect(openCall(opening.key, call, sealed, NOW + 500, window)).toEqual({ ok: true, json: JSON.stringify(input) });
        expect(openCall(opening.key, call, sealed, NOW + 600, window)).toEqual({ ok: false, reason: `replay` });
    });

    it("refuses another session's key, session id, method or leg", () => {
        expect(openCall(new Uint8Array(32), call, sealed, NOW, createReplayWindow())).toEqual({ ok: false, reason: `decrypt` });
        expect(openCall(opening.key, { ...call, session: `s-2` }, sealed, NOW, createReplayWindow())).toEqual({ ok: false, reason: `decrypt` });
        expect(openCall(opening.key, { ...call, method: `operate.write` }, sealed, NOW, createReplayWindow())).toEqual({ ok: false, reason: `decrypt` });
        expect(openCall(opening.key, { ...call, leg: { direction: `answer`, re: sealed.nonce } }, sealed, NOW, createReplayWindow())).toEqual({ ok: false, reason: `decrypt` });
    });

    it("binds an answer to the call it answers", () => {
        const answerLeg: CallContext = { ...call, leg: { direction: `answer`, re: sealed.nonce } };
        const answer = sealCall(opening.key, answerLeg, { content: `# hi` }, NOW + 10);
        expect(openCall(opening.key, answerLeg, answer, NOW + 20, createReplayWindow())).toEqual({ ok: true, json: `{"content":"# hi"}` });
        expect(openCall(opening.key, { ...call, leg: { direction: `answer`, re: `another` } }, answer, NOW + 20, createReplayWindow())).toEqual({ ok: false, reason: `decrypt` });
    });

    it("refuses every changed byte of its body and its nonce, and a changed time", () => {
        const bodyBytes = fromBase64Url(sealed.body)?.length ?? 0;
        for (let at = 0; at < bodyBytes; at++) {
            expect(openCall(opening.key, call, { ...sealed, body: flipByte(sealed.body, at) }, NOW, createReplayWindow())).toEqual({ ok: false, reason: `decrypt` });
        }
        for (let at = 0; at < 12; at++) {
            expect(openCall(opening.key, call, { ...sealed, nonce: flipByte(sealed.nonce, at) }, NOW, createReplayWindow())).toEqual({ ok: false, reason: `decrypt` });
        }
        const later: S2sCallSealed = { ...sealed, at: NOW + 1 };
        expect(openCall(opening.key, call, later, NOW, createReplayWindow())).toEqual({ ok: false, reason: `decrypt` });
    });

    it("refuses one sealed too long ago or too far ahead", () => {
        expect(openCall(opening.key, call, sealed, NOW + S2S_CALL_SKEW_MS + 1, createReplayWindow())).toEqual({ ok: false, reason: `stale` });
        expect(openCall(opening.key, call, sealed, NOW - S2S_CALL_SKEW_MS - 1, createReplayWindow())).toEqual({ ok: false, reason: `stale` });
    });
});

describe("a replay window", () => {
    it("admits a nonce once, refuses it again within the window, and refuses times outside it", () => {
        const window = createReplayWindow(1_000);
        expect(window.admit(`n1`, NOW, NOW)).toBe(`fresh`);
        expect(window.admit(`n1`, NOW, NOW + 10)).toBe(`replay`);
        expect(window.admit(`n2`, NOW + 1_000, NOW)).toBe(`fresh`);
        expect(window.admit(`n3`, NOW + 1_001, NOW)).toBe(`stale`);
        expect(window.admit(`n4`, NOW - 1_001, NOW)).toBe(`stale`);
    });

    it("forgets what would be stale anyway, so it stays small", () => {
        const window = createReplayWindow(1_000);
        for (let index = 0; index < 50; index++) {
            window.admit(`n${index}`, NOW + index * 100, NOW + index * 100);
        }
        // At NOW + 4900, everything made before NOW + 3900 is past the window.
        expect(window.size()).toBe(11);
        expect(window.admit(`n49`, NOW + 4_900, NOW + 4_950)).toBe(`replay`);
    });
});
