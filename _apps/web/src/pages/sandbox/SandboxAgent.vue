<script setup lang="ts">
import { Card, cmp, CopyButton } from "@intentic-app/ui";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { providerTabs } from "../../composables/chat/conversation";
import { useChat } from "../../composables/chat/useChat";
import { IMPORT_PROMPT, MEMORY_FILES, mergeMemory } from "../../composables/extensions/memoryImport";
import { useSandboxSettings } from "../../composables/sandbox/useSandboxSettings";
import { useSandbox } from "../../composables/useSandbox";
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

onMounted(() => openAccountManage());
onUnmounted(() => closeAccountManage());

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
             invisible to the agent. Off = raw output. Finer per-cleaner selection is a spec set via settings. -->
        <Card class="flex items-center justify-between">
            <div class="flex min-w-0 items-center gap-2.5">
                <Icon name="bolt" class="text-lg text-muted" />
                <div class="min-w-0">
                    <h2 class="font-semibold leading-tight">Clean command output</h2>
                    <p class="text-xs text-muted">
                        Trim noisy shell output before it reaches the assistant — fewer tokens, same signal (errors always kept).
                    </p>
                </div>
            </div>
            <ToggleSwitch
                :model-value="(sandboxSettings?.outputCleaners ?? '') !== 'off'"
                :disabled="sandboxSettings === undefined"
                @update:model-value="toggleOutputCleaning"
            />
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
