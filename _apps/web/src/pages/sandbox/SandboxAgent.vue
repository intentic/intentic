<script setup lang="ts">
import { type AgentProvider, type KeyedProvider, quickModelKey } from "@intentic/sandbox-contract";
import { Card, cmp, CopyButton, InfoHint, Picker, type PickerOptions, Row, RowGroup, Segmented } from "@intentic-app/ui";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { providerReady } from "../../composables/chat/access";
import { providerTabs } from "../../composables/chat/conversation";
import { quickModelGroups, useQuickModel } from "../../composables/chat/quickModel";
import { useChat } from "../../composables/chat/useChat";
import { IMPORT_PROMPT, MEMORY_FILES, mergeMemory } from "../../composables/extensions/memoryImport";
import { errorMessage } from "../../composables/useAsyncAction";
import { useCleanerSavings } from "../../composables/sandbox/useCleanerSavings";
import { useSandboxSettings } from "../../composables/sandbox/useSandboxSettings";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import ProviderLogo from "../../chat/ProviderLogo.vue";
import AssistantInfo from "./AssistantInfo.vue";
import CommandOutputInfo from "./CommandOutputInfo.vue";
import NativeConnectFlow from "./NativeConnectFlow.vue";

/* The Sandbox hub's "Agent" tab — the home for everything about the AI the sandbox runs. The AI provider
 * accounts (Claude / ChatGPT / Grok / Kimi / Gemini) it authenticates as — each provider's native-harness
 * account plus, for codex/grok/gemini, the subscription the translator serves them on — its behavior settings, and
 * the import-memory tool. Accounts and memory live INSIDE the sandbox, never on the platform, which is why this
 * is a sandbox tab. Both connection surfaces reuse useChat's shared state/handshakes unchanged; opening the tab
 * loads usage and preps the provider (openAccountManage); closing it just hides the card (closeAccountManage) —
 * an in-flight connect keeps running so a device sign-in the user is completing at x.ai / ChatGPT still lands. */

const sandbox = useSandbox();

// --- AI provider accounts (native + routed, one grouped list) ------------------------------------------------
const {
    managedProvider,
    setManagedProvider,
    managedAccounts,
    authorizeUrl,
    accountUsage,
    error: chatError,
    openAccountManage,
    closeAccountManage,
    startConnect,
    disconnect,
    translatorAccounts,
    translatorConnectFlow,
    translatorBusy,
    connectTranslator,
    completeTranslator,
    cancelTranslatorConnect,
    disconnectTranslator,
} = useChat();

// Arriving from a chat's "Connect account" gate carries `?connect=<provider>`: open that provider's card and
// flash it, so the user lands looking straight at the inputs they need (mirrors SandboxSync's desktop-sync jump).
// Driven by a watch, not just onMounted: the chat panel lives in the persistent shell, so the gate can deep-link
// here while this tab is already open — a query-only navigation doesn't remount the component.
const route = useRoute();
const ringing = ref(false);
let ringTimer: ReturnType<typeof setTimeout> | undefined;

const focusConnect = (): void => {
    const requested = providerTabs.find((tab) => tab.value === route.query[`connect`]);
    if (requested === undefined) {
        return;
    }
    setManagedProvider(requested.value);
    // Re-arm the flash cleanly on a repeat jump so a prior timer can't cut the ring short.
    ringing.value = true;
    clearTimeout(ringTimer);
    ringTimer = setTimeout(() => (ringing.value = false), 2500);
    // Let the card render, then bring it into view.
    setTimeout(() => document.getElementById(`ai-account`)?.scrollIntoView({ behavior: `smooth`, block: `center` }), 50);
};

onMounted(() => {
    openAccountManage();
    focusConnect();
});
watch(() => route.query[`connect`], focusConnect);
onUnmounted(closeAccountManage);

