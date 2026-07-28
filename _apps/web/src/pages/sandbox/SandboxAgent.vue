<script setup lang="ts">
import { type AgentProvider, quickModelKey } from "@intentic/sandbox-contract";
import { Card, cmp, CopyButton, formatTokens, Picker, type PickerOptions, Row, RowGroup, Segmented } from "@intentic-app/ui";
import Button from "primevue/button";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { quickModelGroups, useQuickModel } from "../../composables/chat/quickModel";
import { IMPORT_PROMPT, MEMORY_FILES, mergeMemory } from "../../composables/extensions/memoryImport";
import { errorMessage } from "../../composables/useAsyncAction";
import { useCleanerSavings } from "../../composables/sandbox/useCleanerSavings";
import { useSandboxSettings } from "../../composables/sandbox/useSandboxSettings";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import ProviderLogo from "../../chat/ProviderLogo.vue";
import AiAccountSection from "./AiAccountSection.vue";
import AssistantInfo from "./AssistantInfo.vue";
import CommandOutputInfo from "./CommandOutputInfo.vue";

/* The Sandbox hub's "Agent" tab — the home for everything about the AI the sandbox runs. The AI provider
 * accounts (Claude / ChatGPT / Grok / Kimi / Gemini) it authenticates as — each provider's native-harness
 * account plus, for codex/grok/gemini, the subscription the translator serves them on, all of which live in
 * AiAccountSection — its behavior settings, and the import-memory tool. Accounts and memory live INSIDE the
 * sandbox, never on the platform, which is why this is a sandbox tab. */

const sandbox = useSandbox();

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

/* --- Custom instructions -------------------------------------------------------------------------------------
 * The owner's standing instructions, appended to the end of the agent's system prompt (the Agent SDK's
 * `systemPrompt.append` — the seam `--append-system-prompt` writes to). Terse responses above is the same
 * mechanism with the text written for you; this is that text, opened up.
 *
 * A LOCAL draft rather than a computed over settings, because saving is a whole-object POST that every other
 * control on this page renders from, and the value is a system-prompt prefix every live conversation is caching:
 * a per-keystroke save would thrash both. It commits on blur (the textarea's own `change`) or from the Save
 * button, which is there because a save nobody can see is a save nobody trusts. */
const INSTRUCTIONS_MAX = 8000; // SandboxSettingsSchema.systemAppend's cap — the daemon rejects more.
const instructions = ref(``);
const instructionsDirty = computed(() => sandboxSettings.value !== undefined && instructions.value !== sandboxSettings.value.systemAppend);
// Seed from the daemon on load, and follow a change made in ANOTHER window — but never over an unsaved edit in
// this one, which is what the dirty check guards: the settings query refetches on every mutation from anywhere.
watch(
    () => sandboxSettings.value?.systemAppend,
    (saved) => {
        if (saved !== undefined && !instructionsDirty.value) {
            instructions.value = saved;
        }
    },
    { immediate: true },
);
const saveInstructions = (): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    // Normalise BEFORE the dirty check, not inside the payload: saving a trimmed copy of an untrimmed draft
    // leaves the two permanently unequal, and the row would sit there claiming unsaved changes forever.
    instructions.value = instructions.value.trim();
    if (!instructionsDirty.value) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, systemAppend: instructions.value });
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
        <!-- The AI accounts the agent signs in as: the provider switcher, one row per connection, and the
             live sign-in each row can unfold. Its own component — it is the only stateful, network-driven part
             of this page, and everything below is a settings toggle. -->
        <AiAccountSection />

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
                    {{ savings.commands }} commands · ~{{ formatTokens(savings.rawTokens) }} → ~{{ formatTokens(savings.emittedTokens) }} tokens ·
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
                            ~{{ formatTokens(gap.tokens) }} · {{ gap.command }}
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

            <!-- Custom instructions — the owner's own text on the end of the system prompt. Sits directly under
                 Terse responses because it IS Terse responses generalised, and its help text has one job the
                 toggles above don't: saying which of the two instruction surfaces this sandbox already has is
                 the right one, so this doesn't become a third place people scatter standing orders. -->
            <Row
                icon="pencil"
                title="Custom instructions"
                description="Your standing instructions, added to the end of the assistant's system prompt on every turn in this sandbox."
            >
                <template #below>
                    <textarea
                        v-model="instructions"
                        rows="4"
                        :maxlength="INSTRUCTIONS_MAX"
                        :disabled="sandboxSettings === undefined"
                        placeholder="e.g. Answer in Polish. Never run migrations without asking. Prefer pnpm over npm."
                        :class="cmp.input('w-full resize-y text-xs')"
                        aria-label="Custom instructions"
                        @change="saveInstructions"
                    ></textarea>
                    <div class="mt-1.5 flex items-center justify-between gap-3">
                        <p class="text-2xs text-subtle">
                            Working on the code itself? That belongs in
                            <RouterLink to="/workspace/CLAUDE.md" class="font-medium text-primary-500 hover:underline">CLAUDE.md</RouterLink>, which
                            is committed with the repo and read by every assistant. This is for how the agent works with
                            <span class="font-medium text-content">you</span> — it stays in this sandbox.
                        </p>
                        <span class="flex shrink-0 items-center gap-2">
                            <span v-if="instructions.length > INSTRUCTIONS_MAX - 500" class="text-2xs text-muted">
                                {{ instructions.length }} / {{ INSTRUCTIONS_MAX }}
                            </span>
                            <!-- Blur already saves; the button is for the user who can't tell that it did.
                                 `mousedown.prevent` keeps focus in the textarea, so pressing it doesn't blur-save
                                 the field and unmount the button out from under the click that was landing on it. -->
                            <Button
                                v-if="instructionsDirty"
                                label="Save"
                                size="small"
                                :loading="saveSandboxSettings.isPending.value"
                                @mousedown.prevent
                                @click="saveInstructions"
                            />
                        </span>
                    </div>
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
