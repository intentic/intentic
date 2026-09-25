import { sandboxRouteAllowed } from "@intentic/extension-manifest";
import { sandboxRouteFor } from "@intentic/sandbox-contract";
import { EXTENSION_TOKEN_HEADER } from "../extensions/backend/backend-host-config.js";
import { tokenEquals } from "./auth.js";
import { type ControlTokens, controlScoped } from "./control-tokens.js";
import type { Principal } from "./principal.js";

// Grants: every credential the daemon accepts instead of the owner's Google bearer, in one table so each fails the same
// way.
// A non-empty header selects a grant and commits the request to it; a bad secret is 401, never a quiet fall-through.
// The empty-string check matters: `tokenEquals("", "")` is true, so an empty secret would authorize every
// unauthenticated request.

export type GrantVerdict = "ok" | "unauthorized" | "out-of-scope";

// What a grant answers.
// `principal` rides only on an admission from a grant whose credential names a party; a per-boot secret admits a
// process and says nothing more.
export type GrantOutcome = { readonly verdict: "ok"; readonly principal?: Principal } | { readonly verdict: "unauthorized" | "out-of-scope" };

const OK: GrantOutcome = { verdict: "ok" };
const UNAUTHORIZED: GrantOutcome = { verdict: "unauthorized" };
const OUT_OF_SCOPE: GrantOutcome = { verdict: "out-of-scope" };

export interface Grant {
    // The header the holder presents its secret in.
    readonly header: string;
    // How a refusal names it (e.g. "sync token"): the credential's name, not the header's.
    readonly name: string;
    readonly authorize: (presented: string, method: string, path: string) => Promise<GrantOutcome>;
}

// The shape the panel and agent grants share: one secret fixed for the daemon's lifetime, one declared reach.
// Scope is checked before the secret on purpose: a wrong-route holder should be told which failure it is, not just
// "your token is wrong".
const fixedSecretGrant = (header: string, name: string, reaches: (method: string, path: string) => boolean, secret: string): Grant => ({
    header,
    name,
    authorize: async (presented, method, path) => {
        if (!reaches(method, path)) {
            return OUT_OF_SCOPE;
        }
        return tokenEquals(presented, secret) ? OK : UNAUTHORIZED;
    },
});

// Every route-scoped grant's reach is declared on the routes themselves (sandbox-contract route-meta.ts) and resolved
// by the one route matcher, so no allowlist here can drift from the surface it guards.
const declared = (method: string, path: string) => sandboxRouteFor(method, path)?.meta;

// The vpn/otp/capabilities/wallet/sandboxes/agents/secrets CLIs on the agent's PATH, over loopback with the per-boot
// agent token: operate what is configured, ask for what is not, never read a credential's value.
const agentReach = (method: string, path: string): boolean => declared(method, path)?.agent === true;

// Broad on purpose (a repo's operator panel is an open-ended app), except the routes that hand back or put in motion a
// stored credential (`panel: false`); an allowlist here would be fiction. Extension processes hold their own
// per-extension token instead, never this one.
const panelReach = (method: string, path: string): boolean => declared(method, path)?.panel !== false;

// What a per-extension token resolves to: the extension, its manifest's `permissions.daemon`, and the provider its
// `contributes.listener` names, if any. Minted once per extension for its backend and its processes alike.
export interface ExtensionGrant {
    readonly id: string;
    readonly permissions: readonly string[];
    readonly listener?: string;
}

// The four listener routes, by the provider segment; compared whole and decoded, never as a glob, since a provider name
// comes from a manifest and may hold anything a glob would widen on.
const LISTENER_ROUTE = /^\/listeners\/([^/]+)\/(?:state|dispatch|failure|status)$/;

// The provider a listener route addresses: undefined for any other path, "" for a segment that does not decode (which
// no manifest can name).
const listenerProviderOf = (path: string): string | undefined => {
    const segment = LISTENER_ROUTE.exec(path.split("?")[0] ?? path)?.[1];
    if (segment === undefined) {
        return undefined;
    }
    try {
        return decodeURIComponent(segment);
    } catch {
        return "";
    }
};

// An extension that declares a listener reaches that provider's listener routes without listing them in
// `permissions.daemon`: running the gateway is what declaring the provider asked for. Another provider's are never in
// reach, whatever the manifest globs, since /state hands back that provider's stored credentials.
const extensionReach = (grant: ExtensionGrant, method: string, path: string): boolean => {
    const provider = listenerProviderOf(path);
    if (provider !== undefined) {
        return provider !== "" && grant.listener === provider && declared(method, path) !== undefined;
    }
    return sandboxRouteAllowed(grant.permissions, method, path);
};