// The subscription connection, served by the sandbox's translator (CLIProxyAPI). For ChatGPT (codex) it is the
// ONE connection — Codex authenticates through it everywhere (native and under the Claude Code harness), so
// there's no separate account. For Grok it's a secondary row beneath the native account (the account runs
// Grok's own harness; the subscription runs Grok models UNDER the Claude Code harness). Claude has no row: it
// IS the Claude Code harness.
const routedProvider = computed<KeyedProvider | undefined>(() =>
    managedProvider.value === `codex` || managedProvider.value === `grok` || managedProvider.value === `gemini` ? managedProvider.value : undefined,
);
// Each routed row carries two registers of explanation, because they are read at different moments. `hint` is
// the glanceable one — what this connection costs you, in a fragment — and it is the only one on screen. `about`
// is the full mechanic, parked behind the row's (i) for the reader who actually wants it: printing both is what
// turned this card into a wall of prose. `open` names the destination on its own button so "Open sign-in" never
// has to be guessed at, and `loginHint` appears only while that sign-in is live.
const ROUTED_ROW: Record<KeyedProvider, { title: string; hint: string; about: string; open: string; loginHint: string }> = {
    codex: {
        title: `ChatGPT subscription`,
        hint: `The only connection Codex needs.`,
        about: `Runs Codex on your ChatGPT subscription — everywhere: on its own and under the Claude Code harness.`,
        open: `Open ChatGPT`,
        loginHint: `Sign in, then enter this code.`,
    },
    grok: {
        title: `Under Claude Code`,
        hint: `Your SuperGrok / X Premium subscription.`,
        about: `Runs Grok models under the Claude Code harness on your SuperGrok / X Premium subscription — a separate sign-in from the Grok account above.`,
        open: `Open x.ai`,
        loginHint: `Sign in, then enter this code.`,
    },
    gemini: {
        title: `Google account`,
        // The models are worth naming even in the short line, because they are not the ones a "Google" tab
        // implies: Google's Antigravity channel vends Claude and GPT-OSS on the same ordinary sign-in (see
        // gemini-models.ts). Free is the other half — it is the only free row on this page.
        hint: `Free — Gemini, Claude and GPT-OSS models.`,
        about: `Runs Gemini, Claude and GPT-OSS models under the Claude Code harness on your Google account — free, and the one connection this provider needs.`,
        open: `Open Google`,
        // The dead-end landing page is the one thing a user cannot work out on their own, so it stays in full.
        loginHint: `The page Google lands on won't load — that's expected, it points back inside the sandbox. Copy its whole address and paste it below.`,
    },
};

// The dot per tab, so the switcher itself answers "which AI can my agent use?" — the card can only ever show one
// provider, and without it that question costs five clicks. `providerReady` (access.ts) is the shared rule every
// surface that offers a provider reads; this card must not carry a second opinion about what "connected" means,
// least of all one that would call a provider ready here and locked in the picker.
// The pasted redirect URL for a routed login that can't self-complete (Google's — see completeTranslator).
const redirectUrl = ref(``);
const finishTranslator = async (): Promise<void> => {
    if (redirectUrl.value.trim().length === 0) {
        return;
    }
    await completeTranslator(redirectUrl.value);
    redirectUrl.value = ``;
};

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

const managedLabel = computed(() => providerTabs.find((tab) => tab.value === managedProvider.value)?.label ?? managedProvider.value);
// Codex and Gemini own no native account — the subscription row IS their connection, so the accounts list is
// theirs to skip entirely.
const hasNativeAccounts = computed(() => managedProvider.value !== `codex` && managedProvider.value !== `gemini`);
// Grok holds a single account (OpenCode owns the xAI credential), so hide "connect another" once it's linked.
const canConnectMore = computed(() => managedProvider.value !== `grok` || managedAccounts.value.length === 0);
// A connect handshake is live once startConnect has produced its authorize URL / device code; the flow itself
// (and everything provider-specific about it) lives in NativeConnectFlow.
const connecting = computed(() => authorizeUrl.value !== null);

// --- Agent behavior toggles (per-sandbox, daemon .intentic/settings.json) ----------------------------------
// The daemon overwrites the whole settings object, so each toggle spreads the current settings and flips just
// its flag. Toggles are disabled until settings load, so a defined value is guaranteed by the time one fires —
// which is exactly why a failed read has to SAY so (settingsError below): the same disabled state otherwise
// reads as a page of switches that simply don't respond to clicks.
const { settings: sandboxSettings, error: settingsError, save: saveSandboxSettings } = useSandboxSettings();
// Only states that need explaining: a failed read, or a sandbox that isn't answering. The first-load moment is
// deliberately silent — the controls are disabled for it either way, and a line that appears and then vanishes
// would shove every row down and back on each visit.
const settingsBlocked = computed(() => {
    if (sandboxSettings.value !== undefined) {
        return undefined;
    }
    if (settingsError.value !== undefined) {
        return settingsError.value;
    }
    return sandbox.reachable.value ? undefined : `Your sandbox is offline — its settings can't be read or changed from here.`;
});

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

