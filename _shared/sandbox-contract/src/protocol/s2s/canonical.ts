import { z } from "zod";

// The bytes every s2s signature and key derivation is over, and the encodings keys and signatures travel in. Pure
// functions on Uint8Array, no Buffer and no node:crypto, so they read the same under Node, Bun and a browser.

const JsonSchema = z.json();
type Json = z.infer<typeof JsonSchema>;

const byKey = ([a]: readonly [string, Json], [b]: readonly [string, Json]): number => (a < b ? -1 : a > b ? 1 : 0);

const serialize = (value: Json): string => {
    if (Array.isArray(value)) {
        return `[${value.map((item) => serialize(item)).join(",")}]`;
    }
    if (value === null || !(value instanceof Object)) {
        return JSON.stringify(value);
    }
    // Sorted by UTF-16 code units, JSON.stringify's own string order (RFC 8785).
    const members = Object.entries(value).toSorted(byKey);
    return `{${members.map(([key, member]) => `${JSON.stringify(key)}:${serialize(member)}`).join(",")}}`;
};

// One spelling per value: keys sorted at every depth, no whitespace, numbers and strings as JSON.stringify writes them.
// Throws on anything JSON cannot carry exactly (undefined, even as a member: leave the key out; NaN; the infinities), since
// each would sign a value other than the one meant.
export const canonicalJson = <T>(value: T): string => {
    const parsed = JsonSchema.safeParse(value);
    if (!parsed.success) {
        throw new TypeError("canonical JSON: the value is not JSON (an undefined, a NaN or an infinity in it?)");
    }
    return serialize(parsed.data);
};

const encoder = new TextEncoder();
export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

// The canonical JSON's UTF-8 bytes: what is signed and hashed.
export const canonicalBytes = <T>(value: T): Uint8Array => utf8(canonicalJson(value));

export const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

export const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
    if (left.length !== right.length) {
        return false;
    }
    let diff = 0;
    for (let index = 0; index < left.length; index++) {
        diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
    }
    return diff === 0;
};

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_INDEX = new Map([...BASE64URL].map((char, index) => [char, index]));

// Base64url (RFC 4648 §5), no padding.
export const toBase64Url = (bytes: Uint8Array): string => {
    let out = "";
    for (let at = 0; at < bytes.length; at += 3) {
        const chunk = ((bytes[at] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0);
        const chars = Math.min(4, Math.ceil(((bytes.length - at) * 8) / 6));
        for (let index = 0; index < chars; index++) {
            out += BASE64URL[(chunk >> (18 - index * 6)) & 63];
        }
    }
    return out;
};

// The bytes of a base64url string, or undefined for anything but the one spelling toBase64Url gives them: no padding, no
// other alphabet, and no stray bits in the last character, so two strings never stand for the same bytes.
export const fromBase64Url = (text: string): Uint8Array | undefined => {
    if (text.length % 4 === 1) {
        return undefined;
    }
    const out = new Uint8Array(Math.floor((text.length * 6) / 8));
    let buffer = 0;
    let bits = 0;
    let at = 0;
    for (const char of text) {
        const value = BASE64URL_INDEX.get(char);
        if (value === undefined) {
            return undefined;
        }
        buffer = ((buffer << 6) | value) & 0xffffff;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[at++] = (buffer >> bits) & 0xff;
        }
    }
    return (buffer & ((1 << bits) - 1)) === 0 ? out : undefined;
};

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

// Base32 (RFC 4648 §6), lowercase, no padding: what a fingerprint is spelled in, so a person can read it aloud.
export const toBase32 = (bytes: Uint8Array): string => {
    let out = "";
    let buffer = 0;
    let bits = 0;
    for (const byte of bytes) {
        buffer = ((buffer << 8) | byte) & 0xffff;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out += BASE32[(buffer >> bits) & 31];
        }
    }
    return bits > 0 ? out + BASE32[(buffer << (5 - bits)) & 31] : out;
};
