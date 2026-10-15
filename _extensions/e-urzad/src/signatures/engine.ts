import { DOMImplementation, DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { CryptoEngine, setEngine } from "pkijs";
import { Application, setNodeDependencies } from "xadesjs";
import xpath from "xpath";
import { z } from "zod";

// The libraries do the cryptography; this module only points them at Node's WebCrypto and at an XML DOM, once, before
// anything is verified. PKI.js keeps its engine on the process global, xadesjs on its Application, and xml-core (under
// xadesjs) resolves DOMParser, XMLSerializer and xpath through setNodeDependencies when no browser globals exist.

// Node's global WebCrypto (the same object as node:crypto's webcrypto), typed as the standard interface.
const crypto: Crypto = globalThis.crypto;

let ready = false;

export const ensureCryptoEngines = (): void => {
    if (ready) {
        return;
    }
    setEngine("node-webcrypto", new CryptoEngine({ name: "node-webcrypto", crypto }));
    Application.setEngine("node-webcrypto", crypto);
    setNodeDependencies({ DOMParser, XMLSerializer, DOMImplementation, xpath });
    ready = true;
};

export const subtle = (): SubtleCrypto => crypto.subtle;

// A WebCrypto digest name for the hash OIDs and XML DigestMethod URIs a signature may name; undefined for one this
// verifier does not take (MD5, or anything unknown), which the caller reports as unsupported rather than guessing.
const HASHES: ReadonlyMap<string, string> = new Map([
    ["1.3.14.3.2.26", "SHA-1"],
    ["2.16.840.1.101.3.4.2.1", "SHA-256"],
    ["2.16.840.1.101.3.4.2.2", "SHA-384"],
    ["2.16.840.1.101.3.4.2.3", "SHA-512"],
    ["http://www.w3.org/2000/09/xmldsig#sha1", "SHA-1"],
    ["http://www.w3.org/2001/04/xmlenc#sha256", "SHA-256"],
    ["http://www.w3.org/2001/04/xmldsig-more#sha384", "SHA-384"],
    ["http://www.w3.org/2001/04/xmlenc#sha512", "SHA-512"],
]);

export const hashNameOf = (identifier: string): string | undefined => HASHES.get(identifier);

export const digest = async (hash: string, bytes: Uint8Array): Promise<Uint8Array> => new Uint8Array(await subtle().digest(hash, toArrayBuffer(bytes)));

// A fresh ArrayBuffer holding exactly these bytes: PKI.js and WebCrypto take ArrayBuffer, and a Uint8Array may be a view
// into a larger (or shared) buffer.
export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
};

export const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
    left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const WithMessage = z.object({ message: z.string() });

// What went wrong, in words: xml-core's XmlError is not an Error subclass, so `instanceof Error` alone loses its text.
export const causeText = (cause: unknown): string => {
    const parsed = WithMessage.safeParse(cause);
    return parsed.success && parsed.data.message !== "" ? parsed.data.message : String(cause);
};
