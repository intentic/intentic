import { createHash, verify } from "node:crypto";
import { z } from "zod";
import { entriesFor } from "@intentic/sandbox-contract/policy/keyring-origins";
import { keyFingerprint, seal } from "@intentic/sandbox-contract/keyring-seal";
import { KEYRING_GRANT_TTL_MAX_MS, type KeyringPhoneFill, KeyringPhoneFillSchema, type KeyringPhoneKeys, type SignedKeyringPhoneFill } from "@intentic/sandbox-contract/schemas/keyring";
import { type Answer, NOT_SET_UP, refuse, type VaultAccess } from "./access.js";
import { candidateOf, entryInfoOf, liveEntries, placeWords, titleOf, usedEntry, withEntry } from "./entries.js";
import { hostOf, NonceBook, sandboxKey } from "../policy.js";
import type { Refusal } from "../protocol.js";
import type { PhonePin } from "../vault.js";

// THE OWNER'S PHONE as a place to fill from: paired once at the person's yes here, the prompt showing the fingerprint of
// the phone's presence key so the person can compare it with the phone's screen, then filling Android's autofill with
// requests that key signed. The presence key signs only after the person's fingerprint, face or screen lock
// (Keystore's user-authentication requirement), so a signature that verifies against the key pinned at pairing IS the
// person's yes, as a Windows Hello signature is: nobody is asked at this computer. The value goes back sealed to the
// phone's own key for that request's nonce, through the sandbox, which carries only ciphertext.

// A phone's clock may run a little ahead, as a sandbox's may.
const SKEW_MS = 30_000;

/** The presence key's fingerprint as both screens show it: SHA-256 of its DER, the first 8 bytes in groups of four. */
export const presenceFingerprint = (presence: string): string =>
    createHash("sha256")
        .update(Buffer.from(presence, "base64"))
        .digest()
        .subarray(0, 8)
        .toString("hex")
        .toUpperCase()
        .replace(/(.{4})(?=.)/gu, "$1-");

type Checked = { readonly ok: true; readonly fill: KeyringPhoneFill } | Refusal;

/** A fill request, if the pinned presence key signed it, it is recent and its life is short. Pure but for the clock given. */
export const checkPhoneFill = (signed: SignedKeyringPhoneFill, pin: PhonePin | undefined, now: number): Checked => {
    let payload: Buffer;
    let json: unknown;
    try {
        payload = Buffer.from(signed.payload, "base64url");
        json = JSON.parse(payload.toString("utf8"));
    } catch {
        return refuse("bad-grant", "The phone's request could not be read.");
    }
    const parsed = KeyringPhoneFillSchema.safeParse(json);
    if (!parsed.success) {
        return refuse("bad-grant", "The phone's request is not one this keyring reads.");
    }
    const fill = parsed.data;
    if (pin === undefined || pin.keys.device !== fill.device) {
        return refuse("not-shared", "This phone is not paired with Passwords on this computer: pair it from the phone first.");
    }
    let good = false;
    try {
        good = verify("sha256", payload, { key: Buffer.from(pin.keys.presence, "base64"), format: "der", type: "spki" }, Buffer.from(signed.sig, "base64url"));
    } catch {
        good = false;
    }
    if (!good) {
        return refuse("bad-grant", "The phone's request was not signed by the key pinned when it was paired.");
    }
    if (fill.expiresAt <= fill.issuedAt || fill.expiresAt - fill.issuedAt > KEYRING_GRANT_TTL_MAX_MS || fill.issuedAt > now + SKEW_MS) {
        return refuse("bad-grant", "The phone's request has times no phone would sign.");
    }
    if (fill.expiresAt <= now) {
        return refuse("expired", "The phone's request has expired: fill again on the phone.");
    }
    return { ok: true, fill };
};

export class Phones {
    readonly #nonces = new NonceBook();

    constructor(private readonly vault: VaultAccess) {}

