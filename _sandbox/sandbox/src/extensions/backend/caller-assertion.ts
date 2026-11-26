import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { errorMessage } from "@intentic/base/errors";
import { ProofMethodSchema } from "@intentic/sandbox-contract/schemas/system";
import {
    EXTENSION_CALLER_HEADER,
    EXTENSION_CALLER_TTL_MS,
    type ExtensionCallerClaim,
    type ExtensionCallerIdentity,
    readCallerClaim,
} from "@intentic/sandbox-contract/extension-protocol";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { ProvenCaller, Proof } from "../../auth/auth.js";
import { callingExtension } from "../../auth/grants.js";
import { callerFence } from "../../areas/area-scope.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";

// WHO IS CALLING AN EXTENSION'S BACKEND (2026-11-26). The /x/<id> proxy strips every credential before it forwards, so a
// backend heard a bare request and could neither hold a member to their areas nor start a turn as whoever pressed its
// button. Now the proxy attaches an assertion of the caller it verified (EXTENSION_CALLER_HEADER): minted for that one
// extension, signed with a key this daemon run holds only in memory, good for EXTENSION_CALLER_TTL_MS. The backend host
// gets no key, so neither it nor any extension's code can mint one; a restart retires every assertion outstanding.
// POST /agent takes one back beside the extension's own token (callerAtAgentDoor) and starts the turn as that person,
// re-reading their access from the roster then, never from what the assertion says of it.

const key = randomBytes(32);

const sign = (encoded: string): string => createHmac("sha256", key).update(`extension-caller:${encoded}`).digest("base64url");

// The sandbox an assertion is bound to: this one's id, or "local" for a daemon that has none.
const sandboxOf = (services: Pick<Services, "config">): string => sandboxIdFromToken(services.config.connectToken) ?? "local";

/** The assertion of `caller` for one request into `extension`'s backend (its routing id), as the proxy attaches it. */
export const mintCallerAssertion = (
    services: Pick<Services, "config">,
    extension: string,
    caller: ExtensionCallerIdentity,
    proof: readonly string[] | undefined,
    now = Date.now(),
): string => {
    const claim: ExtensionCallerClaim = {
        v: 1,
        sandbox: sandboxOf(services),
        extension,
        issuedAt: now,
        expiresAt: now + EXTENSION_CALLER_TTL_MS,
        nonce: randomBytes(12).toString("base64url"),
        caller,
        ...opt("proof", proof === undefined ? undefined : [...proof]),
    };
    const encoded = Buffer.from(JSON.stringify(claim), "utf8").toString("base64url");
    return `${encoded}.${sign(encoded)}`;
};

/** What a presented assertion comes to: its claim, or why it is refused. */
export type CallerVerdict = { readonly claim: ExtensionCallerClaim } | { readonly refused: string };

// A clock a minute ahead of the one that minted it is still the same daemon; anything further is not this run's.
const SKEW_MS = 60_000;

/**
 * Whether `assertion` was minted by this daemon run for `extension`, in this sandbox, and is inside its window. Signature
 * first, in constant time, so nothing about an unsigned claim is believed or even read further.
 */
export const verifyCallerAssertion = (services: Pick<Services, "config">, assertion: string, extension: string, now = Date.now()): CallerVerdict => {
    const [encoded = "", signature = "", ...rest] = assertion.split(".");
    const expected = Buffer.from(sign(encoded), "utf8");
    const presented = Buffer.from(signature, "utf8");
    if (encoded === "" || rest.length > 0 || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return { refused: "the caller assertion was not minted by this sandbox's daemon" };
    }
    const claim = readCallerClaim(assertion);
    if (claim === undefined) {
        return { refused: "the caller assertion does not read" };
    }
    if (claim.sandbox !== sandboxOf(services)) {
        return { refused: "the caller assertion was minted for another sandbox" };
    }
    if (claim.extension !== extension) {
        return { refused: "the caller assertion was minted for another extension" };
    }
    if (now >= claim.expiresAt || claim.issuedAt > now + SKEW_MS || claim.expiresAt - claim.issuedAt > EXTENSION_CALLER_TTL_MS) {
        return { refused: "the caller assertion is outside its window: ask the person to press again" };
    }
    return { claim };
};

