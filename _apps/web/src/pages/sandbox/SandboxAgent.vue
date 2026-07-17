<script setup lang="ts">
import type { KeyedProvider, TranslatorAccounts } from "@intentic/sandbox-contract";
import { Card, cmp, CopyButton } from "@intentic-app/ui";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { providerTabs } from "../../composables/chat/conversation";
import { useChat } from "../../composables/chat/useChat";
import { sandboxJson, sandboxRequest } from "../../composables/sandbox/sandboxClient";
import { IMPORT_PROMPT, MEMORY_FILES, mergeMemory } from "../../composables/extensions/memoryImport";
import { useCleanerSavings } from "../../composables/sandbox/useCleanerSavings";
import { useSandboxSettings } from "../../composables/sandbox/useSandboxSettings";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";

/* The Sandbox hub's "Agent" tab — the home for everything about the AI the sandbox runs. The AI provider
 * accounts (Claude / ChatGPT / Grok) it authenticates as, its behavior settings (search past chats), and the
 * import-memory tool. Accounts and memory live INSIDE the sandbox, never on the platform, which is why this is
 * a sandbox tab. The account surface reuses useChat's handshake paths unchanged; opening the tab loads usage
 * and preps the provider (openAccountManage); closing it just hides the card (closeAccountManage) — an in-flight
 * connect keeps running so a device sign-in the user is completing at x.ai / ChatGPT still lands. */

const sandbox = useSandbox();

// --- AI provider accounts (was the global AccountManageDialog) ---------------------------------------------
const {
    managedProvider,
    setManagedProvider,
    managedAccounts,
    authorizeUrl,
    userCode,
    connectLabel,
    accountUsage,
    error: chatError,
    openAccountManage,
    closeAccountManage,
    startConnect,
    completeConnect,
    disconnect,
} = useChat();

onMounted(() => {
    openAccountManage();
    void loadTranslatorAccounts();
});
onUnmounted(() => {
    closeAccountManage();
    stopAccountsPoll();
});

// --- Routed-provider subscriptions (Codex/Grok UNDER the Claude Code harness) -------------------------------
// Running Codex or Grok on the Claude Code harness routes their model through the sandbox's translator
// (CLIProxyAPI), which serves them on the user's SUBSCRIPTION OAuth — connect it here with a device-code login
// (open a URL, enter the code). The translator finishes the login in the background, so we poll `accounts` until
// the provider flips connected.
const translatorAccounts = ref<TranslatorAccounts>({ codex: false, grok: false });
const connectBusy = ref<KeyedProvider | undefined>(undefined);
const connectFlow = ref<{ provider: KeyedProvider; url: string; code: string } | undefined>(undefined);
let accountsPoll: ReturnType<typeof setInterval> | undefined;

const loadTranslatorAccounts = async (): Promise<void> => {
    try {
        translatorAccounts.value = await sandboxJson<TranslatorAccounts>(`/translator/accounts`);
    } catch {
        // Non-fatal; the card shows "not connected" until the sandbox is reachable.
    }
};

const stopAccountsPoll = (): void => {
    if (accountsPoll !== undefined) {
        clearInterval(accountsPoll);
        accountsPoll = undefined;
    }
};

const pollUntilConnected = (provider: KeyedProvider): void => {
    stopAccountsPoll();
    accountsPoll = setInterval(() => {
        void loadTranslatorAccounts().then(() => {
            if (translatorAccounts.value[provider]) {
                stopAccountsPoll();
                if (connectFlow.value?.provider === provider) {
                    connectFlow.value = undefined;
                }
            }
        });
    }, 3_000);
};

const connectSubscription = async (provider: KeyedProvider): Promise<void> => {
    if (connectBusy.value !== undefined) {
        return;
    }
    connectBusy.value = provider;
    try {
        connectFlow.value = { provider, ...(await sandboxJson<{ url: string; code: string }>(`/translator/${provider}/connect`, { method: `POST` })) };
        pollUntilConnected(provider);
    } finally {
        connectBusy.value = undefined;
    }
};

