import { lookup, resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import { resolveAddress, type ResolvedAddress, TXT_MISSING_CODES, type TxtAnswer } from "@intentic/sandbox-contract/s2s";
import type { z } from "zod";
import { readBounded, TIMEOUT_MS } from "../server/transport.js";

/* HOW THIS SANDBOX REACHES ANOTHER ONE: its address resolved the way the s2s layer does (the `_intentic.<domain>` TXT
   record, then GET https://<host>/s2s/identity, verified), and JSON read from or posted to that sandbox's Network doors.
   Only public hosts: nothing here fetches a loopback, private, link-local or carrier-grade NAT address, a name without a
   dot, or one under a local suffix, so a stranger naming an address (a witness request, a guide result) cannot point
   this sandbox at its own network. The dev switch the s2s suites run with (`S2S_PRIVATE_HOSTS`) lifts that. One seam,
   so every caller is tested with a fake. */

type Json = z.core.util.JSONType;

export const DOOR_PREFIX = `/door/intentic.network`;
const BODY_LIMIT = 4 * 1024 * 1024;

export interface PeerAnswer {
    readonly status: number;
    readonly body: Json | undefined;
}

export interface PeerNet {
    readonly resolve: (address: string) => Promise<ResolvedAddress>;
    // GET https://<host><path>: the JSON answered, and its status (a 404 is an answer, not a failure).
    readonly get: (host: string, path: string, signal: AbortSignal) => Promise<PeerAnswer>;
    readonly post: (host: string, path: string, body: Json, signal: AbortSignal) => Promise<PeerAnswer>;
}

const LOCAL_SUFFIXES = [`.local`, `.internal`, `.lan`, `.home.arpa`, `.localhost`];

// Whether an IPv4 or IPv6 address is one this sandbox must not be pointed at.
const privateAddress = (address: string): boolean => {
    if (isIP(address) === 6) {
        const lower = address.toLowerCase();
        return lower === `::1` || lower === `::` || lower.startsWith(`fc`) || lower.startsWith(`fd`) || lower.startsWith(`fe80`) || lower.startsWith(`::ffff:`);
    }
    const [a = 0, b = 0] = address.split(`.`).map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
};

// Why a host may not be fetched, or undefined when it may: by its name, then by every address it resolves to.
const hostProblem = async (host: string): Promise<string | undefined> => {
    if (process.env[`S2S_PRIVATE_HOSTS`] === `1`) {
        return undefined;
    }
    const name = host.replace(/:\d+$/u, ``).toLowerCase();
    if (isIP(name) !== 0) {
        return privateAddress(name) ? `${host} is a private address` : undefined;
    }
    if (!name.includes(`.`) || name === `localhost` || LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
        return `${host} is not a public host`;
    }
    const addresses = await lookup(name, { all: true });
    return addresses.some((entry) => privateAddress(entry.address)) ? `${host} resolves to a private address` : undefined;
};

const txtOf = async (name: string): Promise<TxtAnswer> => {
    try {
        return { kind: `records`, records: await resolveTxt(name) };
    } catch (error) {
        const code = error instanceof Error && `code` in error ? String(error.code) : ``;
        return TXT_MISSING_CODES.includes(code) ? { kind: `missing` } : { kind: `failed`, error: error instanceof Error ? error.message : `lookup failed` };
    }
};

export const createPeerNet = (fetcher: typeof fetch = fetch): PeerNet => {
    const call = async (host: string, path: string, init: RequestInit, signal: AbortSignal): Promise<PeerAnswer> => {
        const problem = await hostProblem(host);
        if (problem !== undefined) {
            throw new Error(problem);
        }
        const scheme = process.env[`S2S_PRIVATE_HOSTS`] === `1` && /^(?:localhost|127\.)/u.test(host) ? `http` : `https`;
        const response = await fetcher(`${scheme}://${host}${path}`, { ...init, redirect: `error`, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
        const text = await readBounded(response, BODY_LIMIT);
        let body: Json | undefined;
        try {
            body = text === `` ? undefined : JSON.parse(text);
        } catch {
            // allow(silent-catch): an answer that is not JSON is no answer to read; the caller sees the status alone
            body = undefined;
        }
        return { status: response.status, body };
    };
    return {
        resolve: (address) =>
            resolveAddress(address, {
                resolveTxt: txtOf,
                fetchIdentity: async (host) => {
                    try {
                        // allow(contract-paths): read from ANOTHER sandbox's host, which no typed client of this daemon reaches
                        const answer = await call(host, `/s2s/identity`, { method: `GET` }, AbortSignal.timeout(TIMEOUT_MS));
                        return answer.status === 200 && answer.body !== undefined ? { ok: true, body: answer.body } : { ok: false, status: answer.status, error: `HTTP ${answer.status}` };
                    } catch (error) {
                        return { ok: false, error: error instanceof Error ? error.message : `unreachable` };
                    }
                },
            }),
        get: (host, path, signal) => call(host, path, { method: `GET`, headers: { accept: `application/json` } }, signal),
        post: (host, path, body, signal) => call(host, path, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) }, signal),
    };
};
