import { type AgentHarness, type AgentProvider, NATIVE_PROVIDERS, type NativeProvider, type PermissionMode } from "@intentic/sandbox-contract";
import { definePreference } from "@intentic/ui/preference";
import { accessKnown, providerReady } from "../session/access";
import { DEFAULT_EFFORT, DEFAULT_THINKING } from "../models/pickerRunSettings";
import { defaultModelFor, perProvider, providerModels, providerModelsState } from "../accounts/providerCatalog";

// What a new conversation starts on: the composer's last deliberate pick (model, provider, effort), never a fallback or
// a thin catalog read — those resolve at read time instead, so bad luck can't overwrite a real choice. Each field is a
// definePreference, syncing the pick across every window immediately, since the app runs a full copy per window.

// Per-provider native model map, each entry degrading to that provider's default when absent or malformed; the one
// place that parses the persisted record.
const readModels = (raw: string | null): Record<AgentProvider, string> => {
    let stored: unknown;
    try {
        stored = raw === null ? undefined : JSON.parse(raw);
    } catch {
        stored = undefined;
    }
    const entries = (typeof stored === `object` && stored !== null ? stored : {}) as Record<string, unknown>;
    return perProvider((provider) => (typeof entries[provider] === `string` ? (entries[provider] as string) : defaultModelFor(provider)));
};

// Turn prefs a new conversation seeds from; permission mode is not one of them (see startingMode, per conversation).
export const turnDefaults = {
    provider: definePreference<AgentProvider>({
        key: `ui-chat-provider`,
        // Only a native provider is restored: an ACP agent's id may name a capability no longer installed, so it
        // degrades to Claude rather than a dead picker.
        read: (raw) => (NATIVE_PROVIDERS.includes(raw as NativeProvider) ? (raw as AgentProvider) : `claude`),
        write: (provider) => provider,
    }),
    harness: definePreference<AgentHarness>({
        key: `ui-chat-harness`,
        read: (raw) => (raw === `claude-code` ? `claude-code` : `native`),
        write: (harness) => harness,
    }),
    models: definePreference<Record<AgentProvider, string>>({
        key: `ui-chat-models`,
        read: readModels,
        write: (models) => JSON.stringify(models),
    }),
    // The two fallbacks are the pickers' own opening state (pickerRunSettings.ts), imported rather than spelled
    // again: a conversation that starts on one tier while every picker opens on another is two answers to one
    // question, and nothing would have caught them drifting apart.
    effort: definePreference<string>({
        key: `ui-chat-effort`,
        read: (raw) => raw ?? DEFAULT_EFFORT,
        write: (effort) => effort,
    }),
    thinking: definePreference<boolean>({
        key: `ui-chat-thinking`,
        read: (raw) => (raw === null ? DEFAULT_THINKING : raw !== `false`),
        write: String,
    }),
};

// A turn's model choice as one value: provider and model id travel together everywhere a pick does, since an id alone
// is meaningless (the same id can name different models on different providers). `value`, not `model`, so a picker row
// IS a pick.
export interface TurnPick {
    readonly provider: AgentProvider;
    readonly value: string;
}

// Writes provider and model together, as one pick, so the two can never disagree: previously two separate writers could
// record a chosen model under whichever provider a different tab had last switched to. Callers state a pick; they never
// poke the storage directly.
export const rememberPick = (pick: TurnPick): void => {
    turnDefaults.provider.value = pick.provider;
    // Per-provider, so switching away and back restores each provider's own remembered model, across a harness switch
    // too.
    turnDefaults.models.value = { ...turnDefaults.models.value, [pick.provider]: pick.value };
};

// The user's pick when it can actually run, else the first provider that can — resolved at read, never written back
// over the pick, so a provider merely slow to load once doesn't cost the choice forever. Before the connection lists
// are read (accessKnown), the pick rides through untouched: an empty list there means "haven't asked", not "nothing
// connected".
export const rememberedProviderFor = (): AgentProvider => {
    const picked = turnDefaults.provider.value;
    if (!accessKnown.value || providerReady(picked)) {
        return picked;
    }
    return NATIVE_PROVIDERS.find((provider) => providerReady(provider)) ?? picked;
};

// Same rule as rememberedProviderFor, for the model: the picked value when the provider's loaded catalog still offers
// it, else the provider's default, resolved at read rather than rewritten when a catalog answers thinly.
// Harness-independent, since the catalog is shared across a harness switch.
export const rememberedModelFor = (provider: AgentProvider): string => {
    const picked = turnDefaults.models.value[provider] || defaultModelFor(provider);
    if (providerModelsState.value[provider] !== `loaded`) {
        return picked;
    }
    const catalog = providerModels.value[provider] ?? [];
    return catalog.some((option) => option.value === picked) ? picked : defaultModelFor(provider);
};

// An isolated conversation (its own throwaway worktree) runs unattended; a main-tree one proposes a plan first. Not
// persisted with the turn prefs: this is a per-task posture the agent can escalate mid-turn, and remembering it would
// leak one agent's escalation onto the next agent's start.
export const startingMode = (isolated: boolean): PermissionMode => (isolated ? `bypassPermissions` : `plan`);
