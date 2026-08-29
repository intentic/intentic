import { type AgentHarness, type AgentProvider, NATIVE_PROVIDERS, type NativeProvider, type PermissionMode } from "@intentic/sandbox-contract";
// The preference subpath, not the barrel: a chat composable must stay importable without the design system
// (the barrel reaches `document` at module scope, and these run in surfaces and suites that have none).
import { definePreference } from "@intentic/ui/preference";
import { accessKnown, providerReady } from "./access";
import { defaultModelFor, perProvider, providerModels, providerModelsState } from "./providerCatalog";

/* WHAT A NEW CONVERSATION STARTS WITH, the turn prefs the last one left behind. A fresh-conversation provider
 * pick writes back here (Conversation.selectProvider), and useChat's facade setters write model/effort/thinking
 * through, so the next new chat, and the next session, inherit the last-used settings.
 *
 * EACH ONE IS A `definePreference`, which is the load-bearing part rather than a tidier way to call
 * localStorage. These are preferences in that primitive's exact sense, one answer per account, not per window,
 * and the app runs a full copy per browser window (chat/summon.ts). Read once at load into a private ref, they
 * were a different COPY of the preference per window, and the copies never heard about each other: the chat in
 * its own floating window wrote a model pick that the fleet board's window never saw, so "New agent" pressed on
 * the board built the conversation from whatever that window had loaded with, hours earlier, and broadcast it.
 * Every window then showed the stale pick, which is what "it keeps switching my model back" was. The primitive
 * owns the guarded read, the guarded write, and TELLING THE OTHER WINDOWS (a BroadcastChannel plus the browser's
 * own `storage` event), so a pick made anywhere is the pick everywhere, immediately, with no reload.
 *
 * One key per field rather than one blob, because the primitive dispatches an incoming change by key: a model
 * pick then travels as a model pick, and cannot carry a stale copy of the effort beside it. Each `read`
 * validates its own field, so a value from an older build or a hand-edited one degrades to the default;
 * model/effort stay plain strings, a stored effort is a PICK, and Conversation.effort clamps it to whatever the
 * provider+model it lands on offers. */

// Per-provider NATIVE model map: a stored string per provider, each degrading to that provider's native default
// when absent or malformed. The single point that parses the persisted record. (Claude-Code-harness models are
// deterministic, gpt-5-codex / grok-4, so they aren't persisted; rememberedModelFor derives them.)
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

// The turn prefs a NEW conversation seeds from. The permission mode is NOT one of them; it comes from
// startingMode() per conversation.
export const turnDefaults = {
    provider: definePreference<AgentProvider>({
        key: `ui-chat-provider`,
        // Only a native provider is restored: an ACP agent's id belongs to a capability that may no longer be
        // installed on the sandbox this session opens, so it degrades to Claude rather than to a dead picker.
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
    effort: definePreference<string>({
        key: `ui-chat-effort`,
        read: (raw) => raw ?? `xhigh`,
        write: (effort) => effort,
    }),
    thinking: definePreference<boolean>({
        key: `ui-chat-thinking`,
        read: (raw) => raw !== `false`,
        write: String,
    }),
};

/* THE PROVIDER A FRESH CONVERSATION STARTS ON: the user's remembered pick when it can actually run, else the
 * first one that can. RESOLVED AT READ, never written back over the pick.
 *
 * The distinction is the whole point. Falling back used to happen by REWRITING this preference, so a user whose
 * Claude account was merely slow to load one time opened every session afterwards on ChatGPT, with nothing left
 * anywhere to say they had ever chosen otherwise. Resolving instead means a pick that cannot run today costs one
 * substitution today and is honoured again the moment its provider is back, the same rule rememberedAccountFor
 * follows for the account, and for the same reason.
 *
 * The unloaded case rides the pick untouched: before the connection lists have been READ, an empty list is
 * "we haven't asked", not "you have nothing connected", and resolving against it would open every session on
 * whichever provider's read happened to answer first. BOTH halves of that picture have to be in (accessKnown):
 * the endpoints land later than the accounts, and substituting against the accounts alone moved a fresh chat off
 * the user's pick a beat before the free trial arrived to say it could have stayed. */
export const rememberedProviderFor = (): AgentProvider => {
    const picked = turnDefaults.provider.value;
    if (!accessKnown.value || providerReady(picked)) {
        return picked;
    }
    return NATIVE_PROVIDERS.find((provider) => providerReady(provider)) ?? picked;
};

/* THE MODEL A FRESH CONVERSATION STARTS ON for a provider: the one the user last picked for it when that
 * provider's catalog still offers it, else the provider's default. RESOLVED AT READ, never written back over
 * the pick, which is the rule rememberedProviderFor states above and rememberedAccountFor states for the
 * account, and it is here for their reason.
 *
 * The pick used to be REWRITTEN whenever a catalog landed without it in (useChat.loadProviderModels), and that
 * write was persisted, so a catalog read that answered thinly, or answered for a provider mid-restart, spent
 * the user's choice permanently: from then on every new chat opened on the daemon's default with nothing left
 * anywhere to say otherwise. Resolving instead costs one substitution while the id is genuinely missing and
 * honours the pick again the moment the catalog carries it.
 *
 * The unloaded case rides the pick untouched, for `accountsLoaded`'s reason: a catalog nobody has fetched yet
 * is an empty list that means "we haven't asked", and resolving against it would open every session on the
 * static floor. `providerModelsState` is what tells the two apart.
 *
 * Harness-independent, the model survives a harness switch (the catalog is shared), so switching Default ↔
 * Claude Code keeps the chosen model. The single source every model-reset site routes through. */
export const rememberedModelFor = (provider: AgentProvider): string => {
    const picked = turnDefaults.models.value[provider] || defaultModelFor(provider);
    if (providerModelsState.value[provider] !== `loaded`) {
        return picked;
    }
    const catalog = providerModels.value[provider] ?? [];
    return catalog.some((option) => option.value === picked) ? picked : defaultModelFor(provider);
};

// The posture a conversation STARTS in, by where it works. An isolated conversation owns a throwaway worktree
// inside the sandbox container, the container is the isolation boundary, so it runs unattended and never asks;
// a main-tree conversation edits the workspace the user is looking at, so it proposes a plan first.
// Deliberately NOT persisted with the turn prefs above: the permission mode is a per-task posture, and the
// agent moves it mid-turn (EnterPlanMode), so a remembered value means one agent's escalation silently becomes
// every later agent's starting mode.
export const startingMode = (isolated: boolean): PermissionMode => (isolated ? `bypassPermissions` : `plan`);
