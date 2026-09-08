import { randomUUID } from "node:crypto";
import { type MintedProvider, type MintedVariant, mintedVariant } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { MintedStore } from "./minted-credentials.js";

// Sign-in flow shared by every minted provider: the vendor's token isn't an inference credential, so a driver's real
// job is minting the vendor's own API key from it and handing back a card in the meantime. Handshake, expiry,
// cancellation, pasted-address parsing, state check, store write and logging all live here once. `start` returns once
// there's a page to open; the poll/mint/write continue as a floating promise.

// What a sign-in produces: the vendor's own API key, and whatever it managed to learn about whose it is.
export interface MintedCredential {
    readonly apiKey: string;
    readonly email?: string;
}

// What the driver hands back once there's something for the user to do; `settle` finishes the job, called once by the
// machinery below, never by a route.
export interface MintedLoginAttempt {
    readonly url: string;
    // The one-time code the page will ask for, where the vendor issues one. Blank when the page is already addressed to
    // this attempt (Z.ai's is, Meta's is not).
    readonly code: string;
    // For a redirect flow, the marker the landing address carries so the panel can recognise a pasted URL as this
    // attempt's; blank for a device flow.
    readonly state: string;
    // The vendor's own deadline where published, so a card stops waiting when the flow actually died, not when a local
    // constant runs out.
    readonly expiresAt: number;
    readonly settle: () => Promise<MintedCredential>;
}

export interface MintedLoginContext {
    readonly variant: MintedVariant;
    // Aborted by a cancel, a disconnect, or the deadline. A driver polling upstream must give up on it.
    readonly signal: AbortSignal;
    // The authorization code from the address the browser dead-ended on; only a redirect driver awaits this. A code,
    // not the URL, since parsing and the state check belong to completeMintedLogin alone.
    readonly grant: () => Promise<string>;
    readonly fetchImpl: typeof fetch;
}

export type MintedLoginDriver = (context: MintedLoginContext) => Promise<MintedLoginAttempt>;

// Floor for a vendor that publishes no deadline of its own; both current flows do publish one, so this rarely applies.
const DEFAULT_LOGIN_WINDOW_MS = 10 * 60_000;

interface PendingLogin {
    readonly provider: MintedProvider;
    readonly variant: MintedVariant;
    // The state this attempt issued, matched against a pasted address. Blank for a device flow.
    readonly state: string;
    readonly abort: AbortController;
    readonly expiresAt: number;
    // Hand the parsed authorization code to a redirect driver that is waiting for it.
    readonly deliver: (code: string) => void;
    // Fail the wait outright, for an address that carried the vendor's error instead of a grant: the card says so
    // immediately rather than spinning until the deadline.
    readonly fail: (message: string) => void;
}

// Every sign-in this daemon is waiting on, by handshake id, in memory on purpose: a restart correctly drops any attempt
// in flight, since its poll died with the process.
const pending = new Map<string, PendingLogin>();

export interface StartedMintedLogin {
    readonly url: string;
    readonly code: string;
    readonly state: string;
    readonly flow: "device" | "redirect";
    readonly variant: string;
    readonly handshake: string;
    readonly expiresAt: number;
}

export interface MintedLoginDeps {
    readonly provider: MintedProvider;
    // Which estate to sign in to. Absent takes the provider's default, which is what a provider with a single estate
    // always sends.
    readonly variant?: string;
    readonly driver: MintedLoginDriver;
    readonly store: MintedStore;
    readonly logger: Logger;
    // Drop the provider's cached model list once a credential lands, so the picker reads the new account's catalog
    // instead of serving the seed for the rest of the TTL.
    readonly onConnected: () => void;
    readonly fetchImpl?: typeof fetch;
}

