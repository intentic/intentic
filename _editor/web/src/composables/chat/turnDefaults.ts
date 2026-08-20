import { type AgentHarness, type AgentProvider, NATIVE_PROVIDERS, type NativeProvider, type PermissionMode } from "@intentic/sandbox-contract";
import { ref, watch } from "vue";
import { providerReady } from "./access";
import { accountsLoaded } from "./providerAccounts";
import { defaultModelFor, perProvider } from "./providerCatalog";

/* WHAT A NEW CONVERSATION STARTS WITH, the turn prefs the last one left behind, persisted across reloads as one
 * JSON blob. A fresh-conversation provider pick writes back here (Conversation.selectProvider), and useChat's
 * facade setters write model/effort/thinking through, so the next new chat, and the next session, inherit the
 * last-used settings.
 *
 * Restored values are validated per field (enum for provider, boolean for thinking) so a stale or hand-edited
 * entry degrades to the defaults; model/effort stay plain strings, a stored effort is a PICK, and
 * Conversation.effort clamps it to whatever the provider+model it lands on offers. */

const TURN_DEFAULTS_KEY = `intentic.turnDefaults`;

interface TurnDefaults {
    readonly provider: AgentProvider;
    readonly harness: AgentHarness;
    readonly models: Record<AgentProvider, string>;
    readonly effort: string;
    readonly thinking: boolean;
}

// Per-provider NATIVE model map: a stored string per provider, each degrading to that provider's native default
// when absent or malformed. The single point that parses the persisted record. (Claude-Code-harness models are
// deterministic, gpt-5-codex / grok-4, so they aren't persisted; rememberedModelFor derives them.)
const readModels = (stored: unknown): Record<AgentProvider, string> => {
    const raw = (typeof stored === `object` && stored !== null ? stored : {}) as Record<string, unknown>;
    return perProvider((provider) => (typeof raw[provider] === `string` ? (raw[provider] as string) : defaultModelFor(provider)));
};

const readTurnDefaults = (): TurnDefaults => {
    const fallback: TurnDefaults = {
        provider: `claude`,
        harness: `native`,
        models: readModels(undefined),
        effort: `xhigh`,
        thinking: true,
    };
    try {
        const raw = localStorage.getItem(TURN_DEFAULTS_KEY);
        if (raw === null) {
            return fallback;
        }
        const stored = JSON.parse(raw) as Record<string, unknown>;
        return {
            // Only a native provider is restored: an ACP agent's id belongs to a capability that may no longer be
            // installed on the sandbox this session opens, so it degrades to Claude rather than to a dead picker.
            provider: NATIVE_PROVIDERS.includes(stored[`provider`] as NativeProvider) ? (stored[`provider`] as AgentProvider) : `claude`,
            harness: stored[`harness`] === `claude-code` ? `claude-code` : `native`,
            models: readModels(stored[`models`]),
            effort: typeof stored[`effort`] === `string` ? stored[`effort`] : fallback.effort,
            thinking: typeof stored[`thinking`] === `boolean` ? stored[`thinking`] : fallback.thinking,
        };
    } catch {
        return fallback;
    }
};

const seed = readTurnDefaults();

// The turn prefs a NEW conversation seeds from. The permission mode is NOT one of them; it comes from
// startingMode() per conversation.
export const turnDefaults = {
    provider: ref<AgentProvider>(seed.provider),
    harness: ref<AgentHarness>(seed.harness),
    models: ref<Record<AgentProvider, string>>(seed.models),
    effort: ref<string>(seed.effort),
    thinking: ref<boolean>(seed.thinking),
};

watch(
    [turnDefaults.provider, turnDefaults.harness, turnDefaults.models, turnDefaults.effort, turnDefaults.thinking],
    ([provider, harness, models, effort, thinking]) => {
        try {
            localStorage.setItem(TURN_DEFAULTS_KEY, JSON.stringify({ provider, harness, models, effort, thinking }));
        } catch {
            // Storage may be unavailable (private mode); the in-memory refs still hold.
        }
    },
);

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
 * whichever provider's read happened to answer first. */
export const rememberedProviderFor = (): AgentProvider => {
    const picked = turnDefaults.provider.value;
    if (!accountsLoaded.value || providerReady(picked)) {
        return picked;
    }
    return NATIVE_PROVIDERS.find((provider) => providerReady(provider)) ?? picked;
};

// The model to restore for a provider: the one the user last picked for it (persisted), else the provider's
// default. Harness-independent, the model survives a harness switch (the catalog is shared), so switching
// Default ↔ Claude Code keeps the chosen model. The single source every model-reset site routes through.
export const rememberedModelFor = (provider: AgentProvider): string => turnDefaults.models.value[provider] || defaultModelFor(provider);

// The posture a conversation STARTS in, by where it works. An isolated conversation owns a throwaway worktree
// inside the sandbox container, the container is the isolation boundary, so it runs unattended and never asks;
// a main-tree conversation edits the workspace the user is looking at, so it proposes a plan first.
// Deliberately NOT persisted with the turn prefs above: the permission mode is a per-task posture, and the
// agent moves it mid-turn (EnterPlanMode), so a remembered value means one agent's escalation silently becomes
// every later agent's starting mode.
export const startingMode = (isolated: boolean): PermissionMode => (isolated ? `bypassPermissions` : `plan`);