// Which extension is asking, for the routes that answer only an extension and only about what is its own (the listener
// routes, the connection read). Resolved from the header in the handler rather than trusted from the middleware, so the
// check holds on a loopback daemon too, where no grant middleware runs.
export const callingExtension = (
    verifyExtension: GrantSources["verifyExtension"],
    header: (name: string) => string | null | undefined,
): ExtensionGrant | undefined => {
    const presented = header(EXTENSION_TOKEN_HEADER);
    return presented === undefined || presented === null || presented === "" ? undefined : verifyExtension(presented);
};

// The grant loop: a non-empty header selects a grant and commits the request to it, the first grant whose header is
// present answers.
// `undefined` means no grant header was presented at all, so the caller falls through to the bearer path.
export type GrantAdmission = { readonly admitted: true; readonly principal?: Principal } | { readonly admitted: false; readonly status: 401 | 403; readonly error: string };

export const admitByGrant = async (
    grants: readonly Grant[],
    header: (name: string) => string | undefined,
    method: string,
    path: string,
): Promise<GrantAdmission | undefined> => {
    for (const grant of grants) {
        const presented = header(grant.header);
        if (presented === undefined || presented === "") {
            continue;
        }
        const outcome = await grant.authorize(presented, method, path);
        if (outcome.verdict === "ok") {
            return outcome.principal === undefined ? { admitted: true } : { admitted: true, principal: outcome.principal };
        }
        // Out of scope is its own answer: the right credential on the wrong route reads "not for this route", not 401.
        return outcome.verdict === "out-of-scope"
            ? { admitted: false, status: 403, error: `${grant.name} not valid for this route` }
            : { admitted: false, status: 401, error: "unauthorized" };
    }
    return undefined;
};

export interface GrantSources {
    readonly panelToken: string;
    readonly agentToken: string;
    readonly controlTokens: ControlTokens;
    // Passed in rather than imported, so this module stays free of platform/ and is testable with a one-line fake.
    // `checkedIn` is true only for the watcher's poll, not the transport; only the poll refreshes the heartbeat.
    readonly verifySync: (presented: string, checkedIn: boolean) => Promise<boolean>;
    // An extension token resolves to its extension's grant; unknown token means 401.
    readonly verifyExtension: (presented: string) => ExtensionGrant | undefined;
}

export const grantsOf = ({ panelToken, agentToken, controlTokens, verifySync, verifyExtension }: GrantSources): readonly Grant[] => [
    fixedSecretGrant("x-intentic-panel", "panel token", panelReach, panelToken),
    fixedSecretGrant("x-intentic-agent", "agent token", agentReach, agentToken),
    {
        // An extension's daemon reach, its backend's and its processes' alike: the minted per-extension token resolves
        // to the manifest's `permissions.daemon`, in the same glob grammar the UI half's `permissions.sandbox` uses, plus
        // its own listener provider's routes. So its reach is a declared, reviewable list rather than the all-routes
        // grant a panel token gets.
        header: EXTENSION_TOKEN_HEADER,
        name: "extension token",
        authorize: async (presented, method, path) => {
            const grant = verifyExtension(presented);
            if (grant === undefined) {
                return UNAUTHORIZED;
            }
            return extensionReach(grant, method, path) ? OK : OUT_OF_SCOPE;
        },
    },
    {
        header: "x-intentic-control",
        name: "control token",
        authorize: async (presented, method, path) => {
            // Resolve before scoping, unavoidably: a control token's reach is stored with it, so there's no scope to
            // check until the token is known.
            // The inversion leaks less too: an unknown token gets the same answer for every route instead of revealing
            // which ones exist.
            const token = await controlTokens.resolve(presented);
            if (token === undefined) {
                return UNAUTHORIZED;
            }
            if (!controlScoped(token.scope, method, path)) {
                return OUT_OF_SCOPE;
            }
            // Do not let a failed token touch reject an otherwise valid request.
            await controlTokens.touch(token.id).catch(() => undefined);
            return { verdict: "ok", principal: { kind: "control", id: token.id, label: token.label, scope: token.scope } };
        },
    },
    {
        // The desktop-sync agent's token lives on a laptop, so its reach is what a stolen laptop reaches: the routes
        // that declare `sync`, and nothing else.
        header: "x-intentic-sync",
        name: "sync token",
        authorize: async (presented, method, path) => {
            const sync = declared(method, path)?.sync;
            if (sync === undefined) {
                return OUT_OF_SCOPE;
            }
            // Mutagen holds the transport pipe open regardless; only a poll is a check-in that refreshes the heartbeat.
            return (await verifySync(presented, sync === "poll")) ? OK : UNAUTHORIZED;
        },
    },
];
