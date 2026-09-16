import { createHmac } from "node:crypto";

// RFC 6238 TOTP minted daemon-side so the seed never leaves the manifest; the agent and terminal get one code at a time
// over GET /capabilities/<id>/otp. Accepts either a bare base32 seed or a full otpauth:// URI, whichever the enrolling
// service showed.

interface TotpParams {
    readonly key: Buffer;
    readonly algorithm: "sha1" | "sha256" | "sha512";
    readonly digits: number;
    readonly period: number;
}

export interface TotpCode {
    readonly code: string;
    // How long this code is still valid; the caller's cue to re-mint rather than submit a dying code.
    readonly secondsRemaining: number;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// RFC 4648 base32, tolerant of lowercase, group spacing, dashes and trailing padding.
const base32Decode = (encoded: string): Buffer => {
    const normalized = encoded.toUpperCase().replaceAll(/[\s-]/g, "").replace(/=+$/, "");
    if (normalized === "") {
        throw new Error("empty TOTP secret");
    }
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const char of normalized) {
        const index = BASE32_ALPHABET.indexOf(char);
        if (index === -1) {
            throw new Error(`not a base32 TOTP secret (unexpected "${char}")`);
        }
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((value >> bits) & 0xff);
        }
    }
    return Buffer.from(bytes);
};

// Bare key defaults to SHA-1/6 digits/30s; an otpauth:// URI's own parameters override those defaults.
const parseSeed = (seed: string): TotpParams => {
    const trimmed = seed.trim();
    if (!trimmed.toLowerCase().startsWith("otpauth://")) {
        return { key: base32Decode(trimmed), algorithm: "sha1", digits: 6, period: 30 };
    }
    const url = new URL(trimmed);
    const secret = url.searchParams.get("secret");
    if (secret === null || secret === "") {
        throw new Error("otpauth URI carries no secret parameter");
    }
    const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
    if (algorithm !== "sha1" && algorithm !== "sha256" && algorithm !== "sha512") {
        throw new Error(`unsupported otpauth algorithm "${algorithm}"`);
    }
    const digits = Number(url.searchParams.get("digits") ?? "6");
    const period = Number(url.searchParams.get("period") ?? "30");
    if (!Number.isInteger(digits) || digits < 6 || digits > 8 || !Number.isInteger(period) || period <= 0) {
        throw new Error("otpauth URI carries invalid digits/period");
    }
    return { key: base32Decode(secret), algorithm, digits, period };
};

// One code for one moment; throws on an unparseable seed rather than answering with a code that cannot be right.
export const totpCode = (seed: string, nowMs: number): TotpCode => {
    const { key, algorithm, digits, period } = parseSeed(seed);
    const seconds = Math.floor(nowMs / 1000);
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(seconds / period)));
    const hash = createHmac(algorithm, key).update(counter).digest();
    // RFC 4226 dynamic truncation: the hash's last nibble picks where the 31-bit code is read.
    const offset = (hash.at(-1) ?? 0) & 0x0f;
    const value = hash.readUInt32BE(offset) & 0x7fffffff;
    return { code: String(value % 10 ** digits).padStart(digits, "0"), secondsRemaining: period - (seconds % period) };
};
