import type { NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import { aiAccountKey } from "@intentic/sandbox-contract/schemas/members";
import type { LoginStart, OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { ORPCError } from "@orpc/server";
import type { ProvenCaller } from "../../auth/auth.js";
import type { Services } from "../../composition.js";
import type { AccountDoor } from "../providers/provider-module.js";

/* WHO CONNECTED EACH ACCOUNT, told from the sign-ins people start here (auth/members/account-connectors.ts keeps it), so
 * an account a person connected is always theirs to run on and, with only the own-accounts right, theirs alone to rename
 * or disconnect. An attempt ends one of three ways: `complete` answers with the account, `status` reports it, or a device
 * sign-in's row simply turns up in the account list. The first two name the account outright. For the third, each
 * attempt is remembered with the ids listed when it started, and a listing that finds a new id hands it to that
 * attempt's person, but only when one person alone has an attempt open for the provider: with two signing in at once a
 * new row could be either's, and it is left unattributed rather than guessed. The owner's own tools (no caller) record
 * nothing, and their attempts count as somebody else's in that rule. A store that cannot be read or written costs the
 * record, never the sign-in or the listing. */

// A device sign-in's row can land a little after the vendor's page stops answering, while the sandbox finishes its mint.
const LANDING_GRACE_MS = 2 * 60_000;

interface OpenAttempt {
    readonly provider: NativeProvider;
    // Undefined for an attempt nobody the sandbox can name started.
    readonly email: string | undefined;
    // The ids listed when it started; undefined where that listing failed, so no row can be told apart as new.
    readonly before: ReadonlySet<string> | undefined;
    readonly expiresAt: number;
}

export type AttributionDeps = Pick<Services, "accountConnectors" | "logger">;

export interface AccountAttribution {
    // Starts a sign-in through `begin`, remembering who asked and what the door already listed.
    readonly start: (provider: NativeProvider, identity: ProvenCaller | undefined, door: AccountDoor, begin: () => Promise<LoginStart>) => Promise<LoginStart>;
    // An attempt ended with this account (none: it lands in the list later), connected by `by` or else the attempt's person.
    readonly landed: (provider: NativeProvider, handshake: string, account: OauthAccount | undefined, by?: string) => Promise<OauthAccount | undefined>;
    // An attempt ended with nothing: abandoned, or failed.
    readonly dropped: (handshake: string) => void;
    // A listing: hands new rows to the one person signing in, then names each row's connector.
    readonly listed: (provider: NativeProvider, accounts: readonly OauthAccount[]) => Promise<OauthAccount[]>;
    // Refuses a rename or a disconnect of somebody else's account to a caller below Full access.
    readonly ensureOwn: (identity: ProvenCaller | undefined, provider: NativeProvider, id: string) => Promise<void>;
    // The account was disconnected: its record goes with it.
    readonly forgotten: (provider: NativeProvider, id: string) => Promise<void>;
}

const NOT_YOURS = "you can rename or disconnect only the AI accounts you connected yourself";

const connectedBy = (account: OauthAccount, by: string | undefined): OauthAccount => (by === undefined ? account : { ...account, connectedBy: by });

type Attempts = Map<string, OpenAttempt>;
type RecordConnector = (provider: NativeProvider, id: string, email: string) => Promise<boolean>;

const isOpen = (attempt: OpenAttempt, now: number): boolean => now <= attempt.expiresAt + LANDING_GRACE_MS;

const prune = (attempts: Attempts, now: number): void => {
    for (const [handshake, attempt] of attempts) {
        if (!isOpen(attempt, now)) {
            attempts.delete(handshake);
        }
    }
};

const listedIds = async (deps: AttributionDeps, door: AccountDoor, provider: NativeProvider): Promise<ReadonlySet<string> | undefined> => {
    try {
        return new Set((await door.list(false)).map((account) => account.id));
    } catch (error) {
        deps.logger.warn({ err: error, provider }, "accounts: the account list could not be read before a sign-in; a row it adds by itself goes unattributed");
        return undefined;
    }
};

// The rows a listing finds that no record names and that some open attempt of the one person signing in did not list
// when it started, recorded as theirs in `known`; the attempts that account for them are finished.
const attribute = async (
    attempts: Attempts,
    record: RecordConnector,
    listing: { readonly provider: NativeProvider; readonly accounts: readonly OauthAccount[]; readonly now: number },
    known: Map<string, string>,
): Promise<void> => {
    const { provider, accounts, now } = listing;
    const pending = [...attempts].filter(([, attempt]) => attempt.provider === provider && isOpen(attempt, now));
    const people = new Set(pending.map(([, attempt]) => attempt.email));
    const [email] = people;
    if (people.size !== 1 || email === undefined) {
        return;
    }
    const unlisted = (id: string): [string, OpenAttempt][] => pending.filter(([, attempt]) => attempt.before !== undefined && !attempt.before.has(id));
    for (const account of accounts.filter((row) => !known.has(aiAccountKey(provider, row.id)) && unlisted(row.id).length > 0)) {
        if (await record(provider, account.id, email)) {
            known.set(aiAccountKey(provider, account.id), email);
            for (const [handshake] of unlisted(account.id)) {
                attempts.delete(handshake);
            }
        }
    }
};

export const createAccountAttribution = (deps: AttributionDeps): AccountAttribution => {
    const attempts: Attempts = new Map();
    const record: RecordConnector = async (provider, id, email) => {
        try {
            await deps.accountConnectors.record(aiAccountKey(provider, id), email, Date.now());
            return true;
        } catch (error) {
            deps.logger.warn({ err: error, provider }, "accounts: who connected an account could not be recorded; the account stays connected");
            return false;
        }
    };
    return {
        start: async (provider, identity, door, begin) => {
            prune(attempts, Date.now());
            const before = identity === undefined ? undefined : await listedIds(deps, door, provider);
            const started = await begin();
            attempts.set(started.handshake, { provider, email: identity?.email.toLowerCase(), before, expiresAt: started.expiresAt });
            return started;
        },
        landed: async (provider, handshake, account, by) => {
            if (account === undefined) {
                return undefined;
            }
            const email = by ?? attempts.get(handshake)?.email;
            attempts.delete(handshake);
            return email !== undefined && (await record(provider, account.id, email)) ? connectedBy(account, email.toLowerCase()) : account;
        },
        dropped: (handshake) => {
            attempts.delete(handshake);
        },
        listed: async (provider, accounts) => {
            const now = Date.now();
            let known: Map<string, string>;
            try {
                known = new Map(await deps.accountConnectors.all());
            } catch (error) {
                deps.logger.warn({ err: error, provider }, "accounts: who connected each account could not be read; the list goes without it");
                return [...accounts];
            }
            await attribute(attempts, record, { provider, accounts, now }, known);
            prune(attempts, now);
            return accounts.map((account) => connectedBy(account, known.get(aiAccountKey(provider, account.id))));
        },
        ensureOwn: async (identity, provider, id) => {
            if (identity === undefined || roleAtLeast(identity.role, "maintainer")) {
                return;
            }
            let by: string | undefined;
            try {
                by = (await deps.accountConnectors.all()).get(aiAccountKey(provider, id));
            } catch (error) {
                deps.logger.warn({ err: error, provider }, "accounts: who connected each account could not be read; a rename or disconnect below Full access is refused");
                throw new ORPCError("SERVICE_UNAVAILABLE", { message: "who connected this account could not be read, so it cannot be renamed or disconnected from here just now; try again in a moment" });
            }
            if (by !== identity.email.toLowerCase()) {
                throw new ORPCError("FORBIDDEN", { message: NOT_YOURS });
            }
        },
        forgotten: async (provider, id) => {
            try {
                await deps.accountConnectors.forget(aiAccountKey(provider, id));
            } catch (error) {
                deps.logger.warn({ err: error, provider }, "accounts: a disconnected account's connector could not be forgotten");
            }
        },
    };
};
