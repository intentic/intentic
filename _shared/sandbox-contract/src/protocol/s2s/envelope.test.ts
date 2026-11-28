import { S2sEnvelopeIdSchema, type S2sEnvelope, S2sEnvelopeSchema, type S2sPayload } from "../../schemas/s2s-wire.js";
import { canonicalBytes, fromBase64Url, toBase64Url } from "./canonical.js";
import { type EnvelopeAddressing, openEnvelope, openSelfSigned, sealEnvelope, uuidv7, verifyEnvelope } from "./envelope.js";
import { type S2sKeySet, secretKeysOf } from "./keys.js";
import { keySetFor, seededRandom } from "./s2s.testing.js";
import { hybridSign } from "./sign.js";

const NOW = 1_800_000_000_000;
const alice = keySetFor(`alice`);
const bob = keySetFor(`bob`);
const bobBefore = keySetFor(`bob before`);
const mallory = keySetFor(`mallory`);

const addressing: EnvelopeAddressing = { from: `alice.sandbox.example`, to: `bob.example`, kind: `message`, thread: `t-1`, hops: 0, sentAt: NOW };
const payload: S2sPayload = { kind: `message`, subject: `hello`, text: `the plan is in the file`, attachments: [{ name: `plan.md`, data: `IyBQbGFu` }] };
const sealed = sealEnvelope({ addressing, payload, sender: alice, recipient: bob.public, random: seededRandom(`seal`) });

// Re-signed by the sender after a change, so only the encryption can refuse it.
const resigned = (envelope: S2sEnvelope): S2sEnvelope => {
    const { sig: _sig, ...unsigned } = envelope;
    return { ...unsigned, sig: hybridSign(`envelope`, canonicalBytes(unsigned), secretKeysOf(alice.secret)) };
};

const flipByte = (text: string, at: number): string => {
    const bytes = fromBase64Url(text) ?? new Uint8Array();
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    return toBase64Url(bytes);
};

describe("a UUIDv7", () => {
    it("starts with the time in milliseconds and carries version 7 and the RFC variant", () => {
        const id = uuidv7(NOW, seededRandom(`id`));
        expect(id.startsWith(`01a3185c-5000-7`)).toBe(true);
        expect(S2sEnvelopeIdSchema.safeParse(id).success).toBe(true);
        expect(uuidv7(NOW + 1, seededRandom(`id`)) > id).toBe(true);
    });
});