const disconnectSubscription = async (provider: KeyedProvider): Promise<void> => {
    connectBusy.value = provider;
    try {
        await sandboxRequest(`/translator/${provider}/disconnect`, { method: `POST` });
        if (connectFlow.value?.provider === provider) {
            connectFlow.value = undefined;
        }
        await loadTranslatorAccounts();
    } finally {
        connectBusy.value = undefined;
    }
};

const SUBSCRIPTION_FIELDS = [
    { provider: `codex` as const, label: `ChatGPT (Codex)`, hint: `Open ChatGPT, sign in, and enter this one-time code.` },
    { provider: `grok` as const, label: `SuperGrok (Grok)`, hint: `Open x.ai with your SuperGrok / X Premium account and enter this code.` },
];

// Compact "142k" token count and a short usage summary line per account (from /system/usage).
const shortTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const usageLine = (id: string): string | undefined => {
    const usage = accountUsage.value[id];
    if (usage === undefined || usage.turns === 0) {
        return undefined;
    }
    const cost = usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(2)}` : ``;
    // Cache read = prompt tokens served from the provider's cache; the rate is the share of prompt input that
    // hit the cache (read / (read + uncached input)) — how effective prefix caching is for this account.
    const cacheDenom = usage.cacheReadTokens + usage.inputTokens;
    const cache =
        usage.cacheReadTokens > 0 && cacheDenom > 0
            ? ` · ${shortTokens(usage.cacheReadTokens)} cached (${Math.round((100 * usage.cacheReadTokens) / cacheDenom)}%)`
            : ``;
    return `${usage.turns} turns · ${shortTokens(usage.inputTokens)} in / ${shortTokens(usage.outputTokens)} out${cache}${cost}`;
};

// The flows differ: Anthropic shows a code on its hosted page to paste back; ChatGPT uses a device code (the
// user enters it on OpenAI's page and this panel connects on its own); Grok (xAI OAuth) opens x.ai on any
// device and connects on approval (a paste-back code only for the non-device method).
const connectHint = computed(() =>
    managedProvider.value === `codex`
        ? `Open ChatGPT, sign in, and enter this one-time code — the app connects automatically.`
        : managedProvider.value === `grok`
          ? `Open x.ai on any device with your SuperGrok / X Premium account and approve — this connects on its own.`
          : `Open Anthropic to authorize, then paste the code it shows you.`,
);
const openLabel = computed(() =>
    managedProvider.value === `codex` ? `Open ChatGPT` : managedProvider.value === `grok` ? `Open x.ai` : `Open Anthropic`,
);
const pastePlaceholder = computed(() => (managedProvider.value === `codex` ? `Paste localhost URL…` : `Paste code…`));
// Grok holds a single account (OpenCode owns the xAI credential), so hide "connect another" once it's linked.
const canConnectMore = computed(() => managedProvider.value !== `grok` || managedAccounts.value.length === 0);
// A connect handshake is live once startConnect has produced its authorize URL / device code.
const connecting = computed(() => authorizeUrl.value !== null);

const connectCode = ref(``);
const finishConnect = async (): Promise<void> => {
    const code = connectCode.value.trim();
    if (code.length === 0) {
        return;
    }
    const ok = await completeConnect(code);
    if (ok) {
        connectCode.value = ``;
    }
};

// --- Agent behavior: search past chats (per-sandbox, daemon .intentic/settings.json) -----------------------
const { settings: sandboxSettings, save: saveSandboxSettings } = useSandboxSettings();

// The daemon overwrites the whole settings object, so spread the current settings and flip just this flag. The
// toggle is disabled until settings load, so a defined value is guaranteed by the time this fires.
const toggleSearchPastChats = (value: boolean): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, searchPastChats: value });
};

// Output cleaning is a spec string ("" = all cleaners on, "off" = disabled), not a bool; this toggle covers the
// common on/off. A finer spec (e.g. "-cap", "git,pnpm") for benchmarking specific cleaners is set via /settings.
const toggleOutputCleaning = (value: boolean): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, outputCleaners: value ? "" : "off" });
};

// Verbosity steering: steer the assistant to answer concisely, cutting its own output tokens.
const toggleTerseOutput = (value: boolean): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, terseOutput: value });
};

// iq code search: load the iq plugin so the agent reaches for the iq CLI over grep/find/glob.
const toggleIqSearch = (value: boolean): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, iqSearch: value });
};

// --- Per-cleaner toggles (the `outputCleaners` spec, edited as a checklist) ---------------------------------
// Every cleaner id + a short label, in the order of bin/cleaners.mjs CLEANERS (keep in sync). Each renders one
// switch; the checklist round-trips through the spec string the daemon already threads to the filter, so every
// cleaner is individually A/B-benchmarkable without touching the settings JSON by hand.
const CLEANER_OPTIONS = [
    { id: `npm`, label: `npm / npx` },
    { id: `pnpm`, label: `pnpm` },
    { id: `yarn`, label: `yarn` },
    { id: `docker`, label: `docker` },
    { id: `git`, label: `git` },
    { id: `pip`, label: `pip` },
    { id: `apt`, label: `apt` },
    { id: `test`, label: `test runners` },
    { id: `lint`, label: `tsc / eslint` },
    { id: `ls`, label: `ls listings` },
    { id: `gh`, label: `gh CLI` },
    { id: `build`, label: `cargo / go` },
    { id: `dedup`, label: `dedupe repeats` },
    { id: `cap`, label: `head/tail cap` },
    { id: `redact`, label: `redact secrets` },
    { id: `cache`, label: `collapse repeats` },
];
const ALL_CLEANER_IDS = CLEANER_OPTIONS.map((cleaner) => cleaner.id);

// Which cleaners the current spec enables (mirrors bin/cleaners.mjs parseCleaners, lenient): "" = all on, an
// allow-list ("git,pnpm") = only those, default-minus ("-cap") = all except. "off" (master off) = none.
const enabledCleaners = computed<Set<string>>(() => {
    const spec = sandboxSettings.value?.outputCleaners ?? ``;
    if (spec === `off`) {
        return new Set();
    }
    const tokens = spec
        .split(`,`)
        .map((token) => token.trim())
        .filter((token) => token !== `` && ALL_CLEANER_IDS.includes(token.replace(/^-/, ``)));
    if (tokens.length === 0) {
        return new Set(ALL_CLEANER_IDS);
    }
    if (tokens.some((token) => !token.startsWith(`-`))) {
        return new Set(tokens.filter((token) => !token.startsWith(`-`)));
    }
    const disabled = new Set(tokens.map((token) => token.slice(1)));
    return new Set(ALL_CLEANER_IDS.filter((id) => !disabled.has(id)));
});

// Emit the shortest spec that expresses `enabled`: "" (all), the allow-list, or the default-minus form.
const specFromEnabled = (enabled: Set<string>): string => {
    const disabled = ALL_CLEANER_IDS.filter((id) => !enabled.has(id));
    if (disabled.length === 0) {
        return ``;
    }
    if (enabled.size === 0) {
        return `off`;
    }
    return disabled.length <= enabled.size ? disabled.map((id) => `-${id}`).join(`,`) : [...enabled].join(`,`);
};

const toggleCleaner = (id: string, on: boolean): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    const enabled = new Set(enabledCleaners.value);
    if (on) {
        enabled.add(id);
    } else {
        enabled.delete(id);
    }
    saveSandboxSettings.mutate({ ...current, outputCleaners: specFromEnabled(enabled) });
};

// Holdout control: a percentage [0,100] of commands whose output bypasses cleaning, stored as a fraction [0,1].
const holdoutPercent = computed<number>(() => Math.round((sandboxSettings.value?.outputHoldout ?? 0) * 100));
const setHoldoutPercent = (percent: number): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    const clamped = Math.min(100, Math.max(0, Math.round(percent)));
    saveSandboxSettings.mutate({ ...current, outputHoldout: clamped / 100 });
};

// Cleaner backend: native (agent-output-filter) vs rtk (the rtk extension binary, rewritten at the hook).
const setFilterBackend = (backend: `native` | `rtk`): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, filterBackend: backend });
};

// The savings report (rtk-`gain` surface) over the live filter-stats ledger.
const { savings } = useCleanerSavings();
const cleaningOn = computed(() => (sandboxSettings.value?.outputCleaners ?? ``) !== `off`);

// --- Import memory (was ImportMemoryDialog) ----------------------------------------------------------------
const { readFile, saveText } = useWorkspaceTree();
const importText = ref(``);
const importSaving = ref(false);
const importError = ref<string | undefined>(undefined);
const importMemory = async (): Promise<void> => {
    const text = importText.value.trim();
    if (text === `` || importSaving.value) {
        return;
    }
    importSaving.value = true;
    importError.value = undefined;
    try {
        for (const file of MEMORY_FILES) {
            // readFile throws on a missing file (first import) — treat that as an empty starting point.
            const current = await readFile(file).catch(() => ``);
            await saveText(file, mergeMemory(current, text));
        }
        importText.value = ``;
    } catch (caught) {
        importError.value = caught instanceof Error ? caught.message : `Couldn't save memory.`;
    } finally {
        importSaving.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-2.5">
        <!-- AI provider accounts the agent runs as. -->
        <Card class="flex flex-col gap-3">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div class="flex items-center gap-2.5">
                    <Icon name="sparkles" class="text-lg text-link" />
                    <div>
                        <h2 class="font-semibold leading-tight">AI account</h2>
                        <p class="text-xs text-muted">The account Claude Code signs in as. Stored inside your sandbox, never on the platform.</p>
                    </div>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                    <button
                        v-for="tab in providerTabs"
                        :key="tab.value"
                        type="button"
                        class="composer-ghost h-6 px-2 text-2xs font-medium"
                        :class="{ 'composer-active': managedProvider === tab.value }"
                        @click="setManagedProvider(tab.value)"
                        :aria-pressed="managedProvider === tab.value"
                    >
                        {{ tab.label }}
                    </button>
                </div>
            </div>

            <p v-if="chatError" class="text-2xs text-danger">{{ chatError }}</p>

            <!-- Connected accounts for the managed provider; each can be disconnected independently. -->
            <ul v-if="managedAccounts.length > 0" class="flex flex-col gap-1">
                <li
                    v-for="account in managedAccounts"
                    :key="account.id"
                    class="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
                    :class="account.needsReauth ? 'border-warning/40 bg-warning/10' : 'border-line bg-card'"
                >
                    <span class="flex min-w-0 flex-col">
                        <span class="flex min-w-0 items-center gap-2">
                            <Icon name="circle-fill" class="text-[0.5rem]" :class="account.needsReauth ? 'text-warning' : 'text-success'" />
                            <span class="truncate text-2xs text-content">{{ account.label }}</span>
                        </span>
                        <!-- A revoked/expired credential explains itself and offers reconnect; else the usage line. -->
                        <span v-if="account.needsReauth" class="pl-3.5 text-[0.65rem] text-warning">{{
                            account.detail ?? `Reconnect to keep using this account.`
                        }}</span>
                        <span v-else-if="usageLine(account.id)" class="pl-3.5 text-[0.65rem] text-subtle">{{ usageLine(account.id) }}</span>
                    </span>
                    <div class="flex shrink-0 items-center gap-1">
                        <Button v-if="account.needsReauth && canConnectMore" label="Re-log in" size="small" @click="startConnect">
                            <template #icon><Icon name="link" /></template>
                        </Button>
                        <Button label="Disconnect" size="small" severity="danger" :text="true" @click="disconnect(account.id)">
                            <template #icon><Icon name="sign-out" /></template>
                        </Button>
                    </div>
                </li>
            </ul>
            <p v-else class="text-2xs text-subtle">No {{ providerTabs.find((t) => t.value === managedProvider)?.label }} account connected yet.</p>

            <!-- Connect another account: a labelled sign-in handshake (kicked off on demand so the open-URL anchor
                 is a real user gesture, never a blocked programmatic popup). -->
            <div v-if="canConnectMore" class="flex flex-col gap-2 border-t border-line pt-2">
                <Button v-if="!connecting" label="Connect another account" size="small" @click="startConnect">
                    <template #icon><Icon name="link" /></template>
                </Button>
                <template v-else>
                    <p class="text-2xs text-subtle">{{ connectHint }}</p>
                    <input
                        v-model="connectLabel"
                        name="accountLabel"
                        placeholder="Account name (optional)"
                        class="min-w-0 rounded-md border border-line bg-card px-3 py-1.5 text-sm text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                    />
                    <template v-if="managedProvider === `codex`">
                        <div v-if="userCode" class="flex flex-col items-center gap-1 rounded-md border border-line bg-card py-2">
                            <span class="text-2xs text-subtle">Your one-time code</span>
                            <span class="font-mono text-lg font-semibold tracking-[0.2em] text-content">{{ userCode }}</span>
                            <CopyButton :text="userCode ?? ``" label="Copy" />
                        </div>
                        <div class="flex items-center gap-2">
                            <Button
                                v-if="authorizeUrl"
                                as="a"
                                :label="openLabel"
                                size="small"
                                severity="secondary"
                                :href="authorizeUrl"
                                target="_blank"
                                rel="noopener"
                            >
                                <template #icon><Icon name="external-link" /></template>
                            </Button>
                            <span v-if="userCode" class="text-2xs text-subtle"
                                ><Icon name="spinner" class="mr-1" spin />Waiting for you to finish signing in…</span
                            >
                        </div>
                    </template>
                    <template v-else-if="managedProvider === `grok`">
                        <div v-if="userCode" class="flex flex-col items-center gap-1 rounded-md border border-line bg-card py-2">
                            <span class="text-2xs text-subtle">Code (already filled in at x.ai — just approve)</span>
                            <span class="font-mono text-lg font-semibold tracking-[0.2em] text-content">{{ userCode }}</span>
                            <CopyButton :text="userCode ?? ``" label="Copy" />
                        </div>
                        <div class="flex items-center gap-2">
                            <Button
                                v-if="authorizeUrl"
                                as="a"
                                :label="openLabel"
                                size="small"
                                severity="secondary"
                                :href="authorizeUrl"
                                target="_blank"
                                rel="noopener"
                            >
                                <template #icon><Icon name="external-link" /></template>
                            </Button>
                            <span v-if="userCode" class="text-2xs text-subtle"
                                ><Icon name="spinner" class="mr-1" spin />Waiting for you to approve…</span
                            >
                        </div>
                    </template>
                    <div v-else class="flex flex-col gap-2">
                        <div class="flex items-center gap-2">
                            <Button
                                v-if="authorizeUrl"
                                as="a"
                                :label="openLabel"
                                size="small"
                                severity="secondary"
                                :href="authorizeUrl"
                                target="_blank"
                                rel="noopener"
                            >
                                <template #icon><Icon name="external-link" /></template>
                            </Button>
                        </div>
                        <div class="flex gap-2">
                            <input
                                v-model="connectCode"
                                name="connectCode"
                                :placeholder="pastePlaceholder"
                                class="min-w-0 flex-1 rounded-md border border-line bg-card px-3 py-1.5 text-sm text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                                @keydown.enter="finishConnect"
                            />
                            <Button label="Finish" size="small" :disabled="connectCode.trim().length === 0" @click="finishConnect" />
                        </div>
                    </div>
                </template>
            </div>
        </Card>

        <!-- Run Codex / Grok under Claude Code — connect the ChatGPT / SuperGrok subscription that serves them when
             they run UNDER the Claude Code harness (their model routes through the sandbox's translator, CLIProxyAPI,
             on your subscription OAuth — no API key). A device-code login: open the URL, enter the code. -->
        <Card class="flex flex-col gap-3">
            <div class="flex items-center gap-2.5">
                <Icon name="link" class="text-lg text-muted" />
                <div class="min-w-0">
                    <h2 class="font-semibold leading-tight">Run Codex / Grok under Claude Code</h2>
                    <p class="text-xs text-muted">
                        Connect your <span class="font-medium text-content">ChatGPT / SuperGrok subscription</span> to run these models under the
                        Claude Code harness — no API key, it uses your subscription.
                    </p>
                </div>
            </div>
            <div
                v-for="field in SUBSCRIPTION_FIELDS"
                :key="field.provider"
                class="flex flex-col gap-1.5 border-t border-line pt-2 first:border-t-0 first:pt-0"
            >
                <div class="flex items-center justify-between gap-2">
                    <span class="flex items-center gap-2 text-sm text-content">
                        <Icon name="circle-fill" class="text-[0.5rem]" :class="translatorAccounts[field.provider] ? 'text-success' : 'text-subtle'" />
                        {{ field.label }}
                        <span class="text-2xs text-subtle">{{ translatorAccounts[field.provider] ? "connected" : "not connected" }}</span>
                    </span>
                    <Button
                        v-if="translatorAccounts[field.provider]"
                        label="Disconnect"
                        size="small"
                        severity="danger"
                        :text="true"
                        :loading="connectBusy === field.provider"
                        @click="disconnectSubscription(field.provider)"
                    />
                    <Button
                        v-else-if="!(connectFlow && connectFlow.provider === field.provider)"
                        label="Connect"
                        size="small"
                        :loading="connectBusy === field.provider"
                        @click="connectSubscription(field.provider)"
                    >
                        <template #icon><Icon name="link" /></template>
                    </Button>
                </div>
                <!-- Live device-login card: show the verification URL + one-time code; the translator connects on
                     its own, and the poll flips the row to "connected". -->
                <div v-if="connectFlow && connectFlow.provider === field.provider" class="flex flex-col gap-2 rounded-md border border-line bg-card p-2">
                    <p class="text-2xs text-subtle">{{ field.hint }}</p>
                    <div class="flex flex-col items-center gap-1">
                        <span class="text-2xs text-subtle">Your one-time code</span>
                        <span class="font-mono text-lg font-semibold tracking-[0.2em] text-content">{{ connectFlow.code }}</span>
                        <CopyButton :text="connectFlow.code" label="Copy" />
                    </div>
                    <div class="flex items-center gap-2">
                        <Button as="a" label="Open sign-in" size="small" severity="secondary" :href="connectFlow.url" target="_blank" rel="noopener">
                            <template #icon><Icon name="external-link" /></template>
                        </Button>
                        <span class="text-2xs text-subtle"><Icon name="spinner" class="mr-1" spin />Waiting for you to finish signing in…</span>
                    </div>
                </div>
            </div>
        </Card>

        <!-- Past-chat search — lets the agent look through the active sandbox's earlier conversations. Stored
             per-sandbox in the daemon, so it's disabled until the active sandbox is reachable. -->
        <Card class="flex items-center justify-between">
            <div class="flex min-w-0 items-center gap-2.5">
                <Icon name="history" class="text-lg text-muted" />
                <div class="min-w-0">
                    <h2 class="font-semibold leading-tight">Search past chats</h2>
                    <p class="text-xs text-muted">Let the assistant search this sandbox's earlier conversations for relevant details.</p>
                </div>
            </div>
            <ToggleSwitch
                :model-value="sandboxSettings?.searchPastChats ?? false"
                :disabled="sandboxSettings === undefined"
                @update:model-value="toggleSearchPastChats"
            />
        </Card>

        <!-- Output cleaning — compresses noisy shell output (installs/builds/tests) before the model sees it,
             invisible to the agent. Off = raw output. The master toggle flips the whole filter; the per-cleaner
             checklist + holdout below let each cleaner be turned on/off and A/B benchmarked individually. -->
        <Card class="flex flex-col gap-3">
            <div class="flex items-center justify-between">
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="bolt" class="text-lg text-muted" />
                    <div class="min-w-0">
                        <h2 class="font-semibold leading-tight">Clean command output</h2>
                        <p class="text-xs text-muted">
                            Trim noisy shell output before it reaches the assistant — fewer tokens, same signal (errors always kept).
                        </p>
                    </div>
                </div>
                <ToggleSwitch :model-value="cleaningOn" :disabled="sandboxSettings === undefined" @update:model-value="toggleOutputCleaning" />
            </div>

            <!-- Per-cleaner switches (the spec, as a checklist) — only meaningful while cleaning is on. -->
            <div v-if="cleaningOn && sandboxSettings !== undefined" class="flex flex-col gap-2 border-t border-line pt-3">
                <p class="text-2xs font-medium uppercase tracking-wide text-subtle">Cleaners</p>
                <div class="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    <label v-for="cleaner in CLEANER_OPTIONS" :key="cleaner.id" class="flex items-center justify-between gap-2">
                        <span class="truncate text-xs text-content">{{ cleaner.label }}</span>
                        <ToggleSwitch
                            :model-value="enabledCleaners.has(cleaner.id)"
                            @update:model-value="(value: boolean) => toggleCleaner(cleaner.id, value)"
                        />
                    </label>
                </div>

                <!-- Holdout: measurement control — a % of commands left raw so the savings report has a real
                     cleaned-vs-raw baseline instead of an estimate. -->
                <label class="mt-1 flex items-center justify-between gap-3 border-t border-line pt-3">
                    <span class="flex min-w-0 flex-col">
                        <span class="text-xs text-content">Holdout control</span>
                        <span class="text-2xs text-muted">Leave this % of commands uncleaned to measure real savings.</span>
                    </span>
                    <span class="flex shrink-0 items-center gap-1">
                        <input
                            type="number"
                            min="0"
                            max="100"
                            :value="holdoutPercent"
                            :class="cmp.input('w-16 text-right text-xs')"
                            @change="(event: Event) => setHoldoutPercent(Number((event.target as HTMLInputElement).value))"
                        />
                        <span class="text-xs text-muted">%</span>
                    </span>
                </label>
            </div>
        </Card>

        <!-- Cleaner backend — native filter vs the rtk extension binary, an A/B switch (rtk needs the rtk
             extension installed + a sandbox rebuild first). -->
        <Card class="flex items-center justify-between">
            <div class="flex min-w-0 items-center gap-2.5">
                <Icon name="arrows-h" class="text-lg text-muted" />
                <div class="min-w-0">
                    <h2 class="font-semibold leading-tight">Cleaner backend</h2>
                    <p class="text-xs text-muted">Which tool compresses shell output. rtk requires the rtk extension installed + rebuilt.</p>
                </div>
            </div>
            <div class="flex shrink-0 items-center gap-1">
                <button
                    v-for="backend in [
                        { value: 'native' as const, label: 'Native' },
                        { value: 'rtk' as const, label: 'rtk' },
                    ]"
                    :key="backend.value"
                    type="button"
                    class="composer-ghost h-6 px-2 text-2xs font-medium"
                    :class="{ 'composer-active': (sandboxSettings?.filterBackend ?? 'native') === backend.value }"
                    :disabled="sandboxSettings === undefined"
                    :aria-pressed="(sandboxSettings?.filterBackend ?? 'native') === backend.value"
                    @click="setFilterBackend(backend.value)"
                >
                    {{ backend.label }}
                </button>
            </div>
        </Card>

        <!-- Savings report (rtk-`gain`) — realized token savings from the live filter-stats ledger, so the owner
             can see what each cleaner is worth and where to add the next handler. -->
        <Card v-if="savings !== undefined && savings.commands > 0" class="flex flex-col gap-2.5">
            <div class="flex items-center gap-2.5">
                <Icon name="wave-pulse" class="text-lg text-muted" />
                <div class="min-w-0">
                    <h2 class="font-semibold leading-tight">Output savings</h2>
                    <p class="text-xs text-muted">
                        {{ savings.commands }} commands · ~{{ shortTokens(savings.rawTokens) }} → ~{{ shortTokens(savings.emittedTokens) }} tokens ·
                        <span class="font-medium text-success">{{ savings.savedPct }}% saved</span>
                        <span v-if="savings.holdout.measuredSavedPct !== undefined">
                            · {{ savings.holdout.measuredSavedPct }}% measured (holdout)</span
                        >
                    </p>
                </div>
            </div>
            <div v-if="savings.perCleaner.length > 0" class="flex flex-wrap gap-1.5">
                <span
                    v-for="entry in savings.perCleaner"
                    :key="entry.id"
                    class="rounded-md border border-line bg-card px-1.5 py-0.5 text-2xs text-subtle"
                >
                    {{ entry.id }} ×{{ entry.commands }}
                </span>
            </div>
            <div v-if="savings.gaps.length > 0" class="flex flex-col gap-1 border-t border-line pt-2">
                <p class="text-2xs font-medium uppercase tracking-wide text-subtle">Un-cleaned (add a handler)</p>
                <p v-for="gap in savings.gaps.slice(0, 5)" :key="gap.command" class="truncate font-mono text-2xs text-muted">
                    ~{{ shortTokens(gap.tokens) }} · {{ gap.command }}
                </p>
            </div>
        </Card>

        <!-- Terse responses — steers the assistant to answer concisely (no restating context/tool output),
             cutting its own output tokens. A stable system-prompt suffix, so it doesn't hurt prompt-cache hits. -->
        <Card class="flex items-center justify-between">
            <div class="flex min-w-0 items-center gap-2.5">
                <Icon name="align-left" class="text-lg text-muted" />
                <div class="min-w-0">
                    <h2 class="font-semibold leading-tight">Terse responses</h2>
                    <p class="text-xs text-muted">Ask the assistant to answer concisely without restating context — fewer output tokens per reply.</p>
                </div>
            </div>
            <ToggleSwitch
                :model-value="sandboxSettings?.terseOutput ?? false"
                :disabled="sandboxSettings === undefined"
                @update:model-value="toggleTerseOutput"
            />
        </Card>

        <!-- iq code search — loads the iq plugin (skill + nudge) so the assistant reaches for the iq CLI instead
             of grep/find/glob. Opt-in per sandbox; the browser Search box uses iq regardless. -->
        <Card class="flex items-center justify-between">
            <div class="flex min-w-0 items-center gap-2.5">
                <Icon name="search" class="text-lg text-muted" />
                <div class="min-w-0">
                    <h2 class="font-semibold leading-tight">iq code search</h2>
                    <p class="text-xs text-muted">Let the assistant use the iq search CLI instead of grep / find / glob.</p>
                </div>
            </div>
            <ToggleSwitch
                :model-value="sandboxSettings?.iqSearch ?? false"
                :disabled="sandboxSettings === undefined"
                @update:model-value="toggleIqSearch"
            />
        </Card>

        <!-- Import memory: bring context from another AI assistant into this sandbox's agent memory files. -->
        <Card class="flex flex-col gap-3">
            <div class="flex items-center gap-2.5">
                <Icon name="sparkles" class="text-lg text-muted" />
                <div>
                    <h2 class="font-semibold leading-tight">Import memory</h2>
                    <p class="text-xs text-muted">
                        Bring context from another AI assistant into
                        <span class="font-medium text-content">{{ sandbox.active.value?.name ?? `your sandbox` }}</span> so Claude and ChatGPT
                        remember it.
                    </p>
                </div>
            </div>

            <div v-if="importError" :class="cmp.alertDanger()">{{ importError }}</div>

            <label class="flex flex-col gap-1.5">
                <span class="flex items-center gap-2 text-sm font-medium text-content">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold">1</span>
                    Copy this prompt into a chat with your other AI provider
                </span>
                <textarea :value="IMPORT_PROMPT" readonly rows="6" :class="cmp.input('w-full font-mono resize-y text-subtle')"></textarea>
                <div class="flex justify-end">
                    <CopyButton :text="IMPORT_PROMPT" label="Copy prompt" />
                </div>
            </label>

            <label class="flex flex-col gap-1.5">
                <span class="flex items-center gap-2 text-sm font-medium text-content">
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-content/10 text-2xs font-semibold">2</span>
                    Paste the result below to add it to memory
                </span>
                <textarea
                    v-model="importText"
                    rows="8"
                    placeholder="Paste your memory details here"
                    :class="cmp.input('w-full font-mono resize-y')"
                ></textarea>
                <div class="flex justify-end">
                    <Button label="Add to memory" :loading="importSaving" :disabled="importText.trim().length === 0" @click="importMemory">
                        <template #icon><Icon name="sparkles" /></template>
                    </Button>
                </div>
            </label>
        </Card>
    </div>
</template>
