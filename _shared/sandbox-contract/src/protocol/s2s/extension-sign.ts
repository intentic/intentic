import type { z } from "zod";
import type { HybridSig, S2sSigningKeys } from "../../schemas/s2s-identity.js";
import { canonicalBytes } from "./canonical.js";
import { hybridSign, hybridVerify, type SigningSecret } from "./sign.js";

// EXTENSION SIGN DOMAINS (2026-11-28, docs/architecture/messages.md "Identity"): an extension may have this sandbox sign
// a record as itself (`permissions.identity: ["sign"]`, POST /extension/identity/sign), and never holds the key. Each
// signature names the extension and what the record is for, `ext:<publisher.name>/<purpose>`, behind the same prefix as
// the core's own (`intentic-s2s/1 <domain>\n`). The core's domains are single words with no `:` or `/`, and a domain
// ends at the newline, so the bytes an extension's signature covers can never be the bytes of an identity document,
// a vouch, an envelope or a session: no extension signature verifies as one.

// An extension's id as its manifest makes it, `publisher.name`, each half as the manifest's own pattern allows.
export const EXTENSION_SIGN_EXTENSION = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/u;
// What the record is for, as the extension names it: a lowercase word of up to 64 characters, dots and dashes inside.
export const EXTENSION_SIGN_PURPOSE = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
// The most canonical-JSON bytes one signing covers. The door refuses a larger payload (413); a record that big should
// sign a digest of itself instead.
export const EXTENSION_SIGN_PAYLOAD_MAX_BYTES = 256 * 1024;

declare const extensionSignDomainBrand: unique symbol;
// A domain made by extensionSignDomain, so one is never spelled by hand past its checks. The core's four (sign.ts
// SignDomain) stay a closed union beside it.
export type ExtensionSignDomain = `ext:${string}/${string}` & { readonly [extensionSignDomainBrand]: true };

// What a signed record is: any JSON value, signed as its canonical bytes.
export type ExtensionSignPayload = z.infer<ReturnType<typeof z.json>>;

// Why an extension id or a purpose is no part of a domain, or undefined when both are.
export const extensionSignProblem = (extension: string, purpose: string): string | undefined => {
    if (!EXTENSION_SIGN_EXTENSION.test(extension)) {
        return `"${extension}" is not an extension id (publisher.name, each a lowercase word)`;
    }
    if (!EXTENSION_SIGN_PURPOSE.test(purpose)) {
        return `"${purpose}" is not a signing purpose: a lowercase word of up to 64 characters, dots and dashes inside`;
    }
    return undefined;
};

// `ext:<extension>/<purpose>`. Throws a TypeError naming what is wrong with either half.
export const extensionSignDomain = (extension: string, purpose: string): ExtensionSignDomain => {
    const problem = extensionSignProblem(extension, purpose);
    if (problem !== undefined) {
        throw new TypeError(`extension sign domain: ${problem}`);
    }
    // SAFETY: both halves passed the checks above, which is what the brand stands for.
    return `ext:${extension}/${purpose}` as ExtensionSignDomain;
};

// The two halves of a domain read off the wire, or undefined for anything extensionSignDomain would not have made.
export const extensionSignDomainParts = (domain: string): { readonly extension: string; readonly purpose: string } | undefined => {
    const match = /^ext:([^/]+)\/(.+)$/u.exec(domain);
    const [, extension = "", purpose = ""] = match ?? [];
    return match !== null && extensionSignProblem(extension, purpose) === undefined ? { extension, purpose } : undefined;
};

// This extension's hybrid signature over the payload's canonical JSON, for this purpose. Throws on a bad id or purpose
// and on a payload JSON cannot carry exactly.
export const signExtensionPayload = (extension: string, purpose: string, payload: ExtensionSignPayload, secret: SigningSecret): HybridSig =>
    hybridSign(extensionSignDomain(extension, purpose), canonicalBytes(payload), secret);

// True only when `sig` is these keys' signature over the payload's canonical JSON for this extension and purpose; a bad
// id or purpose, a payload that is not JSON and any malformed part are false.
export const verifyExtensionPayload = (extension: string, purpose: string, payload: ExtensionSignPayload, sig: HybridSig, keys: S2sSigningKeys): boolean => {
    if (extensionSignProblem(extension, purpose) !== undefined) {
        return false;
    }
    let bytes: Uint8Array;
    try {
        bytes = canonicalBytes(payload);
    } catch {
        // allow(silent-catch): a value JSON cannot carry was never signed, so it verifies nothing
        return false;
    }
    return hybridVerify(extensionSignDomain(extension, purpose), bytes, sig, keys);
};