// Begins a sign-in; resolves once the vendor hands back a page to open, while the rest continues in the background and
// lands as a new account row.
export const startMintedLogin = async (deps: MintedLoginDeps): Promise<StartedMintedLogin> => {
    const variant = mintedVariant(deps.provider, deps.variant);
    if (variant === undefined) {
        // Refused rather than defaulted: a misspelled estate id would mint a key whose turns cannot use it.
        throw new Error(`${deps.provider} has no "${deps.variant ?? ""}" sign-in.`);
    }
    const handshake = randomUUID();
    const abort = new AbortController();
    let deliver: (code: string) => void = () => {};
    let fail: (message: string) => void = () => {};
    const grantPromise = new Promise<string>((resolve, reject) => {
        deliver = resolve;
        fail = (message) => reject(new Error(message));
    });
    // Nothing awaits this promise on a device flow, and an unhandled rejection still warns at the process level, so
    // it's claimed here.
    grantPromise.catch(() => undefined);

    const attempt = await deps.driver({
        variant,
        signal: abort.signal,
        grant: () => grantPromise,
        fetchImpl: deps.fetchImpl ?? fetch,
    });
    const expiresAt = attempt.expiresAt > Date.now() ? attempt.expiresAt : Date.now() + DEFAULT_LOGIN_WINDOW_MS;
    pending.set(handshake, { provider: deps.provider, variant, state: attempt.state, abort, expiresAt, deliver, fail });
    const timer = setTimeout(() => abort.abort(), Math.max(1_000, expiresAt - Date.now()));
    timer.unref();

    void attempt
        .settle()
        .then(async (credential) => {
            const account = await deps.store.connect({
                apiKey: credential.apiKey,
                variant: variant.id,
                ...(credential.email !== undefined ? { email: credential.email } : {}),
            });
            deps.onConnected();
            deps.logger.info({ provider: deps.provider, variant: variant.id, account: account.id }, "minted provider: sign-in completed");
        })
        .catch((error: unknown) => {
            if (abort.signal.aborted) {
                deps.logger.info({ provider: deps.provider, handshake }, "minted provider: sign-in abandoned");
                return;
            }
            deps.logger.warn({ err: error, provider: deps.provider, variant: variant.id }, "minted provider: sign-in failed");
        })
        .finally(() => {
            clearTimeout(timer);
            pending.delete(handshake);
        });

    return {
        url: attempt.url,
        code: attempt.code,
        state: attempt.state,
        flow: variant.flow,
        variant: variant.id,
        handshake,
        expiresAt,
    };
};

// Parses the grant out of a pasted address (or bare query string); `authCode` is checked before `code`, since BigModel
// names it the first way and every other OAuth the second.
const parseRedirect = (redirectUrl: string): { readonly code: string; readonly state: string; readonly error?: string } => {
    const text = redirectUrl.trim();
    const query = (() => {
        try {
            return new URL(text).searchParams;
        } catch {
            const marker = text.indexOf("?");
            return new URLSearchParams(marker >= 0 ? text.slice(marker + 1) : text);
        }
    })();
    const error = query.get("error_description")?.trim() || query.get("error")?.trim();
    return {
        code: (query.get("authCode") ?? query.get("code") ?? "").trim(),
        state: (query.get("state") ?? "").trim(),
        ...(error !== undefined && error !== "" ? { error } : {}),
    };
};

// Delivers the address a redirect sign-in dead-ended on; throws with something the card can show, but the sign-in
// itself continues in the background regardless.
export const completeMintedLogin = (input: { readonly provider: MintedProvider; readonly handshake: string; readonly redirectUrl: string }): void => {
    const entry = pending.get(input.handshake);
    if (entry === undefined || entry.provider !== input.provider) {
        throw new Error("That sign-in is no longer waiting: start it again.");
    }
    if (entry.variant.flow !== "redirect") {
        // A device sign-in has nothing to hand back; without this, a confused caller would be told nothing while the
        // poll carried on.
        throw new Error(`The ${entry.variant.label} sign-in finishes on its own: there is nothing to paste back.`);
    }
    const parsed = parseRedirect(input.redirectUrl);
    if (parsed.error !== undefined) {
        entry.fail(parsed.error);
        throw new Error(parsed.error);
    }
    if (parsed.code === "") {
        throw new Error("That address carries no authorization code: copy the whole address the browser landed on.");
    }
    // Checked against our own copy, never a value the caller sent: a mismatch is an address from a different sign-in,
    // and redeeming it would attach somebody else's grant.
    if (entry.state !== "" && parsed.state !== entry.state) {
        throw new Error("That address belongs to a different sign-in: use the one this attempt opened.");
    }
    entry.deliver(parsed.code);
};

// Stop waiting on a sign-in nobody completed. Unknown ids are a no-op: the attempt has already expired or already
// landed, both the state the caller wanted.
export const cancelMintedLogin = (provider: MintedProvider, handshake: string): void => {
    const entry = pending.get(handshake);
    if (entry === undefined || entry.provider !== provider) {
        return;
    }
    entry.abort.abort();
    pending.delete(handshake);
};

// Abandons every in-flight attempt for one provider, what a disconnect owes: a running poll would otherwise land a
// fresh credential into a store just cleared.
export const cancelMintedLoginsFor = (provider: MintedProvider): void => {
    for (const [handshake, entry] of pending) {
        if (entry.provider === provider) {
            entry.abort.abort();
            pending.delete(handshake);
        }
    }
};

// Abandon every in-flight sign-in, for daemon shutdown.
export const cancelAllMintedLogins = (): void => {
    for (const entry of pending.values()) {
        entry.abort.abort();
    }
    pending.clear();
};
