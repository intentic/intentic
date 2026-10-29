import { MINTED_PROVIDERS, type MintedProvider, providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import { endpointIdOf, endpointProvider } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { TranslatorAccounts,AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import {
    type AccountCopy,
    isBorrowedId,
    type LinkAccount,
    sameSharedRef,
    type ShareableAccount,
    type SharedAccountRef,
    type ShareMode,
} from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";

// WHAT THIS SANDBOX HOLDS, AND HOW EACH ACCOUNT MAY REACH ANOTHER OF THE OWNER'S SANDBOXES (account-sharing.ts in the
// contract). One list, read the same way by the owner's Models page (what could be shared) and by an accounts link's
// doors (what its terms name): a door never trusts the terms alone, so an account the terms name that has since become
// unshareable here (revoked, itself borrowed) is refused at the door as it is shown on the page.
//
// The rule per credential: a key that does not rotate is copied, a sign-in whose renewal must happen in one place is
// lent, and the source keeps it. A borrowed account is never lent on: one hop, as a task's links are bounded.

export type HeldDeps = Pick<Services, "claudeStore" | "cursorStore" | "devinStore" | "minted" | "cliProxy" | "capabilities" | "accountUsage">;

export interface HeldAccount {
    readonly ref: SharedAccountRef;
    readonly row: OauthAccount;
    readonly mode: ShareMode;
    readonly reason?: string;
}

const held = (provider: string, row: OauthAccount, mode: ShareMode, reason?: string): HeldAccount => ({
    ref: { provider, account: row.id },
    row,
    mode,
    ...opt("reason", reason),
});

const REAUTH = "It needs signing in again here first.";
const BORROWED = (name: string): string => `It is borrowed from ${name}: bring it in from there.`;

const claudeHeld = (rows: readonly OauthAccount[], usage: Readonly<Record<string, AccountUsage>>): HeldAccount[] =>
    rows.map((row) => {
        if (row.borrowedFrom !== undefined || isBorrowedId(row.id)) {
            return held("claude", row, "no", BORROWED(row.borrowedFrom?.name ?? "another sandbox"));
        }
        const measured = usage[row.id];
        const withUsage = measured === undefined ? row : { ...row, usage: measured };
        return row.needsReauth === true ? held("claude", withUsage, "no", REAUTH) : held("claude", withUsage, "lend");
    });

const staticHeld = (provider: string, rows: readonly OauthAccount[]): HeldAccount[] =>
    rows.map((row) => (row.needsReauth === true ? held(provider, row, "no", REAUTH) : held(provider, row, "copy")));

// Not lent yet: a borrowing sandbox would have to relay every request to this one's translator, and its readiness,
// catalogs and Codex's own loop do not ask a borrowed translator yet. Listed, so the page says why.
const TRANSLATOR_NOT_YET = "Subscriptions the translator holds can't be lent between sandboxes yet: sign in on this sandbox too.";

// A translator provider is shared whole: its translator picks among its own subscriptions and is never told which.
const translatorHeld = (accounts: TranslatorAccounts): HeldAccount[] =>
    KeyedProviderSchema.options.flatMap((provider) => {
        const files = accounts[provider];
        const first = files[0];
        if (first === undefined) {
            return [];
        }
        const label = providerSpec(provider)?.label ?? provider;
        const row: OauthAccount = {
            id: provider,
            label: files.length === 1 ? label : `${label} (${files.length} subscriptions)`,
            email: files.map((file) => file.label).join(", "),
            connectedAt: 0,
            ...opt("usage", first.usage),
        };
        return [{ ref: { provider }, row, mode: "no" as const, reason: TRANSLATOR_NOT_YET }];
    });

const endpointHeld = (capabilities: readonly Capability[]): HeldAccount[] =>
    capabilities.flatMap((capability) =>
        capability.kind === "endpoint"
            ? [{ ref: { provider: endpointProvider(capability.id) }, row: { id: capability.id, label: capability.id, connectedAt: 0 }, mode: "copy" as const }]
            : [],
    );

// What the stores answered, read once: the classification below is a pure function of it.
export interface HeldReadings {
    readonly claude: readonly OauthAccount[];
    readonly usage: Readonly<Record<string, AccountUsage>>;
    readonly cursor: readonly OauthAccount[];
    readonly devin: readonly OauthAccount[];
    readonly minted: Readonly<Partial<Record<MintedProvider, readonly OauthAccount[]>>>;
    readonly translator: TranslatorAccounts | undefined;
    readonly capabilities: readonly Capability[];
}

/** Every account in the readings, with how it may be shared. */
export const heldFrom = (readings: HeldReadings): HeldAccount[] => [
    ...claudeHeld(readings.claude, readings.usage),
    ...(readings.translator === undefined ? [] : translatorHeld(readings.translator)),
    ...staticHeld("cursor", readings.cursor),
    ...staticHeld("devin", readings.devin),
    ...MINTED_PROVIDERS.flatMap((provider) => staticHeld(provider, readings.minted[provider] ?? [])),
    ...endpointHeld(readings.capabilities),
];

/** Every account this sandbox holds, with how it may be shared. */
export const heldAccounts = async (deps: HeldDeps): Promise<HeldAccount[]> => {
    const [claude, usage, cursor, devin, translator, capabilities, ...minted] = await Promise.all([
        deps.claudeStore.list(),
        deps.accountUsage.read(),
        deps.cursorStore.list(),
        deps.devinStore.list(),
        // A translator that is not answering lends nothing this minute; it is not a reason to refuse the rest.
        // allow(silent-catch): the page and the doors read an unreachable translator as holding no subscriptions.
        deps.cliProxy.accounts().catch(() => undefined),
        deps.capabilities.list(),
        ...MINTED_PROVIDERS.map((provider) => deps.minted[provider].store.list()),
    ]);
    return heldFrom({
        claude,
        usage,
        cursor,
        devin,
        translator,
        capabilities,
        minted: Object.fromEntries(MINTED_PROVIDERS.map((provider, index) => [provider, minted[index] ?? []])),
    });
};

/** GET /sharing/accounts: the Models page's rows. */
export const shareableOf = (accounts: readonly HeldAccount[]): ShareableAccount[] =>
    accounts.map(({ ref, row, mode, reason }) => ({
        ...ref,
        label: row.label,
        ...opt("email", row.email),
        mode,
        ...opt("reason", reason),
    }));

/** The held account a link's terms name and that may still go that way, or undefined: the doors' one check. */
export const namedHeld = (accounts: readonly HeldAccount[], terms: readonly SharedAccountRef[], ref: SharedAccountRef): HeldAccount | undefined => {
    if (!terms.some((named) => sameSharedRef(named, ref))) {
        return undefined;
    }
    const found = accounts.find((account) => sameSharedRef(account.ref, ref));
    return found === undefined || found.mode === "no" ? undefined : found;
};

/** GET /link/accounts: the rows a link's terms name, as the borrowing side shows them. */
export const linkAccountsOf = (accounts: readonly HeldAccount[], terms: readonly SharedAccountRef[]): LinkAccount[] =>
    terms.flatMap((ref) => {
        const found = namedHeld(accounts, terms, ref);
        return found === undefined || found.mode === "no" ? [] : [{ ...found.row, provider: found.ref.provider, mode: found.mode }];
    });

const isMinted = (provider: string): provider is MintedProvider => MINTED_PROVIDERS.some((minted) => minted === provider);

/** One static account's value, for POST /link/accounts/copy; undefined when it is not (or no longer) held here. */
export const copyOf = async (deps: HeldDeps, ref: SharedAccountRef): Promise<AccountCopy | undefined> => {
    const endpoint = endpointIdOf(ref.provider);
    if (endpoint !== undefined) {
        const capability = (await deps.capabilities.list()).find((candidate) => candidate.id === endpoint);
        return capability?.kind === "endpoint" ? { kind: "endpoint", id: capability.id, config: capability.config } : undefined;
    }
    const id = ref.account;
    if (id === undefined) {
        return undefined;
    }
    if (ref.provider === "cursor") {
        const stored = await deps.cursorStore.read(id);
        return stored === undefined
            ? undefined
            : {
                  kind: "account",
                  account: {
                      apiKey: stored.apiKey,
                      ...opt("label", stored.label),
                      ...opt("email", stored.email),
                      ...opt("apiKeyExpiresAtMs", stored.apiKeyExpiresAtMs),
                      ...opt("backendUrl", stored.backendUrl),
                  },
              };
    }
    if (ref.provider === "devin") {
        const stored = await deps.devinStore.read(id);
        return stored === undefined
            ? undefined
            : { kind: "account", account: { apiKey: stored.apiKey, ...opt("label", stored.label), ...opt("email", stored.email), ...opt("plan", stored.plan) } };
    }
    if (isMinted(ref.provider)) {
        const stored = (await deps.minted[ref.provider].store.credentials()).find((candidate) => candidate.id === id);
        return stored === undefined
            ? undefined
            : {
                  kind: "account",
                  account: { apiKey: stored.apiKey, variant: stored.variant, ...opt("label", stored.label), ...opt("email", stored.email) },
              };
    }
    return undefined;
};
