import { randomUUID } from "node:crypto";
import { type MintedProvider, type MintedVariant, mintedVariant } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { MintedStore } from "./minted-credentials.js";

/* THE SIGN-IN A MINTED PROVIDER CONNECTS THROUGH, written once for every vendor, because the shape is the same
 * one every time and only the wire differs.
 *
 * WHAT MAKES THIS A MECHANISM RATHER THAN TWO FLOWS. The vendor hands back a token that is NOT an inference
 * credential — hit either provider's model endpoint with it and you get a 401 — so the sign-in has a second half
 * the user never sees: mint the vendor's own API key from it, and store that. Meta's Muse Code CLI does exactly
 * this and so does Z.ai's ZCode, which is the whole reason these providers can be connected without anybody
 * being asked to go and find a credential.
 *
 * So a driver's job is: say what the card should show, then answer with a key. Everything around that — the
 * handshake id, the expiry, the cancellation, the pasted-address parsing, the state check, the store write, the
 * logging — is here, once. Adding a third minted provider is a driver and a spec row.
 *
 * THE BACKGROUND HALF NEVER REJECTS INTO NOTHING. `start` answers as soon as there is a page to open, so the
 * poll, the mint and the write continue after the route has replied — a floating promise by design, exactly as
 * Cursor's sign-in is. Every outcome is therefore either a written account or a logged line, and the cancelled
 * case is not logged as a failure, because a person closing a tab is not an error. */

// What a sign-in produces: the vendor's own API key, and whatever it managed to learn about whose it is.
export interface MintedCredential {
    readonly apiKey: string;
    readonly email?: string;
}

// What the driver hands back the moment there is something for the user to do, plus the continuation that
// finishes the job. `settle` is called once, by the machinery below, and never by a route.
export interface MintedLoginAttempt {
    readonly url: string;
    // The one-time code the page will ask for, where the vendor issues one. Blank when the page is already
    // addressed to this attempt (Z.ai's is, Meta's is not).
    readonly code: string;
    // For a redirect flow, the marker the landing address carries, so the panel can recognise a pasted URL as
    // this attempt's. Blank for a device flow, which has nothing to paste.
    readonly state: string;
    // The vendor's own deadline where it published one, so a card stops waiting when the flow actually died
    // rather than when a constant here happened to run out.
    readonly expiresAt: number;
    readonly settle: () => Promise<MintedCredential>;
}

export interface MintedLoginContext {
    readonly variant: MintedVariant;
    // Aborted by a cancel, a disconnect, or the deadline. A driver polling upstream must give up on it.
    readonly signal: AbortSignal;
    /* The authorization code out of the address the browser dead-ended on, once the user brings it back. Only a
     * redirect driver awaits this; a device driver never calls it. It is a code and not the URL because the
     * parsing and the state check belong to one place, and that place is `completeMintedLogin` below. */
    readonly grant: () => Promise<string>;
    readonly fetchImpl: typeof fetch;
}

export type MintedLoginDriver = (context: MintedLoginContext) => Promise<MintedLoginAttempt>;

// How long an attempt stays answerable when the vendor published no deadline of its own. Both of these flows do
// publish one (ten minutes each), so this is the floor for a vendor that stops saying.
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
    // Fail the wait outright, for an address that carried the vendor's error instead of a grant: the card says
    // so immediately rather than spinning until the deadline.
    readonly fail: (message: string) => void;
}

/* EVERY SIGN-IN THIS DAEMON IS WAITING ON, by handshake id. In memory on purpose: a daemon restart drops any
 * attempt that was in flight, which is correct — the poll it was running died with the process, and the browser
 * tab that was going to complete it is now completing nothing. */
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
    // Which estate to sign in to. Absent takes the provider's default, which is what a provider with a single
    // estate always sends.
    readonly variant?: string;
    readonly driver: MintedLoginDriver;
    readonly store: MintedStore;
    readonly logger: Logger;
    // Drop the provider's cached model list once a credential lands, so the picker reads the new account's
    // catalog instead of serving the seed for the rest of the TTL.
    readonly onConnected: () => void;
    readonly fetchImpl?: typeof fetch;
}

/* Begin a sign-in. Resolves as soon as the vendor hands back a page to open; the rest continues in the
 * background and lands as a new row in the account list. */
export const startMintedLogin = async (deps: MintedLoginDeps): Promise<StartedMintedLogin> => {
    const variant = mintedVariant(deps.provider, deps.variant);
    if (variant === undefined) {
        // A variant the provider does not have. Refused rather than defaulted: signing somebody into the
        // international estate because their mainland id was misspelled mints a key their turns cannot use.
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
    // Nothing awaits this promise for a device flow, and an unhandled rejection on a promise nobody took is
    // still a process-level warning, so it is claimed here once and for all.
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

/* THE GRANT OUT OF A PASTED ADDRESS, and the three ways a paste can be wrong, each answered in its own words
 * because they send the user somewhere different: an address from another attempt, an address the vendor put an
 * error in, and something that is not the address at all.
 *
 * `authCode` before `code`: BigModel names it the first way and every other OAuth on earth names it the second,
 * so both are read rather than one being guessed at. A bare query string is accepted as well as a whole URL,
 * because a person copying "the bit after the question mark" is doing something reasonable. */
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

/* Hand back the address a redirect sign-in dead-ended on. Throws with something the card can show; the sign-in
 * itself continues in the background exactly as a device flow's does, so a caller learns it worked by watching
 * the account list either way. */
export const completeMintedLogin = (input: { readonly provider: MintedProvider; readonly handshake: string; readonly redirectUrl: string }): void => {
    const entry = pending.get(input.handshake);
    if (entry === undefined || entry.provider !== input.provider) {
        throw new Error("That sign-in is no longer waiting: start it again.");
    }
    if (entry.variant.flow !== "redirect") {
        // A device sign-in has nothing to hand back, so a caller doing so has confused two flows and would
        // otherwise be told nothing at all while the poll carried on regardless.
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
    /* THE STATE IS CHECKED AGAINST OUR OWN COPY, never against a value the caller sent, which is the difference
     * between a check and a formality. A mismatch is an address from a different sign-in (a second tab, an old
     * paste), and redeeming it would attach somebody else's grant to this attempt. */
    if (entry.state !== "" && parsed.state !== entry.state) {
        throw new Error("That address belongs to a different sign-in: use the one this attempt opened.");
    }
    entry.deliver(parsed.code);
};

// Stop waiting on a sign-in nobody completed. Unknown ids are a no-op rather than an error: the attempt has
// already expired or already landed, and both are the state the caller was asking for.
export const cancelMintedLogin = (provider: MintedProvider, handshake: string): void => {
    const entry = pending.get(handshake);
    if (entry === undefined || entry.provider !== provider) {
        return;
    }
    entry.abort.abort();
    pending.delete(handshake);
};

/* Abandon every attempt in flight for one provider, which is what a DISCONNECT owes: a poll still running would
 * otherwise land a fresh credential into a store the user has just cleared out, minutes after they cleared it.
 * The same reasoning the translator's codex disconnect kills its pending device login for. */
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
