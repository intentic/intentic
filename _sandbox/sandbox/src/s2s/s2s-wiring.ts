import { isIP } from "node:net";
import { errorMessage } from "@intentic/base/errors";
import { parseJsonOr } from "@intentic/base/json";
import { LOCAL_LABEL } from "@intentic/sandbox-contract/ids/hostnames";
import type { FetchedIdentity } from "@intentic/sandbox-contract/s2s";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { principalsOf } from "../access/principal-chain.js";
import { rosterReader } from "../auth/members/member-caller.js";
import { isPublicAddress } from "../capabilities/mcp-oauth/oauth-fetch.js";
import type { Services } from "../composition.js";
import { readBoundedText } from "../http/bounded-body.js";
import type { AskerDeps } from "./askers.js";
import type { S2sFetch } from "./messages/outbox.js";

// The s2s service wired to this daemon: the base URL a sandbox host answers on, its identity fetched over the network, and
// who asks at a route as the roster and the principal chain say.

const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u;
const IDENTITY_FETCH_MS = 15_000;
// An identity document is a few kilobytes (two post-quantum keys, sixteen domains at most): anything past this is not one.
export const IDENTITY_BODY_MAX = 64 * 1024;

// Names only a local network, this machine or a cloud's own resolver answers.
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"] as const;

/**
 * Why a host is no address the sandbox-to-sandbox layer fetches from or posts to, or undefined when it is a public one: an
 * IP literal outside the public ranges (loopback, private, carrier-grade NAT, link-local and cloud metadata), `localhost`,
 * a name with no dot or under a local network's suffix, or under this platform's `local.<zone>`, which every resolver
 * answers with 127.0.0.1. Read off the name alone: a public name whose DNS answers a private address is not caught here.
 */
export const hostProblem = (host: string, zone: string | undefined): string | undefined => {
    const name = host.replace(/:\d+$/u, "").toLowerCase();
    if (isIP(name) !== 0) {
        return isPublicAddress(name) ? undefined : "it is a loopback, private or link-local address";
    }
    if (name === "localhost" || !name.includes(".") || LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
        return "it is a name only a local network answers";
    }
    return zone !== undefined && zone !== "" && name.endsWith(`.${LOCAL_LABEL}.${zone}`) ? "it is this platform's name for 127.0.0.1" : undefined;
};

/** The base URL a sandbox host answers on: https, or http for a loopback daemon (a local or a test one). */
export const hostUrl = (host: string): string => `${LOOPBACK.test(host) ? "http" : "https"}://${host}`;

/**
 * GET <host>/s2s/identity with a fetch of the caller's: the JSON it answered, or why not. Never follows a redirect, never
 * asks a host `problem` refuses (hostProblem, absent only behind the private-hosts switch), and reads at most
 * IDENTITY_BODY_MAX bytes of the answer.
 */
export const identityFetcher =
    (fetcher: S2sFetch, urlOf: (host: string) => string = hostUrl, problem: (host: string) => string | undefined = () => undefined) =>
    async (host: string): Promise<FetchedIdentity> => {
        const refused = problem(host);
        if (refused !== undefined) {
            return { ok: false, status: 403, error: `${host} is no address this sandbox fetches from: ${refused}` };
        }
        try {
            const response = await fetcher(`${urlOf(host)}${rawRouteUrl("GET /s2s/identity")}`, { redirect: "error", signal: AbortSignal.timeout(IDENTITY_FETCH_MS) });
            if (!response.ok) {
                // allow(silent-catch): the status is the answer; a body that does not drain changes nothing.
                await response.body?.cancel().catch(() => undefined);
                return { ok: false, status: response.status, error: `it answered ${response.status}` };
            }
            const read = await readBoundedText(response, IDENTITY_BODY_MAX);
            if (read.kind === "tooLarge") {
                return { ok: false, error: `its identity is larger than ${IDENTITY_BODY_MAX / 1024} KiB, which no identity document is` };
            }
            return { ok: true, body: read.kind === "ok" ? parseJsonOr(read.value, null) : null };
        } catch (error) {
            return { ok: false, error: errorMessage(error) };
        }
    };

/** Who asks at a route, as this daemon's roster and principal chains say. */
export const askerDepsOf = (services: Pick<Services, "agents" | "ownerEmail" | "members">): AskerDeps => {
    const roster = rosterReader(() => services);
    return {
        // The people its principal chain names, as account-routing/who-asks.ts peopleFor reads them.
        peopleOf: (conversationId) => principalsOf((id) => services.agents.entry(id), conversationId).people,
        ownerEmail: () => services.ownerEmail(),
        tierOf: async (email) => (await roster()).callerOf(email)?.tier,
    };
};
