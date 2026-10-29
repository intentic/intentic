import { refuse } from "@intentic/contract-serve";
import { PROVIDER_SPECS, TRANSLATOR_PROVIDERS, type TranslatorProvider } from "@intentic/sandbox-contract/models/provider-specs";
import type { LoginStart, LoginStatus, OauthAccount, TranslatorStatus } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import type { TranslatorAccount, TranslatorAccounts } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { freshEdition, noModels } from "../../mode";
import { DEMO_USER } from "../../world/account";
import { listeners } from "../board/roster";
import { demoClaudeAccount, demoClaudeAccountSecond, demoTranslatorAccounts, demoSignInStart } from "./accounts";

// The accounts this sandbox holds, as a store a sign-in adds to and a disconnect takes from, for this page load. A
// sign-in plays out the way the real one does: a device code is approved "upstream" a few seconds after it is shown
// (the visitor has no page to approve it on), a watched redirect is caught by the owner's machine just as soon, and a
// paste or a pasted landing address lands the account at once.

// How long a device code or a watched redirect waits before the visitor's approval "arrives": long enough to see the
// card holding its code, short enough that nobody gives up on it.
const APPROVED_AFTER_MS = 6_000;

// Who a new account signs in as, in order: the owner first, then the shop's other addresses.
const WHO = [`ada@acme.dev`, `ops@acme.dev`, `lin@acme.dev`, `grace@acme.dev`, `alan@acme.dev`];

interface Attempt {
    readonly provider: string;
    readonly flow: LoginStart[`flow`];
    readonly variant: string;
    readonly startedAt: number;
    // Set once it has landed: the account it connected.
    account?: OauthAccount;
}

// Seeded on first use, since the fixture accounts are built on first read (daemon/accounts.ts says why).
let nativeHeld: Map<string, OauthAccount[]> | undefined;
const nativeStore = (): Map<string, OauthAccount[]> =>
    (nativeHeld ??= new Map([[`claude`, freshEdition || noModels ? [] : [demoClaudeAccount(), demoClaudeAccountSecond()]]]));
const attempts = new Map<string, Attempt>();

// Attempts and accounts are numbered per provider, so an id or a handshake reads as whose it is.
const counters = new Map<string, number>();
const nextOf = (key: string): number => {
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
};

const accountLabelOf = (provider: string): string => PROVIDER_SPECS.find((spec) => spec.id === provider)?.accountLabel ?? provider;

const listOf = (provider: string): OauthAccount[] => {
    const held = nativeStore().get(provider) ?? [];
    nativeStore().set(provider, held);
    return held;
};

// The first address no account of this provider signs in as yet.
const nextWho = (taken: readonly (string | undefined)[]): string => WHO.find((email) => !taken.includes(email)) ?? `seat-${taken.length + 1}@acme.dev`;

// A just-measured reading with the whole window ahead of it, so the new row draws a ring rather than an unknown.
const freshUsage = (now: number): OauthAccount[`usage`] => ({
    measuredAt: now,
    windows: [
        { kind: `five_hour`, utilization: 0, resetsAt: Math.round(now / 1000) + 5 * 3600, gates: `all` },
        { kind: `seven_day`, utilization: 3, resetsAt: Math.round(now / 1000) + 7 * 24 * 3600, gates: `all` },
    ],
});

// Lands an attempt: the same identity signing in again replaces its credential in place (same id), a new one is added.
const land = (attempt: Attempt, now: number, label?: string): OauthAccount => {
    if (attempt.account !== undefined) {
        return attempt.account;
    }
    const held = listOf(attempt.provider);
    const email = nextWho(held.map((account) => account.email));
    const derived = held.length === 0 ? accountLabelOf(attempt.provider) : `${accountLabelOf(attempt.provider)} ${held.length + 1}`;
    const account: OauthAccount = {
        id: `acc_${attempt.provider}_${nextOf(`account:${attempt.provider}`)}`,
        label: label !== undefined && label !== `` ? label : derived,
        email,
        organization: `Acme`,
        connectedAt: now,
        // The sandbox records whoever signed it in as its connector, and here that is always the demo's reader.
        connectedBy: DEMO_USER.email,
        usage: freshUsage(now),
    };
    if (attempt.variant !== ``) {
        account.variant = attempt.variant;
    }
    held.push(account);
    attempt.account = account;
    return account;
};