// Usage-limit auto-resume: re-run a limit-killed turn once the limit window reopens (see limit-resume.ts).
const toggleAutoResume = (value: boolean): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, autoResumeOnLimit: value });
};

/* --- Quick model ---------------------------------------------------------------------------------------------
 * The cheap, fast model behind the one-click helpers that are not a conversation (today: the commit box's AI
 * autofill). It belongs on THIS tab and not in personal Settings for one decisive reason — the provider
 * accounts it names live inside the sandbox, listed directly above on this very page, so a model pinned here
 * can never name a provider this sandbox has no credential for. A cross-sandbox preference could not promise
 * that.
 *
 * AUTO IS THE DEFAULT AND IT IS DERIVED, NOT STORED: the empty string means "work it out from whatever is
 * connected right now" (resolveQuickModel — cheapest tier first, free channel before a paid one). So connecting
 * an account tomorrow improves the answer by itself, and the row's label shows what it currently resolves to
 * rather than making the user guess. */
const quickModel = useQuickModel();
// The model Auto currently resolves to, by its SHORT label — the trigger is 14rem wide, and "Auto — Claude
// Code · Claude Haiku 4.5" truncated to "Auto — Claude Code · Cla…" hid exactly the part worth showing. The
// provider rides on the row's logo and the full resolution sits in the Auto row's description instead.
const autoModelLabel = computed<string | undefined>(() => {
    const choice = quickModel.choice.value;
    if (choice === undefined) {
        return undefined;
    }
    const key = quickModelKey(choice);
    return quickModelGroups.value.flatMap((group) => group.options).find((option) => option.key === key)?.label ?? choice.model;
});
// Auto leads as its own ungrouped row; the connected providers follow as labelled groups, so a model row can
// drop the "Claude Code · " prefix that used to eat the width of every line.
const quickModelPickerOptions = computed<PickerOptions>(() => [
    {
        options: [
            {
                value: ``,
                label: autoModelLabel.value === undefined ? `Auto` : `Auto · ${autoModelLabel.value}`,
                description: `Cheapest connected model`,
            },
        ],
    },
    ...quickModelGroups.value.map((group) => ({
        label: group.label,
        options: group.options.map((option) => ({ value: option.key, label: option.label })),
    })),
]);
// A pinned key is `${provider}:${model}` (quickModelKey) — the provider prefix drives the row's brand mark.
const providerOfKey = (key: string): AgentProvider => key.slice(0, key.indexOf(`:`)) as AgentProvider;
const setQuickModel = (value: string): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, quickModel: value });
};

// How long a finished agent stays on the fleet board before the daemon archives it (and reclaims its worktree
// checkout). Days, because the sweep runs hourly and the whole point is "after you've stopped thinking about
// it"; 0 turns the sweep off entirely.
// Segmented speaks strings, the setting is a number of days — so the option values are the decimal spellings
// and this is where they come back.
const setAgentRetentionDays = (days: string): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, agentRetentionDays: Number(days) });
};
const retentionOptions = [
    { label: `1 day`, value: `1` },
    { label: `3 days`, value: `3` },
    { label: `1 week`, value: `7` },
    { label: `Never`, value: `0` },
];

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