    async pair(sandbox: string, phone: KeyringPhoneKeys): Answer<"phone-pair"> {
        const file = this.vault.file();
        if (file === undefined) {
            return refuse("no-keyring", NOT_SET_UP);
        }
        const opened = await this.vault.open(file, {
            title: `Pair ${phone.label} with Passwords?`,
            message: `${phone.label} (through ${hostOf(sandbox)}) asks to save passwords to this computer and fill them back after your fingerprint on the phone. The phone's key is ${presenceFingerprint(phone.presence)}: say yes only if the phone shows the same.`,
            person: true,
        });
        if ("ok" in opened) {
            return opened;
        }
        const now = this.vault.deps.now();
        const phones = { ...opened.doc.phones, [phone.device]: { keys: phone, sandbox: sandboxKey(sandbox), pairedAt: now } };
        await this.vault.commit({ doc: { ...opened.doc, phones }, key: opened.key });
        await this.vault.record({ op: "phone-pair", outcome: "done", target: phone.device, sandbox, asked: true });
        return { ok: true, fingerprint: keyFingerprint(opened.doc.inbox.publicKey) };
    }

    // No prompt here: the phone's signature is the person's yes. The value is in the vault, so only an unlocked one fills.
    async fill(sandbox: string, signed: SignedKeyringPhoneFill): Answer<"phone-fill"> {
        const held = this.vault.held();
        if (this.vault.file() === undefined) {
            return refuse("no-keyring", NOT_SET_UP);
        }
        if (held === undefined) {
            return refuse("locked", "Passwords is locked on this computer: unlock it there to fill from the phone.");
        }
        const now = this.vault.deps.now();
        const checked = checkPhoneFill(signed, held.doc.phones?.[decodeDevice(signed)], now);
        if (!checked.ok) {
            await this.vault.record({ op: "phone-fill", outcome: "refused", code: checked.code, sandbox });
            return checked;
        }
        const fill = checked.fill;
        if (!this.#nonces.spend(fill.nonce, fill.expiresAt, now)) {
            return refuse("replayed", "This request was answered already: fill again on the phone.");
        }
        const pin = held.doc.phones?.[fill.device];
        const match = entriesFor(liveEntries(held.doc).map((entry) => candidateOf(entryInfoOf(entry))), fill.origin, fill.username)[0];
        const entry = match === undefined ? undefined : held.doc.entries[match.name];
        if (entry === undefined || pin === undefined) {
            return refuse("unknown", `Nothing is saved on this computer for ${placeWords(fill.origin)}.`);
        }
        const value = await this.vault.valueOf(held.doc, entry);
        if (!value.ok) {
            return value;
        }
        const sealed = seal(pin.keys.seal, value.value, { kind: "phone", device: fill.device, nonce: fill.nonce });
        await this.vault.commit({ doc: withEntry(held.doc, usedEntry(entry, now)), key: held.key });
        await this.vault.record({ op: "phone-fill", outcome: "granted", secret: entry.name, target: fill.device, sandbox, how: "phone" });
        const answer: Extract<Awaited<Answer<"phone-fill">>, { ok: true }> = { ok: true, sealed, name: entry.name, title: titleOf(entryInfoOf(entry)) };
        if (entry.rules.username !== undefined) {
            answer.username = entry.rules.username;
        }
        return answer;
    }
}

// The device the request names, read only to pick the pin that then checks it.
const decodeDevice = (signed: SignedKeyringPhoneFill): string => {
    try {
        // Not a pick of the strict schema, which would keep its strictness and refuse the request's other fields.
        const parsed = z.object({ device: z.string() }).safeParse(JSON.parse(Buffer.from(signed.payload, "base64url").toString("utf8")));
        return parsed.success ? parsed.data.device : "";
    } catch {
        // allow(silent-catch): a payload that is not JSON names no device, and checkPhoneFill refuses it as unreadable
        return "";
    }
};
