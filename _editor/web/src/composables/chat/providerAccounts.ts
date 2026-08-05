import type { AgentProvider, OauthAccount, ProviderRefusal, TranslatorAccounts } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { perProvider } from "./providerCatalog";

/* WHO CAN RUN A TURN ON EACH PROVIDER, as this window last heard it: the connected daemon accounts, the
 * translator's own subscriptions, the refusals observed on the way, and the one rule that turns all of that into
 * "the account this conversation's next turn uses".
 *
 * In-memory and NOT persisted like turnDefaults: account ids are daemon-minted per sandbox, so they would be
 * meaningless across a sandbox switch. useChat fills these when a daemon becomes reachable (loadAccountStatus /
 * refreshConnections / refreshTranslatorAccounts) and resetChat clears them. They live here rather than in
 * useChat so a Conversation — and every surface that draws an account — can read them without importing useChat
 * (a cycle). The user's last PICK per provider is a different thing again and persists in accountPreference.ts. */

export const providerAccounts = ref<Record<AgentProvider, readonly OauthAccount[]>>(perProvider<readonly OauthAccount[]>(() => []));
export const selectedAccountId = ref<Record<AgentProvider, string | undefined>>(perProvider<string | undefined>(() => undefined));

// Which SUBSCRIPTIONS the bundled translator holds (codex/grok/kimi/gemini) — the other half of "can this
// provider run", since these authenticate through the translator rather than through a daemon-stored account.
export const translatorAccounts = ref<TranslatorAccounts>({ codex: [], grok: [], kimi: [], gemini: [] });

/* When each provider last REFUSED a turn — a spent plan or a credential the API would not take (see
 * ProviderRefusalSchema). Keyed by provider, because that is the resolution the daemon has for a routed turn.
 *
 * The observed half of "can I run on this", read beside the polled snapshots on the account rows above. Neither
 * is the whole answer: a snapshot can be five minutes stale and account-wide, so a full pool can read as room;
 * a refusal is exact but says nothing about the pools that did not refuse. Shown together, a green meter under
 * a fresh refusal tells the reader the meter is what is wrong — which is the state that sent someone to
 * reconnect a perfectly healthy Kimi account. */
export const providerRefusals = ref<Record<string, ProviderRefusal>>({});

/* Whether the lists above have been READ from this sandbox's daemon yet — the difference between "you have no
 * account" and "we haven't asked". They are the same empty list, and every surface that offers a provider used
 * to state the first while it meant the second: the Agent tab's rows said "not connected" and the composer put
 * up its connect gate, on every page load, for as long as the liveness probe and the tunnel round-trip took —
 * then took it all back when the accounts landed. A claim a UI has to retract is worse than a spinner, so the
 * unknown moment gets a shape of its own (skeleton rows, a "checking…" gate) and this flag is what marks it.
 * Written by useChat (loadAccountStatus / resetChat), and false again for each new sandbox. */
export const accountsLoaded = ref(false);

// The account a turn actually runs on when the conversation hasn't picked one: the daemon resolves undefined
// to its first account, so any reader of account-KEYED state (the usage map above all) must resolve the same
// way — looking up `undefined` misses entries the daemon filed under the real id.
export const effectiveAccount = (provider: AgentProvider, picked: string | undefined): string | undefined =>
    picked ?? providerAccounts.value[provider]?.[0]?.id;

// The account a fresh turn on a provider uses: the user's explicit pick when it's still connected, else the
// provider's first connected account. The single source every account-reset site routes through.
export const rememberedAccountFor = (provider: AgentProvider): string | undefined => {
    // An unseeded provider key (an ACP agent) has no daemon account store — its own credential store serves it.
    const accounts = providerAccounts.value[provider] ?? [];
    const picked = selectedAccountId.value[provider];
    // Before the list has been READ, the persisted pick is the only thing that knows anything, and validating it
    // against a list that is merely unloaded is how a remembered account was lost on every page load: the empty
    // list contains no pick, so every conversation resolved to `undefined` — the daemon's first account — a beat
    // before the real list arrived to agree with the user's choice. Once loaded, a pick the list doesn't contain
    // is genuinely stale (disconnected while this window was away) and the first account serves instead.
    if (!accountsLoaded.value) {
        return picked;
    }
    return accounts.some((account) => account.id === picked) ? picked : accounts[0]?.id;
};

// Light the reauth badge on the account a turn ran under, so the fix is offered where the user already is
// instead of waiting for the next status load to discover it. The turn's own account when it picked one, else
// the one the daemon resolved for it — the same rule every reader of account-keyed state follows.
export const markAccountReauth = (provider: AgentProvider, picked: string | undefined, detail: string): void => {
    const accounts = providerAccounts.value[provider] ?? [];
    const accountId = effectiveAccount(provider, picked);
    const marked = accounts.map((account: OauthAccount) =>
        account.id === accountId ? Object.assign({}, account, { needsReauth: true, detail }) : account,
    );
    providerAccounts.value = { ...providerAccounts.value, [provider]: marked };
};