/**
 * Who the request the proxy is about to forward comes from, as the middleware verified it: a person (with the folders
 * their areas come to, read from the area manifest now), a panel, a program's control token, another extension, or
 * nobody signed in on a sandbox without sign-in.
 */
export const callerOfRequest = async (
    services: Pick<Services, "areas" | "auth" | "extensionBackend">,
    c: Context<AppEnv>,
): Promise<{ readonly caller: ExtensionCallerIdentity; readonly proof?: readonly string[] }> => {
    const identity: ProvenCaller | undefined = c.get("identity");
    if (identity !== undefined) {
        const folders = identity.areas === undefined ? undefined : callerFence(await services.areas.list(), identity);
        return {
            caller: {
                kind: "person",
                email: identity.email,
                tier: identity.tier,
                ...opt("name", identity.name),
                ...opt("areas", identity.areas === undefined ? undefined : [...identity.areas]),
                ...opt("folders", folders === undefined ? undefined : [...folders]),
                ...opt("manages", identity.manages === undefined ? undefined : [...identity.manages]),
            },
            proof: identity.methods,
        };
    }
    const principal = c.get("principal");
    if (principal !== undefined) {
        return { caller: { kind: "program", id: principal.id, label: principal.label } };
    }
    const extension = callingExtension(services.extensionBackend.verifyExtensionToken, (name) => c.req.header(name));
    if (extension !== undefined) {
        return { caller: { kind: "extension", id: extension.id } };
    }
    // With sign-in on, what is left that the middleware admitted to /x is the panel token (the agent's and the sync
    // token's reach no /x route); with no sign-in at all, nobody was checked, which is the owner's own machine.
    return { caller: services.auth === undefined ? { kind: "local" } : { kind: "panel" } };
};

/** What POST /agent does with a request's caller assertion: nothing to change, a person to act as, or a refusal. */
export type AgentDoorCaller = { readonly kind: "none" } | { readonly kind: "person"; readonly caller: ProvenCaller } | { readonly refused: string; readonly status: 401 | 403 };

/**
 * At POST /agent: a caller assertion is taken only beside the extension token it was minted for, and only a person's
 * changes who the turn is for. The person's access is read from the roster now (`authorizeProven`), so someone removed
 * or re-graded since the press is held to what they hold now, and the route's own floor is asked for them. A panel's,
 * a program's or another extension's assertion leaves the turn the extension's own, as it was without one.
 */
export const callerAtAgentDoor = async (
    services: Pick<Services, "config" | "auth" | "extensionBackend">,
    header: (name: string) => string | null | undefined,
    floor: (caller: ProvenCaller) => string | undefined,
    now = Date.now(),
): Promise<AgentDoorCaller> => {
    const assertion = header(EXTENSION_CALLER_HEADER) ?? "";
    if (assertion === "") {
        return { kind: "none" };
    }
    const extension = callingExtension(services.extensionBackend.verifyExtensionToken, header);
    if (extension === undefined) {
        return { status: 403, refused: "a caller assertion is taken only from the extension it was minted for, with its own token" };
    }
    const verdict = verifyCallerAssertion(services, assertion, extension.id, now);
    if ("refused" in verdict) {
        return { status: 401, refused: verdict.refused };
    }
    const { caller, proof } = verdict.claim;
    if (caller.kind !== "person") {
        return { kind: "none" };
    }
    if (services.auth === undefined) {
        return { status: 403, refused: "this sandbox runs without sign-in, so no person stands behind the assertion" };
    }
    const methods = ProofMethodSchema.array().safeParse(proof ?? []);
    const asked: Proof = { email: caller.email, methods: methods.success ? methods.data : [], ...opt("name", caller.name) };
    let person: ProvenCaller;
    try {
        person = await services.auth.authorizeProven(asked);
    } catch (error) {
        return { status: 403, refused: `${caller.email} no longer reaches this sandbox (${errorMessage(error)})` };
    }
    const refused = floor(person);
    return refused === undefined ? { kind: "person", caller: person } : { status: 403, refused };
};
