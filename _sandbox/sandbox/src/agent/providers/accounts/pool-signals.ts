import { createHmac } from "node:crypto";
import { type PoolSignal, PoolSignalKeySchema, PoolSignalsSchema, POOL_SIGNALS_MAX_FINGERPRINTS } from "@intentic/api-contract/ingress";
import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { cliProxyIdOf } from "@intentic/sandbox-contract/models/provider-specs";
import { type KeyedProvider, KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { sleep } from "@intentic/base/async";
import { parseJsonOr } from "@intentic/base/json";
import { z } from "zod";
import type { Services } from "../../../composition.js";
import type { StoredAccount } from "../claude/claude-credentials.js";
import { authFilesOnDisk, cliProxyAuthDir } from "../translator-auth-files.js";
import { callPlatform } from "../../../system/platform-relay.js";
import type { ProviderRefusalStore } from "../../../usage/provider-refusals.js";
import { providePoolSignalHearing } from "../../../usage/pool-signal-hearing.js";
import type { TranslatorAuthFile } from "../../../usage/translator-usage.js";

/* RUN-OUTS SHARED ACROSS SANDBOXES (docs/architecture/account-routing.md, 2026-11-24). Two of the owner's sandboxes
   signed in to one Claude seat spend one allowance, and each learned it was spent only when its own turn was refused:
   the second sandbox's planner kept placing children on an account the first had already run dry. Now a spent
   allowance refused here is told to the platform, and what the owner's other sandboxes were refused on the accounts
   this one holds is filed in this sandbox's refusal ledger, marked `source: "another-sandbox"`. From there it is judged
   like any refusal: the account reads out until the provider's reset, and a turn answered on it here settles it.

   Run-outs on file (run-outs.json) are left alone: they count this sandbox's own agents, the rate the planner reads, and
   are keyed by provider and pool, which cannot say which of several local accounts another sandbox meant.

   An account is named to the platform only as a fingerprint: HMAC-SHA256 over the provider and the provider's own ids
   for it, never the ids, a credential or a reading. Claude's is the seat's account and organisation uuids together,
   since one organisation uuid covers every seat of a Team org and each seat is metered apart; Codex's the ChatGPT
   account and user ids, for the same reason; Gemini's and Antigravity's the Google account's email and its project.
   Kimi is left out: its credential names no stable account id. So is every provider that publishes no plan limits.

   The HMAC's key is the owner's pool key, which the platform mints once per owner and hands to each of the owner's
   sandboxes (`POST /pool-signals/key`), so every sandbox of one owner names a shared seat alike and the same seat held
   by two owners is two unrelated values (2026-11-24). A plain sha256 was the same value for every owner, which let the
   platform tie together the Intentic accounts holding one seat, and one over a Google email could be confirmed by
   guessing the address. The owner email this daemon is bound to was the other key on hand, and was rejected: it is
   guessable, so the email hash stays confirmable by anyone who knows the owner's address, and it is not one value
   across the owner's sandboxes (an unbound sandbox has none, and a changed address splits them). The daemon learns no
   other owner-wide value (an accepted announce names this sandbox's row, not its owner). Without a key (a platform from
   before the route, or one not reached) the daemon tells nothing and asks nothing. */

/** One provider account this sandbox holds, with the fingerprint its other sandboxes know it by. */
export interface HeldAccount {
    readonly provider: string;
    // The account as the refusal ledger names it: a Claude account id, a translator auth file's name.
    readonly account: string;
    readonly fingerprint: string;
}

/**
 * HMAC-SHA256 hex under the owner's pool key over `provider \0 id \0 id …`; undefined when any id is missing, so a
 * partial identity never matches.
 */
export const poolFingerprint = (key: string, provider: string, ids: readonly (string | undefined)[]): string | undefined => {
    const present = ids.flatMap((id) => (id === undefined || id === "" ? [] : [id]));
    return present.length !== ids.length || present.length === 0
        ? undefined
        : createHmac("sha256", key)
              .update([provider, ...present].join("\0"))
              .digest("hex");
};

export const claudeFingerprint = (key: string, stored: Pick<StoredAccount, "accountUuid" | "organizationUuid">): string | undefined =>
    poolFingerprint(key, "claude", [stored.accountUuid, stored.organizationUuid]);

// The ids Codex's OpenID token names the seat by: the ChatGPT account (a Team workspace's, shared by its seats) and the
// user in it, at the top level or under OpenAI's own claim. A field of the wrong shape reads as absent.
const SeatClaimsSchema = z.object({
    chatgpt_account_id: z.string().optional().catch(undefined),
    chatgpt_user_id: z.string().optional().catch(undefined),
    user_id: z.string().optional().catch(undefined),
});
const CodexClaimsSchema = SeatClaimsSchema.extend({ "https://api.openai.com/auth": SeatClaimsSchema.optional().catch(undefined) });
// The proxy's listing hands the token over parsed; its file holds it as a JWT, whose middle part is the claims.
const IdTokenSchema = z.union([
    CodexClaimsSchema,
    z
        .string()
        .transform(
            (jwt) => CodexClaimsSchema.safeParse(parseJsonOr(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"), undefined)).data,
        ),
]);

const codexIds = (file: TranslatorAuthFile): (string | undefined)[] => {
    const claims = IdTokenSchema.safeParse(file.id_token).data;
    const seat = claims?.["https://api.openai.com/auth"] ?? claims;
    return [seat?.chatgpt_account_id, seat?.chatgpt_user_id ?? seat?.user_id];
};

export const routedFingerprint = (key: string, provider: KeyedProvider, file: TranslatorAuthFile): string | undefined => {
    switch (provider) {
        case "codex":
            return poolFingerprint(key, provider, codexIds(file));
        // Google's, signed in through Antigravity: the account's email and the project it is served under.
        case "gemini":
            return poolFingerprint(key, provider, [file.email?.trim().toLowerCase(), file.project_id]);
        default:
            return undefined;
    }
};

const KEYED_BY_FILE: ReadonlyMap<string, KeyedProvider> = new Map(
    KeyedProviderSchema.options.map((provider) => [cliProxyIdOf(provider) ?? provider, provider] as const),
);

/** Every account this sandbox holds that has a fingerprint under `key`: Claude's own store, and the translator's auth files. */
const heldAccounts = async (services: Pick<Services, "claudeStore" | "authRoot">, key: string): Promise<HeldAccount[]> => {
    // allow(silent-catch): an account store that cannot be read holds nothing to hear about this round.
    const claude = await services.claudeStore.list().catch(() => []);
    // allow(silent-catch): one account file that cannot be read is left out of this round, and read again at the next.
    const stored = await Promise.all(claude.map((account) => services.claudeStore.read(account.id).catch(() => undefined)));
    const claudeHeld = stored.flatMap((account) => {
        const fingerprint = account === undefined ? undefined : claudeFingerprint(key, account);
        return account === undefined || fingerprint === undefined ? [] : [{ provider: "claude", account: account.id, fingerprint }];
    });
    const files = await authFilesOnDisk(cliProxyAuthDir(services.authRoot));
    const routedHeld = files.flatMap((file) => {
        const provider = file.provider === undefined ? undefined : KEYED_BY_FILE.get(file.provider);
        const fingerprint = provider === undefined ? undefined : routedFingerprint(key, provider, file);
        return provider === undefined || fingerprint === undefined || file.name === undefined ? [] : [{ provider, account: file.name, fingerprint }];
    });
    return [...claudeHeld, ...routedHeld];
};

/** What the daemon asks the platform, injected so a test needs none. */
export interface PoolSignalPlatform {
    // The owner's pool key; undefined from a platform without the route, or one not reached.
    readonly key: () => Promise<string | undefined>;
    readonly report: (signal: PoolSignal) => Promise<void>;
    // The live run-outs the owner's other sandboxes reported for these fingerprints; none from a platform without the route.
    readonly read: (fingerprints: readonly string[]) => Promise<readonly PoolSignal[]>;
}

// The owner's key as the platform last handed it to this daemon, asked again after an hour so a sandbox handed to
// another owner follows. A refusal or an unreached platform is never kept, nor an older key used in its place: a key
// past its hour may be a former owner's, and would name the seat alike under both owners.
const KEY_KEEP_MS = 60 * 60_000;
const ownerKeys = new WeakMap<Services["config"], { readonly key: string; readonly at: number }>();

const ownerKeyOf = async (config: Services["config"]): Promise<string | undefined> => {
    const kept = ownerKeys.get(config);
    if (kept !== undefined && Date.now() - kept.at < KEY_KEEP_MS) {
        return kept.key;
    }
    const answer = await callPlatform(config, { route: "poolSignalKey", unreached: "no key was handed over" });
    const key = answer.status === 200 ? PoolSignalKeySchema.safeParse(parseJsonOr(answer.body, undefined)).data?.key : undefined;
    if (key === undefined) {
        ownerKeys.delete(config);
    } else {
        ownerKeys.set(config, { key, at: Date.now() });
    }
    return key;
};

const platformPoolSignals = (config: Services["config"]): PoolSignalPlatform => ({
    key: () => ownerKeyOf(config),
    report: async (signal) => {
        await callPlatform(config, { route: "poolSignal", input: signal, unreached: "no other sandbox heard of it" });
    },
    read: async (fingerprints) => {
        const answer = await callPlatform(config, {
            route: "poolSignals",
            input: { fingerprints: [...fingerprints] },
            unreached: "nothing was read",
        });
        // A platform from before the route answers 404: no signals, said by nobody.
        return answer.status === 200 ? (PoolSignalsSchema.safeParse(parseJsonOr(answer.body, undefined)).data?.signals ?? []) : [];
    },
});

export type LogFields = Readonly<Record<string, string | Error>>;

export interface PoolSignalDeps {
    // The accounts held here, fingerprinted under the owner's key.
    readonly held: (key: string) => Promise<readonly HeldAccount[]>;
    readonly platform: PoolSignalPlatform;
    readonly log: (fields: LogFields, message: string) => void;
}

// The accounts held here under the owner's key, or none without one: with no key, nothing is told and nothing asked.
const heldUnderKey = async (deps: PoolSignalDeps): Promise<readonly HeldAccount[]> => {
    const key = await deps.platform.key();
    return key === undefined ? [] : deps.held(key);
};

// What this sandbox's own refusals tell the others: a spent allowance on a named account, a person's mark excepted (it
// is a guess about a plan nothing reads, not a refusal), and never one heard from another sandbox, which would echo.
const shareable = (refusal: ProviderRefusal): refusal is ProviderRefusal & { readonly account: string } =>
    refusal.kind === "limit" && refusal.account !== undefined && refusal.source === undefined && refusal.byHand !== true;

/**
 * The refusal ledger, telling the platform of each spent allowance it files for an account with a fingerprint. The pool
 * is read back off the ledger once filed, where the stamp resolved it (provider-refusals.ts), else the whole allowance.
 * Fire and forget: a turn's failure path never waits on the platform.
 */
export const sharingRunOuts = (store: ProviderRefusalStore, deps: () => PoolSignalDeps): ProviderRefusalStore => ({
    ...store,
    record: async (provider, refusal) => {
        await store.record(provider, refusal);
        if (shareable(refusal)) {
            void tellOthers(store, deps(), provider, refusal).catch((error: Error) =>
                deps().log({ err: error, provider }, "pool signal: the run-out could not be told"),
            );
        }
    },
});

const tellOthers = async (
    store: ProviderRefusalStore,
    deps: PoolSignalDeps,
    provider: string,
    refusal: ProviderRefusal & { readonly account: string },
) => {
    const held = (await heldUnderKey(deps)).find((account) => account.provider === provider && account.account === refusal.account);
    if (held === undefined) {
        return;
    }
    const filed = (await store.onFile())[provider]?.find(
        (entry) => entry.kind === "limit" && entry.account === refusal.account && entry.model === refusal.model && entry.at === refusal.at,
    );
    const resetsAt = refusal.resetsAt ?? filed?.poolResetsAt;
    const signal: PoolSignal = { fingerprint: held.fingerprint, pool: filed?.pool ?? WHOLE_ALLOWANCE, ranOutAt: refusal.at };
    if (resetsAt !== undefined) {
        signal.resetsAt = Math.floor(resetsAt);
    }
    await deps.platform.report(signal);
};

const WHOLE_ALLOWANCE = "*";

// The sentence the ledger keeps as the refusal's words, since the provider's own were said to another sandbox.
const HEARD_MESSAGE = "This account's allowance ran out in another sandbox signed in to it.";

/** One heard run-out as this sandbox's ledger files it, on the local account that fingerprint names. */
const heardRefusal = (signal: PoolSignal, account: string, now: number): ProviderRefusal => {
    const refusal: ProviderRefusal = {
        at: Math.min(signal.ranOutAt, now),
        kind: "limit",
        message: HEARD_MESSAGE,
        account,
        source: "another-sandbox",
    };
    if (signal.resetsAt !== undefined) {
        refusal.resetsAt = signal.resetsAt;
    }
    if (signal.pool !== WHOLE_ALLOWANCE) {
        refusal.pool = signal.pool;
    }
    return refusal;
};

/**
 * Asks the platform for the run-outs on the accounts this sandbox holds and files each live one not filed before. One
 * filed and since settled by an answered turn here is not filed again (`heard` remembers it), so a turn that proves
 * room is believed over the platform's older word. A signal for a fingerprint nothing here holds is ignored.
 */
export const hearPoolSignals = async (
    store: ProviderRefusalStore,
    deps: PoolSignalDeps,
    heard: Set<string>,
    now: number = Date.now(),
): Promise<number> => {
    const held = await heldUnderKey(deps);
    if (held.length === 0) {
        return 0;
    }
    const fingerprints = [...new Set(held.map((account) => account.fingerprint))].slice(0, POOL_SIGNALS_MAX_FINGERPRINTS);
    let filed = 0;
    for (const signal of await deps.platform.read(fingerprints)) {
        const key = `${signal.fingerprint}:${signal.pool}:${String(signal.ranOutAt)}`;
        const over = signal.resetsAt !== undefined && signal.resetsAt * 1000 <= now;
        if (over || heard.has(key)) {
            continue;
        }
        for (const account of held.filter((entry) => entry.fingerprint === signal.fingerprint)) {
            await store.record(account.provider, heardRefusal(signal, account.account, now));
            deps.log(
                { provider: account.provider, account: account.account, pool: signal.pool },
                "pool signal: heard a run-out from another sandbox",
            );
            filed += 1;
        }
        heard.add(key);
    }
    return filed;
};

const HEAR_EVERY_MS = 5 * 60_000;
// The listing asks too, at most this often: a parent fanning out lists providers several times a minute.
const HEAR_AT_MOST_EVERY_MS = 60_000;
// How long a listing waits for the platform before it lists what the ledger already holds.
const LISTING_WAIT_MS = 2_000;

export interface PoolSignalListener {
    // Hears now, unless it heard within the last minute; never rejects, and gives up waiting after two seconds.
    readonly hearSoon: () => Promise<void>;
    readonly stop: () => void;
}

/** What the daemon hears through: the platform this sandbox is connected to, and the accounts it holds. */
export const poolSignalDepsOf = (services: Pick<Services, "claudeStore" | "authRoot" | "config" | "logger">): PoolSignalDeps => ({
    held: (key) => heldAccounts(services, key),
    platform: platformPoolSignals(services.config),
    log: (fields, message) => services.logger.info(fields, message),
});

/** The daemon's boot: hears on the services' own ledger, and answers the stop its shutdown runs. */
export const startPoolSignalsFor = (
    services: Pick<Services, "claudeStore" | "authRoot" | "config" | "logger" | "providerRefusals">,
): (() => void) => {
    const listener = startPoolSignals(services.providerRefusals, poolSignalDepsOf(services));
    // The providers listing asks through this port (usage/pool-signal-hearing.ts).
    providePoolSignalHearing(listener);
    return () => {
        listener.stop();
        providePoolSignalHearing(undefined);
    };
};

/** Hears every five minutes on an unref'd timer, and when the providers listing asks. */
const startPoolSignals = (store: ProviderRefusalStore, deps: PoolSignalDeps): PoolSignalListener => {
    const heard = new Set<string>();
    let last = 0;
    let inFlight: Promise<void> | undefined;
    const hear = (): Promise<void> => {
        last = Date.now();
        inFlight ??= hearPoolSignals(store, deps, heard)
            .then(() => undefined)
            .catch((error: Error) => deps.log({ err: error }, "pool signal: the run-outs could not be heard"))
            .finally(() => {
                inFlight = undefined;
            });
        return inFlight;
    };
    const timer = setInterval(() => void hear(), HEAR_EVERY_MS);
    timer.unref();
    void hear();
    return {
        hearSoon: async () => {
            const pending = inFlight ?? (Date.now() - last >= HEAR_AT_MOST_EVERY_MS ? hear() : undefined);
            if (pending !== undefined) {
                await Promise.race([pending, sleep(LISTING_WAIT_MS, { unref: true })]);
            }
        },
        stop: () => clearInterval(timer),
    };
};