describe("an envelope", () => {
    it("fills the header from the addressing and the two key sets", () => {
        expect(sealed).toMatchObject({ v: 1, from: `alice.sandbox.example`, fromFp: alice.fingerprint, to: `bob.example`, toFp: bob.fingerprint, kind: `message`, thread: `t-1`, hops: 0, sentAt: NOW });
        expect(S2sEnvelopeIdSchema.safeParse(sealed.id).success).toBe(true);
        expect(Object.keys(sealed)).not.toContain(`replyTo`);
        expect(fromBase64Url(sealed.enc.nonce)?.length).toBe(12);
        expect(fromBase64Url(sealed.enc.x25519)?.length).toBe(32);
        expect(fromBase64Url(sealed.enc.mlkem768)?.length).toBe(1088);
    });

    it("opens to the payload for the receiver, after JSON and the schema", () => {
        const arrived = S2sEnvelopeSchema.parse(JSON.parse(JSON.stringify(sealed)));
        const opened = openEnvelope(arrived, { sender: alice.public, keys: [bob] });
        expect(opened).toEqual({ ok: true, header: expect.objectContaining({ id: sealed.id, kind: `message`, toFp: bob.fingerprint }), payload });
    });

    it("hides the payload: no word of it is in the envelope", () => {
        const text = JSON.stringify(sealed);
        expect(text.includes(`the plan is in the file`)).toBe(false);
        expect(text.includes(`plan.md`)).toBe(false);
    });

    it("opens with a kept previous key set it was sealed to", () => {
        const late = sealEnvelope({ addressing, payload, sender: alice, recipient: bobBefore.public });
        expect(openEnvelope(late, { sender: alice.public, keys: [bob, bobBefore] })).toMatchObject({ ok: true, payload });
        expect(openEnvelope(late, { sender: alice.public, keys: [bob] })).toEqual({ ok: false, reason: `recipient` });
    });

    it("refuses another sender's keys, and either half of the signature from another signer", () => {
        expect(openEnvelope(sealed, { sender: mallory.public, keys: [bob] })).toEqual({ ok: false, reason: `signature` });
        const theirs = sealEnvelope({ addressing, payload, sender: mallory, recipient: bob.public });
        expect(verifyEnvelope({ ...sealed, sig: { ...sealed.sig, ed25519: theirs.sig.ed25519 } }, alice.public)).toBe(false);
        expect(verifyEnvelope({ ...sealed, sig: { ...sealed.sig, mldsa65: theirs.sig.mldsa65 } }, alice.public)).toBe(false);
    });

    it("refuses any changed header field, as a signature that no longer verifies", () => {
        const changes: readonly Partial<S2sEnvelope>[] = [
            { id: uuidv7(NOW) },
            { from: `mallory.example` },
            { to: `carol.example` },
            { kind: `report` },
            { thread: `t-2` },
            { as: `ada@acme.example` },
            { hops: 1 },
            { sentAt: NOW + 1 },
        ];
        for (const change of changes) {
            expect(openEnvelope({ ...sealed, ...change }, { sender: alice.public, keys: [bob] })).toEqual({ ok: false, reason: `signature` });
        }
    });

    it("refuses every changed byte of the body, and changed bytes of the key agreement", () => {
        const bodyBytes = fromBase64Url(sealed.body)?.length ?? 0;
        expect(bodyBytes).toBeGreaterThan(16);
        for (let at = 0; at < bodyBytes; at++) {
            expect(openEnvelope({ ...sealed, body: flipByte(sealed.body, at) }, { sender: alice.public, keys: [bob] })).toEqual({ ok: false, reason: `signature` });
        }
        for (const at of [0, 11]) {
            expect(verifyEnvelope({ ...sealed, enc: { ...sealed.enc, nonce: flipByte(sealed.enc.nonce, at) } }, alice.public)).toBe(false);
        }
        for (const at of [0, 31]) {
            expect(verifyEnvelope({ ...sealed, enc: { ...sealed.enc, x25519: flipByte(sealed.enc.x25519, at) } }, alice.public)).toBe(false);
        }
        for (const at of [0, 544, 1087]) {
            expect(verifyEnvelope({ ...sealed, enc: { ...sealed.enc, mlkem768: flipByte(sealed.enc.mlkem768, at) } }, alice.public)).toBe(false);
        }
    });

    it("binds the header to the body even under a fresh signature: the decryption itself refuses", () => {
        const options = { sender: alice.public, keys: [bob] };
        expect(openEnvelope(resigned({ ...sealed, thread: `t-2` }), options)).toEqual({ ok: false, reason: `decrypt` });
        expect(openEnvelope(resigned({ ...sealed, hops: 2 }), options)).toEqual({ ok: false, reason: `decrypt` });
        expect(openEnvelope(resigned({ ...sealed, body: flipByte(sealed.body, 0) }), options)).toEqual({ ok: false, reason: `decrypt` });
        expect(openEnvelope(resigned({ ...sealed, enc: { ...sealed.enc, nonce: flipByte(sealed.enc.nonce, 3) } }), options)).toEqual({ ok: false, reason: `decrypt` });
        expect(openEnvelope(resigned({ ...sealed, enc: { ...sealed.enc, x25519: flipByte(sealed.enc.x25519, 3) } }), options)).toEqual({ ok: false, reason: `decrypt` });
        expect(openEnvelope(resigned({ ...sealed, enc: { ...sealed.enc, mlkem768: flipByte(sealed.enc.mlkem768, 3) } }), options)).toEqual({ ok: false, reason: `decrypt` });
    });

    it("does not open under another key set, even one the envelope is relabelled to", () => {
        expect(openEnvelope(resigned({ ...sealed, toFp: mallory.fingerprint }), { sender: alice.public, keys: [mallory] })).toEqual({ ok: false, reason: `decrypt` });
    });

    it("refuses a payload that is not its header's kind when sealing, and one that is no payload when opening", () => {
        expect(() => sealEnvelope({ addressing: { ...addressing, kind: `report` }, payload, sender: alice, recipient: bob.public })).toThrow(
            `s2s envelope: a message payload under a report header`,
        );
        const oversized = sealEnvelope({ addressing, payload: { ...payload, text: `x`.repeat(60_001) }, sender: alice, recipient: bob.public });
        expect(openEnvelope(oversized, { sender: alice.public, keys: [bob] })).toEqual({ ok: false, reason: `malformed` });
    });

    it("carries a kind this build does not know in its header, for the door to refuse by name", () => {
        expect(S2sEnvelopeSchema.safeParse({ ...sealed, kind: `poll.vote` }).success).toBe(true);
    });
});

describe("a self-signed envelope (a stranger's request, its keys inside its body)", () => {
    // What the request's own payload says signed it: the keys of the sandbox the message names in its subject, standing in for
    // a request's embedded document.
    const signerNamed = (signing: S2sPayload): S2sKeySet["public"] | undefined => {
        if (signing.kind !== `message`) {
            return undefined;
        }
        return signing.subject === `alice` ? alice.public : signing.subject === `mallory` ? mallory.public : undefined;
    };
    const asAlice = sealEnvelope({ addressing, payload: { ...payload, subject: `alice` }, sender: alice, recipient: bob.public });

    it("opens when the keys its payload names signed it", () => {
        expect(openSelfSigned(asAlice, [bob], signerNamed)).toEqual({ ok: true, header: expect.objectContaining({ id: asAlice.id }), payload: { ...payload, subject: `alice` } });
    });

    it("refuses as `signature` a body naming keys that did not sign it, or naming none", () => {
        const claimsMallory = sealEnvelope({ addressing, payload: { ...payload, subject: `mallory` }, sender: alice, recipient: bob.public });
        expect(openSelfSigned(claimsMallory, [bob], signerNamed)).toEqual({ ok: false, reason: `signature` });
        expect(openSelfSigned(sealed, [bob], signerNamed)).toEqual({ ok: false, reason: `signature` });
    });

    it("says `recipient` and `decrypt` before it ever reads a signer", () => {
        const never = (): S2sKeySet["public"] => {
            throw new Error(`read a signer for a body that does not open`);
        };
        expect(openSelfSigned(asAlice, [mallory], never)).toEqual({ ok: false, reason: `recipient` });
        expect(openSelfSigned({ ...asAlice, body: flipByte(asAlice.body, 0) }, [bob], never)).toEqual({ ok: false, reason: `decrypt` });
    });
});