// Lands every attempt that finishes by itself and whose approval has had time to arrive.
const settle = (now: number): void => {
    for (const attempt of attempts.values()) {
        const watched = attempt.flow === `device` || (attempt.flow === `redirect` && attempt.provider === `devin`);
        if (attempt.account === undefined && watched && now - attempt.startedAt >= APPROVED_AFTER_MS) {
            land(attempt, now);
        }
    }
};

const attemptOf = (handshake: string): Attempt => attempts.get(handshake) ?? refuse(`That sign-in is no longer waiting. Start it again.`, 404);

export const nativeAccounts = (provider: string): OauthAccount[] => {
    settle(Date.now());
    return [...listOf(provider)];
};

export const startNativeSignIn = (provider: string, variant: string | undefined): LoginStart => {
    const attempt = nextOf(`native:${provider}`);
    const started = demoSignInStart(provider, variant, `demo-state-${provider}-${attempt}`);
    const handshake = `${started.handshake}-${attempt}`;
    attempts.set(handshake, { provider, flow: started.flow, variant: started.variant, startedAt: Date.now() });
    return { ...started, handshake };
};

export const nativeSignInStatus = (handshake: string): LoginStatus => {
    settle(Date.now());
    const attempt = attempts.get(handshake);
    if (attempt === undefined) {
        return { status: `error`, error: `That sign-in is no longer waiting. Start it again.` };
    }
    return attempt.account === undefined ? { status: `wait` } : { status: `ok`, account: attempt.account };
};

// A paste lands the account here and answers with it; a redirect's address is accepted and the row lands for the poll.
export const completeNativeSignIn = (input: { handshake: string; code?: string | undefined; redirectUrl?: string | undefined; label?: string | undefined }): {
    account?: OauthAccount;
} => {
    const attempt = attemptOf(input.handshake);
    if (attempt.flow === `paste` && (input.code ?? ``).trim() === ``) {
        return refuse(`Paste the code the sign-in page showed.`, 400);
    }
    if (attempt.flow === `redirect` && !(input.redirectUrl ?? ``).includes(`code=`)) {
        return refuse(`That address carries no sign-in grant. Paste the whole address the browser landed on.`, 400);
    }
    const account = land(attempt, Date.now(), input.label);
    return attempt.flow === `paste` ? { account } : {};
};

export const cancelNativeSignIn = (handshake: string): void => {
    attempts.delete(handshake);
};

export const renameNativeAccount = (provider: string, id: string, label: string): OauthAccount => {
    const account = listOf(provider).find((held) => held.id === id) ?? refuse(`No ${accountLabelOf(provider)} account ${id} is connected.`, 404);
    // Blank restores the name derived from the sign-in.
    account.label = label.trim() === `` ? accountLabelOf(provider) : label.trim();
    return account;
};

/** Files an account another of the owner's sandboxes copied or lends here (sharing.handler.ts), as a row of this store. */
export const fileNativeAccount = (provider: string, account: OauthAccount): void => {
    listOf(provider).push(account);
};

// Clears one credential and stops any sign-in still in flight for the provider, as the real disconnect does.
export const disconnectNativeAccount = (provider: string, id: string): void => {
    nativeStore().set(
        provider,
        listOf(provider).filter((held) => held.id !== id),
    );
    for (const [handshake, attempt] of attempts) {
        if (attempt.provider === provider && attempt.account === undefined) {
            attempts.delete(handshake);
        }
    }
};

type TranslatorStart = SandboxHandlerOutput<`translator`, `connect`>;

// The translator's subscriptions: the same store, keyed by its auth-file names.

interface RoutedAttempt {
    readonly provider: TranslatorProvider;
    readonly flow: TranslatorStart[`flow`];
    readonly startedAt: number;
    landed: boolean;
}

let routedHeld: TranslatorAccounts | undefined;
const routedStore = (): TranslatorAccounts => {
    if (routedHeld === undefined) {
        routedHeld = demoTranslatorAccounts();
        for (const provider of freshEdition || noModels ? TRANSLATOR_PROVIDERS : []) {
            routedHeld[provider] = [];
        }
    }
    return routedHeld;
};
const routedAttempts = new Map<string, RoutedAttempt>();

// Where each provider's device sign-in sends the browser; Google's is a redirect to a loopback the sandbox can't receive.
const DEVICE_PAGES = {
    codex: `https://auth.openai.com/codex/device`,
    grok: `https://accounts.x.ai/device`,
    kimi: `https://www.kimi.com/code/device`,
};

