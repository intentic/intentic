import { aiAccountKey } from "@intentic/sandbox-contract/schemas/members";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { TranslatorAccount } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { PickEntry, PickOption } from "../pick/multiPick";

// THE AI ACCOUNTS A PERSON CAN BE HELD TO, as one list: every account a provider holds, by the key the daemon judges a
// turn by (sandbox-contract `aiAccountKey`, read at planning by the daemon's agent/run/decide/account-reach.ts), and
// every provider that holds none of its own (an API-key endpoint, an installed agent, the free trial) by its own id.
// The accounts of one provider sit together as a family the owner can hand over whole; a local model spends nobody's
// allowance, so it is never a row, only named as always available. Pure, so what the picker offers is read and tested
// here rather than in its template.

/** What a provider holding no accounts of its own is, for the note beside it. */
export type AccountlessKind = `endpoint` | `agent`;

export interface AiAccountSources {
    // The providers in the order the sandbox lists them, each with the accounts its own door holds and the ones the
    // translator holds for it: the same two places the daemon's account list reads (serviceability.ts accountFactsOf).
    readonly providers: readonly { readonly id: AgentProvider; readonly label: string; readonly native: readonly OauthAccount[]; readonly routed: readonly TranslatorAccount[] }[];
    readonly endpoints: readonly { readonly id: AgentProvider; readonly label: string; readonly kind: `endpoint` | `localmodel` }[];
    readonly agents: readonly { readonly id: AgentProvider; readonly label: string }[];
}

export interface AiAccountRows {
    readonly entries: readonly PickEntry[];
    // The provider each value is an account of, for its mark.
    readonly providerOf: ReadonlyMap<string, AgentProvider>;
    // Local models: available to everyone, since running one spends no allowance.
    readonly alwaysAvailable: readonly string[];
}

// One account's row: its own name, and who it signs in as where that says more than the name does.
const accountOption = (provider: AgentProvider, id: string, label: string, email: string | undefined, note: string | undefined): PickOption => ({
    value: aiAccountKey(provider, id),
    label,
    detail: email === undefined || email === label ? undefined : email,
    note,
});

export const aiAccountRows = (sources: AiAccountSources, noteOf: (kind: AccountlessKind) => string): AiAccountRows => {
    const providerOf = new Map<string, AgentProvider>();
    const entries: PickEntry[] = [];
    for (const provider of sources.providers) {
        const options = [
            ...provider.native.map((account) => accountOption(provider.id, account.id, account.label, account.email, provider.label)),
            ...provider.routed.map((account) => accountOption(provider.id, account.name, account.label, undefined, provider.label)),
        ];
        for (const option of options) {
            providerOf.set(option.value, provider.id);
        }
        const [only, ...rest] = options;
        if (only === undefined) {
            continue;
        }
        // Every row keeps its provider's name: a short list is drawn flat, with no family header to say whose it is.
        entries.push(rest.length === 0 ? only : { family: provider.id, label: provider.label, lead: only.value, options });
    }
    const accountless = [
        ...sources.endpoints.filter((endpoint) => endpoint.kind === `endpoint`).map((endpoint) => ({ ...endpoint, kind: `endpoint` as const })),
        ...sources.agents.map((agent) => ({ ...agent, kind: `agent` as const })),
    ];
    for (const provider of accountless) {
        const value = aiAccountKey(provider.id);
        providerOf.set(value, provider.id);
        entries.push({ value, label: provider.label, note: noteOf(provider.kind) });
    }
    return {
        entries,
        providerOf,
        alwaysAvailable: sources.endpoints.filter((endpoint) => endpoint.kind === `localmodel`).map((endpoint) => endpoint.label),
    };
};