// Cleaner backend: native (agent-output-filter) vs rtk (the image-baked rtk binary, rewritten at the hook).
const setFilterBackend = (backend: `native` | `rtk`): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, filterBackend: backend });
};
const backendOptions = [
    { label: `Native`, value: `native` as const },
    { label: `rtk`, value: `rtk` as const },
];

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
        importError.value = errorMessage(caught, `Couldn't save memory.`);
    } finally {
        importSaving.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- AI provider accounts the agent runs as. A RowGroup like every other section on this page, NOT a
             Card: the connections are a grouped list, and wrapping that list in a card put a bordered surface
             inside a bordered surface for no gain — the group label carries the heading, so the sub-card,
             the icon and the standalone <h2> all come off. -->
        <!-- The deep-link flash rings the whole group (label included). `-m-1 p-1` holds the layout still while
             it does: the ring needs room to sit outside the surface, and growing the section for 2.5s would
             shove the page. -->
        <RowGroup id="ai-account" label="AI account" :class="ringing ? '-m-1 rounded-xl p-1 ring-2 ring-info' : ''">
            <template #info>
                <InfoHint label="About AI accounts">
                    <span class="block text-xs text-content">
                        The accounts your agent signs in as. Every credential is stored inside your sandbox, never on the platform — connecting here
                        signs the sandbox in, not this browser.
                    </span>
                </InfoHint>
            </template>
            <!-- The provider switcher rides the group label (where "Command output" carries its own trailing
                 controls), and the dot per chip is the point: this group shows ONE provider at a time, so
                 without it the question it exists to answer — which AI can my agent use? — costs a click each. -->
            <template #actions>
                <div class="flex flex-wrap items-center justify-end gap-1">
                    <button
                        v-for="tab in providerTabs"
                        :key="tab.value"
                        type="button"
                        class="composer-ghost h-6 gap-1.5 px-2 text-2xs font-medium"
                        :class="{ 'composer-active': managedProvider === tab.value }"
                        @click="setManagedProvider(tab.value)"
                        :aria-pressed="managedProvider === tab.value"
                    >
                        <span
                            class="h-1.5 w-1.5 shrink-0 rounded-full"
                            :class="providerReady(tab.value) ? 'bg-success' : 'bg-content/25'"
                            :aria-label="providerReady(tab.value) ? `connected` : `not connected`"
                        />
                        {{ tab.label }}
                    </button>
                </div>
            </template>

            <!-- Every connection this provider has — native accounts and the translator subscription alike — as
                 rows of ONE list. They are different mechanisms but the same question ("what am I signed in
                 with, and can I drop it?"), so they share a row shape: status dot, name, live state, action.
                 A sign-in in progress opens in the row's own #below, so it stays inside that row's hairline
                 instead of spawning an inset panel detached from the thing it connects. -->
            <p v-if="chatError" :class="cmp.alertDanger('m-3')">{{ chatError }}</p>

            <!-- Native accounts (Claude, Grok, Kimi), each disconnectable on its own. Codex and Gemini have
                 none — the subscription row below IS their connection — so they skip straight to it. -->
            <template v-if="hasNativeAccounts">
                <Row v-for="account in managedAccounts" :key="account.id" :class="account.needsReauth ? 'bg-warning/10' : ''">
                    <template #title>
                        <span class="flex min-w-0 items-center gap-2.5">
                            <span class="flex w-[1.125rem] shrink-0 justify-center">
                                <span class="h-1.5 w-1.5 rounded-full" :class="account.needsReauth ? 'bg-warning' : 'bg-success'" />
                            </span>
                            <span class="truncate">{{ account.label }}</span>
                        </span>
                    </template>
                    <!-- A revoked/expired credential explains itself and offers reconnect; else the usage line. -->
                    <template #description>
                        <span v-if="account.needsReauth" class="block pl-7 text-warning">{{
                            account.detail ?? `Signed out — reconnect to keep using it.`
                        }}</span>
                        <span v-else-if="usageLine(account.id)" class="block pl-7">{{ usageLine(account.id) }}</span>
                    </template>
                    <template #control>
                        <Button v-if="account.needsReauth && canConnectMore" label="Reconnect" size="small" @click="startConnect" />
                        <Button label="Disconnect" size="small" severity="danger" :text="true" @click="disconnect(account.id)" />
                    </template>
                </Row>

                <!-- No account yet is a ROW, not a sentence floating above a button: same shape as a connected
                     one, so the empty state reads as the connection that is missing rather than as an apology,
                     and its action sits where every other row's action sits. -->
                <Row v-if="managedAccounts.length === 0">
                    <template #title>
                        <span class="flex min-w-0 flex-wrap items-center gap-x-2.5">
                            <span class="flex w-[1.125rem] shrink-0 justify-center">
                                <span class="h-1.5 w-1.5 rounded-full bg-content/25" />
                            </span>
                            <span>{{ managedLabel }} account</span>
                            <span class="text-2xs font-normal text-subtle">not connected</span>
                        </span>
                    </template>
                    <template #control>
                        <!-- Filled: with no account at all, this is the one thing the group is asking for. -->
                        <Button v-if="!connecting" label="Connect" size="small" @click="startConnect">
                            <template #icon><Icon name="link" /></template>
                        </Button>
                    </template>
                    <template v-if="connecting" #below><NativeConnectFlow /></template>
                </Row>

                <!-- Adding a SECOND account is a different act from having none: its own quiet row at the end of
                     the list, which is also where the handshake it starts unfolds. -->
                <Row v-else-if="canConnectMore" :interactive="!connecting" @click="!connecting && startConnect()">
                    <template #title>
                        <span class="flex min-w-0 items-center gap-2.5 text-muted">
                            <span class="flex w-[1.125rem] shrink-0 justify-center"><Icon name="plus" class="text-2xs" /></span>
                            <span>Add another account</span>
                        </span>
                    </template>
                    <template v-if="connecting" #below><NativeConnectFlow /></template>
                </Row>
            </template>

            <!-- The subscription connection (translator). ChatGPT/Codex and Gemini: the ONE connection, so it's
                 the group's primary control. Grok: a second row beneath the native account, for running Grok
                 UNDER the Claude Code harness. Codex/Grok mint a one-time code and the translator connects on
                 its own; Google redirects instead, so that flow asks for the landing URL back. Either way the
                 shared poll flips the row to "connected". -->
            <Row v-if="routedProvider">
                <template #title>
                    <!-- Wraps rather than truncates: these titles are short and fixed, and a squeezed row that
                         renders "Unde…" has hidden the only thing the row is for. -->
                    <span class="flex min-w-0 flex-wrap items-center gap-x-2.5">
                        <span class="flex w-[1.125rem] shrink-0 justify-center">
                            <span class="h-1.5 w-1.5 rounded-full" :class="translatorAccounts[routedProvider] ? 'bg-success' : 'bg-content/25'" />
                        </span>
                        <span>{{ ROUTED_ROW[routedProvider].title }}</span>
                        <span v-if="!translatorAccounts[routedProvider]" class="text-2xs font-normal text-subtle">not connected</span>
                        <!-- The full mechanic lives here rather than on screen: it is a paragraph, and a
                             paragraph per row is what made this group unreadable. -->
                        <InfoHint :label="`About ${ROUTED_ROW[routedProvider].title}`">
                            <span class="block text-xs text-content">{{ ROUTED_ROW[routedProvider].about }}</span>
                        </InfoHint>
                    </span>
                </template>
                <template #description
                    ><span class="block pl-7">{{ ROUTED_ROW[routedProvider].hint }}</span></template
                >
                <template #control>
                    <Button
                        v-if="translatorAccounts[routedProvider]"
                        label="Disconnect"
                        size="small"
                        severity="danger"
                        :text="true"
                        :loading="translatorBusy === routedProvider"
                        @click="disconnectTranslator(routedProvider)"
                    />
                    <!-- Filled accent only where this row IS the group's one connection (Codex/Gemini). Under
                         Grok it's the alternative to the native account right above it, and a filled accent
                         there makes the lesser path the loudest thing on the page. -->
                    <Button
                        v-else-if="translatorConnectFlow?.provider !== routedProvider"
                        label="Connect"
                        size="small"
                        :severity="routedProvider === `grok` ? `secondary` : undefined"
                        :loading="translatorBusy === routedProvider"
                        @click="connectTranslator(routedProvider)"
                    >
                        <template #icon><Icon name="link" /></template>
                    </Button>
                </template>
                <template v-if="translatorConnectFlow && translatorConnectFlow.provider === routedProvider" #below>
                    <div class="flex flex-col gap-2.5">
                        <div class="flex flex-wrap items-center gap-2">
                            <Button
                                as="a"
                                :label="ROUTED_ROW[routedProvider].open"
                                size="small"
                                :href="translatorConnectFlow.url"
                                target="_blank"
                                rel="noopener"
                            >
                                <template #icon><Icon name="external-link" /></template>
                            </Button>
                            <span class="flex items-center gap-1.5 text-2xs text-subtle"><Icon name="spinner" spin />Waiting for sign-in…</span>
                            <Button
                                class="ml-auto shrink-0"
                                label="Cancel"
                                size="small"
                                severity="secondary"
                                :text="true"
                                @click="cancelTranslatorConnect"
                            />
                        </div>
                        <p class="text-2xs text-subtle">{{ ROUTED_ROW[routedProvider].loginHint }}</p>
                        <!-- A one-time code means the provider polls itself; no code means it redirects, and the
                             landing URL carries the grant the sandbox never received. -->
                        <div
                            v-if="translatorConnectFlow.code"
                            class="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-3 py-1.5"
                        >
                            <span class="truncate font-mono text-base font-semibold tracking-[0.2em] text-content">{{
                                translatorConnectFlow.code
                            }}</span>
                            <CopyButton :text="translatorConnectFlow.code" />
                        </div>
                        <div v-else class="flex gap-2">
                            <input
                                v-model="redirectUrl"
                                type="text"
                                :class="cmp.input(`min-w-0 flex-1 py-1.5`)"
                                placeholder="Paste the address you landed on…"
                                @keyup.enter="finishTranslator"
                            />
                            <Button
                                label="Finish"
                                size="small"
                                :disabled="redirectUrl.trim().length === 0"
                                :loading="translatorBusy === routedProvider"
                                @click="finishTranslator"
                            />
                        </div>
                    </div>
                </template>
            </Row>
        </RowGroup>

        <!-- Why every control below is inert, whenever it is: a settings read that hasn't landed (or failed)
             disables all of them, and an unexplained dead switch is indistinguishable from a broken page. -->
        <p v-if="settingsBlocked" :class="settingsError ? cmp.alertDanger() : 'px-0.5 text-xs text-muted'">{{ settingsBlocked }}</p>

        <!-- Command output — the shell-output filter (master toggle + per-cleaner checklist + holdout), its A/B
             backend, and the realized-savings report. One grouped section instead of a card per toggle. -->
        <RowGroup label="Command output">
            <template #info><CommandOutputInfo /></template>
            <Row
                icon="bolt"
                title="Clean command output"
                description="Trim noisy shell output before it reaches the assistant — fewer tokens, same signal (errors always kept)."
            >
                <template #control>
                    <ToggleSwitch :model-value="cleaningOn" :disabled="sandboxSettings === undefined" @update:model-value="toggleOutputCleaning" />
                </template>
                <!-- Per-cleaner switches (the spec, as a checklist) — only meaningful while cleaning is on. -->
                <template v-if="cleaningOn && sandboxSettings !== undefined" #below>
                    <div class="flex flex-col gap-2">
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
                </template>
            </Row>

            <Row
                icon="arrows-h"
                title="Cleaner backend"
                description="Which tool compresses shell output. Both ship with the sandbox — no install, no rebuild."
            >
                <template #control>
                    <Segmented
                        :model-value="sandboxSettings?.filterBackend ?? `native`"
                        :options="backendOptions"
                        @update:model-value="setFilterBackend"
                    />
                </template>
            </Row>

            <!-- Savings report (rtk-`gain`) — realized token savings from the live filter-stats ledger, so the owner
                 can see what each cleaner is worth and where to add the next handler. -->
            <Row v-if="savings !== undefined && savings.commands > 0" icon="wave-pulse" title="Output savings">
                <template #description>
                    {{ savings.commands }} commands · ~{{ shortTokens(savings.rawTokens) }} → ~{{ shortTokens(savings.emittedTokens) }} tokens ·
                    <span class="font-medium text-success">{{ savings.savedPct }}% saved</span>
                    <span v-if="savings.holdout.measuredSavedPct !== undefined"> · {{ savings.holdout.measuredSavedPct }}% measured (holdout)</span>
                </template>
                <template #below>
                    <div v-if="savings.perCleaner.length > 0" class="flex flex-wrap gap-1.5">
                        <span v-for="entry in savings.perCleaner" :key="entry.id" class="rounded-md bg-canvas px-1.5 py-0.5 text-2xs text-subtle">
                            {{ entry.id }} ×{{ entry.commands }}
                        </span>
                    </div>
                    <div v-if="savings.gaps.length > 0" class="mt-2 flex flex-col gap-1 border-t border-line pt-2">
                        <p class="text-2xs font-medium uppercase tracking-wide text-subtle">Un-cleaned (add a handler)</p>
                        <p v-for="gap in savings.gaps.slice(0, 5)" :key="gap.command" class="truncate font-mono text-2xs text-muted">
                            ~{{ shortTokens(gap.tokens) }} · {{ gap.command }}
                        </p>
                    </div>
                </template>
            </Row>
        </RowGroup>

        <!-- Assistant — behavior-steering toggles (concise output, search backend). -->
        <RowGroup label="Assistant">
            <template #info><AssistantInfo /></template>
            <!-- Terse responses — steers the assistant to answer concisely (no restating context/tool output),
                 cutting its own output tokens. A stable system-prompt suffix, so it doesn't hurt prompt-cache hits. -->
            <Row
                icon="align-left"
                title="Terse responses"
                description="Ask the assistant to answer concisely without restating context — fewer output tokens per reply."
            >
                <template #control>
                    <ToggleSwitch
                        :model-value="sandboxSettings?.terseOutput ?? false"
                        :disabled="sandboxSettings === undefined"
                        @update:model-value="toggleTerseOutput"
                    />
                </template>
            </Row>

            <!-- iq code search — loads the iq plugin (skill + nudge) so the assistant reaches for the iq CLI instead
                 of grep/find/glob. Opt-in per sandbox; the browser Search box uses iq regardless. -->
            <Row icon="search" title="iq code search" description="Let the assistant use the iq search CLI instead of grep / find / glob.">
                <template #control>
                    <ToggleSwitch
                        :model-value="sandboxSettings?.iqSearch ?? false"
                        :disabled="sandboxSettings === undefined"
                        @update:model-value="toggleIqSearch"
                    />
                </template>
            </Row>

            <!-- Auto-resume — re-run a turn the Claude subscription's usage limit killed, a minute after the
                 limit window resets. The chat also offers this at the moment a limit hit lands. -->
            <Row
                icon="clock"
                title="Auto-resume after usage limits"
                description="When a turn dies on the Claude usage limit, re-run it automatically about a minute after the limit resets."
            >
                <template #control>
                    <ToggleSwitch
                        :model-value="sandboxSettings?.autoResumeOnLimit ?? false"
                        :disabled="sandboxSettings === undefined"
                        @update:model-value="toggleAutoResume"
                    />
                </template>
            </Row>

            <!-- Quick model — the cheap rung the one-click helpers spend, kept off the frontier model the chat
                 runs on. Auto leads and states what it resolves to, because the useful thing to know here is
                 not that a default exists but WHICH model a click is about to bill. -->
            <Row
                icon="sparkles"
                title="Quick model"
                description="The cheap, fast model behind one-click helpers like the commit-message autofill — never the model your chat runs on."
            >
                <template #control>
                    <Picker
                        :model-value="quickModel.pinned.value"
                        :options="quickModelPickerOptions"
                        :disabled="sandboxSettings === undefined"
                        class="w-56 py-1.5 text-xs"
                        aria-label="Quick model"
                        @update:model-value="(value: string | undefined) => setQuickModel(value ?? ``)"
                    >
                        <!-- Auto keeps the sparkle the helpers themselves wear; a pinned model wears its
                             provider's mark, so the trigger names the account a click will spend at a glance. -->
                        <template #icon="{ option }">
                            <Icon v-if="option.value === ``" name="sparkles" class="shrink-0 text-xs text-muted" aria-hidden="true" />
                            <ProviderLogo v-else :provider="providerOfKey(option.value)" class="shrink-0 text-xs text-muted" />
                        </template>
                    </Picker>
                </template>
                <!-- Nothing connected: the helpers are inert and the dropdown has only Auto in it, which on its
                     own reads as a broken control rather than a missing account. -->
                <template v-if="quickModel.choice.value === undefined && sandboxSettings !== undefined" #below>
                    <p class="text-2xs text-muted">Connect an AI account above to enable the one-click helpers.</p>
                </template>
            </Row>

            <!-- Agent retention — how long a finished agent keeps its card AND its worktree checkout. The
                 Finished lane has no exit of its own, so without this the board (and the disk behind it) grows
                 for the life of the sandbox. Archiving is lossless, which is what makes an automatic sweep
                 acceptable at all: "Never" is offered, but it costs a checkout per agent forever. -->
            <Row
                icon="box"
                title="Archive finished agents"
                description="Take a finished agent off the board after it has been quiet this long, and reclaim its worktree. Its branch, diff and conversation are kept — restore it any time from the board's archive."
            >
                <template #control>
                    <Segmented
                        :model-value="String(sandboxSettings?.agentRetentionDays ?? 3)"
                        :options="retentionOptions"
                        @update:model-value="setAgentRetentionDays"
                    />
                </template>
            </Row>
        </RowGroup>

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