const landRouted = (attempt: RoutedAttempt, now: number): void => {
    if (attempt.landed) {
        return;
    }
    attempt.landed = true;
    const rows = routedStore()[attempt.provider];
    const email = nextWho(rows.map((row) => row.label));
    const local = email.split(`@`)[0] ?? `ada`;
    const row: TranslatorAccount = {
        name: attempt.provider === `gemini` ? `antigravity-${local}.json` : `${attempt.provider}-${local}.json`,
        label: email,
    };
    // Grok publishes no quota to read, so its row draws as a dot rather than a ring, as the real one does.
    if (attempt.provider !== `grok`) {
        row.usage = freshUsage(now);
    }
    rows.push(row);
};

const settleRouted = (now: number): void => {
    for (const attempt of routedAttempts.values()) {
        if (attempt.flow === `device` && now - attempt.startedAt >= APPROVED_AFTER_MS) {
            landRouted(attempt, now);
        }
    }
};

export const routedAccounts = (): TranslatorAccounts => {
    settleRouted(Date.now());
    return structuredClone(routedStore());
};

export const connectRouted = (provider: TranslatorProvider): TranslatorStart => {
    const attempt = nextOf(`routed:${provider}`);
    const state = `demo-routed-${provider}-${attempt}`;
    const page = provider === `gemini` ? undefined : DEVICE_PAGES[provider];
    const flow = page === undefined ? `redirect` : `device`;
    routedAttempts.set(state, { provider, flow, startedAt: Date.now(), landed: false });
    return page === undefined
        ? { url: `https://accounts.google.com/o/oauth2/auth?client_id=antigravity&state=${state}`, code: ``, state, flow }
        : { url: page, code: `KQ7M-${(4800 + attempt).toString()}`, state, flow };
};

export const routedStatus = (state: string): TranslatorStatus => {
    settleRouted(Date.now());
    const attempt = routedAttempts.get(state);
    if (attempt === undefined) {
        return { status: `error`, error: `That sign-in is no longer waiting. Start it again.` };
    }
    return attempt.landed ? { status: `ok` } : { status: `wait` };
};

export const completeRouted = (state: string, redirectUrl: string): void => {
    const attempt = routedAttempts.get(state) ?? refuse(`That address belongs to another sign-in. Start it again.`, 400);
    if (!redirectUrl.includes(`code=`)) {
        refuse(`That address carries no sign-in grant. Paste the whole address the browser landed on.`, 400);
    }
    landRouted(attempt, Date.now());
};

export const disconnectRouted = (provider: TranslatorProvider, name: string): void => {
    routedStore()[provider] = routedStore()[provider].filter((row) => row.name !== name);
};

// The plan-limit reset a Claude plan grants once a week: one claim per account per page load reopens its session window.
const claimed = new Set<string>();
const WEEK_S = 7 * 24 * 3600;

const providerOf = (id: string): string => [...nativeStore()].find(([, held]) => held.some((account) => account.id === id))?.[0] ?? `claude`;
const accountById = (id: string): OauthAccount | undefined => [...nativeStore().values()].flat().find((account) => account.id === id);

export const limitResetStatus = (id: string): SandboxHandlerOutput<`usage`, `limitReset`> => {
    const account = accountById(id);
    const weekly = account?.usage?.windows.find((window) => window.kind === `seven_day`)?.resetsAt;
    if (account === undefined || account.usage === undefined) {
        return { available: false, reason: `ineligible` };
    }
    if (claimed.has(id)) {
        return { available: false, reason: `already_used`, nextAvailableAt: Math.round(Date.now() / 1000) + WEEK_S, weeklyResetsAt: weekly };
    }
    return { available: true, weeklyResetsAt: weekly };
};

// Reopens the session window and pushes the new reading, as the daemon's headroom does, so every ring agrees at once.
export const claimLimitReset = (id: string): SandboxHandlerOutput<`usage`, `claimLimitReset`> => {
    const status = limitResetStatus(id);
    const account = accountById(id);
    if (!status.available || account?.usage === undefined) {
        return { result: status.reason === `already_used` ? `already_used` : `ineligible`, nextAvailableAt: status.nextAvailableAt };
    }
    claimed.add(id);
    const now = Date.now();
    account.usage = {
        measuredAt: now,
        windows: account.usage.windows.map((window) =>
            window.kind === `five_hour` ? { ...window, utilization: 0, resetsAt: Math.round(now / 1000) + 5 * 3600 } : window,
        ),
    };
    for (const listener of listeners) {
        listener({ kind: `accountUsage`, provider: providerOf(id), account: id, usage: account.usage });
    }
    return { result: `reset`, nextAvailableAt: Math.round(now / 1000) + WEEK_S };
};
