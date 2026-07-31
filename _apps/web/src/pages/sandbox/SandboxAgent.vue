<script setup lang="ts">
import {
    type AgentProvider,
    type BuiltinPromptText,
    quickModelKey,
    type SandboxSettings,
    type SystemPromptMode,
    USAGE_LIMIT_AUTO_RESUME_ENABLED,
} from "@intentic/sandbox-contract";
import { Card, cmp, CopyButton, formatTokens, Picker, type PickerOptions, Row, RowGroup, Segmented } from "@intentic-app/ui";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import { relativeTime } from "../../composables/chat/catalog";
import { quickModelGroups, useQuickModel } from "../../composables/chat/quickModel";
import { IMPORT_PROMPT, MEMORY_FILES, mergeMemory } from "../../composables/extensions/memoryImport";
import { errorMessage, useAsyncAction } from "../../composables/useAsyncAction";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { useSavings } from "../../composables/sandbox/useSavings";
import { useSandboxSettings } from "../../composables/sandbox/useSandboxSettings";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import ProviderLogo from "../../chat/ProviderLogo.vue";
import { ALL_CLEANER_IDS, CLEANER_OPTIONS, savedByCleaner } from "./savingsChart";
import AiAccountSection from "./AiAccountSection.vue";
import AssistantInfo from "./AssistantInfo.vue";
import CommandOutputInfo from "./CommandOutputInfo.vue";

/* The Sandbox hub's "Agent" tab — the home for everything about the AI the sandbox runs. The AI provider
 * accounts (Claude / ChatGPT / Grok / Kimi / Gemini) it authenticates as — each provider's native-harness
 * account plus, for codex/grok/kimi/gemini, the subscription the translator serves them on, all of which live in
 * AiAccountSection — its behavior settings, and the import-memory tool. Accounts and memory live INSIDE the
 * sandbox, never on the platform, which is why this is a sandbox tab. */

const sandbox = useSandbox();

// --- Agent behavior toggles (per-sandbox, daemon .intentic/settings.json) ----------------------------------
// The daemon overwrites the whole settings object, so each toggle spreads the current settings and flips just
// its flag. Toggles are disabled until settings load, so a defined value is guaranteed by the time one fires —
// which is exactly why a failed read has to SAY so (settingsError below): the same disabled state otherwise
// reads as a page of switches that simply don't respond to clicks.
const { settings: sandboxSettings, error: settingsError, dropped: settingsDropped, save: saveSandboxSettings } = useSandboxSettings();
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

/* Both holdout controls are a percentage [0,100] in the box over a fraction [0,1] in settings, so they commit
 * the same way. Reading the ELEMENT rather than a plain number is the point: an emptied field is `Number("")`,
 * which is 0 — "measure nothing", saved silently, from a user who was mid-edit — so it falls back to what is
 * saved instead. The clamped value is written back into the input because the bound value may not have changed
 * (typing 200 over 100), and then Vue has nothing to patch and the box keeps showing the number that was
 * refused. */
const commitPercent = (event: Event, saved: number, apply: (fraction: number) => void): void => {
    const input = event.target as HTMLInputElement;
    const typed = Number(input.value);
    const percent = input.value === `` || !Number.isFinite(typed) ? saved : Math.min(100, Math.max(0, Math.round(typed)));
    input.value = String(percent);
    apply(percent / 100);
};

// The steer's measurement control, at turn level: the % of eligible turns that run WITHOUT it so the two arms
// can be compared.
const terseHoldoutPercent = computed<number>(() => Math.round((sandboxSettings.value?.terseHoldout ?? 0) * 100));
const setTerseHoldout = (fraction: number): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, terseHoldout: fraction });
};

/* --- System prompt -------------------------------------------------------------------------------------------
 * WHICH PROMPT THE AGENT IS. Three bases: Intentic's own (the default), Claude Code's, or one the owner writes.
 * The first two are peers — a base plus the harness wiring this app appends — and picking between them is a
 * one-click preference. The third replaces everything, which is why it is the only one that argues back.
 *
 * A prompt picker is a trap unless you can READ what each option is, so either built-in text is one click away
 * and either can be forked into a custom one. They are fetched ON DEMAND: Claude's costs a throwaway CLI turn
 * daemon-side (preset-prompt.ts) — cheap, but not something every visit to this tab should pay for.
 *
 * The draft is LOCAL rather than a computed over settings: saving is a whole-object POST that every other
 * control on this page renders from, and the text is a system prefix every live conversation is caching, so a
 * per-keystroke save would thrash both. It commits on blur (the textarea's own `change`) or from the Save
 * button, which is there because a save nobody can see is a save nobody trusts. */
const PROMPT_MAX = 20000; // SandboxSettingsSchema.systemPrompt's cap — the daemon rejects more.
const PROMPT_MODES: { label: string; value: SystemPromptMode }[] = [
    { label: `Intentic`, value: `intentic` },
    { label: `Claude`, value: `claude` },
    { label: `Custom`, value: `custom` },
];
const promptMode = computed<SystemPromptMode>(() => sandboxSettings.value?.systemPromptMode ?? `intentic`);
const prompt = ref(``);

/* The draft mirrors a SAVED value, and this remembers WHICH — the fix for a bug that reached the settings page:
 * seeding used to be guarded by "is the draft dirty?", and on first load an empty draft always differs from a
 * saved prompt, so the guard meant to protect an unsaved edit blocked the initial seed instead. The row then
 * showed mode Custom over an empty textarea with a live Save button — one click from silently wiping the
 * prompt. Comparing against the value the draft was seeded FROM tells the two states apart: not-yet-seeded is
 * `undefined`, an untouched draft still equals its seed, and anything else is the user's own typing. */
let seededFrom: string | undefined;
const promptDirty = computed(() => sandboxSettings.value !== undefined && prompt.value !== sandboxSettings.value.systemPrompt);
watch(
    () => sandboxSettings.value?.systemPrompt,
    (saved) => {
        if (saved === undefined) {
            return;
        }
        // Seed on first load, and follow a change made in ANOTHER window — but never over an edit in this one.
        if (seededFrom === undefined || prompt.value === seededFrom) {
            prompt.value = saved;
        }
        seededFrom = saved;
    },
    { immediate: true },
);

const saveSettings = (patch: Partial<SandboxSettings>): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, ...patch });
};
const savePrompt = (): void => {
    // Normalise BEFORE the dirty check, not inside the payload: saving a trimmed copy of an untrimmed draft
    // leaves the two permanently unequal, and the row would sit there claiming unsaved changes forever.
    prompt.value = prompt.value.trim();
    if (promptDirty.value) {
        saveSettings({ systemPrompt: prompt.value });
    }
};
// Switching base saves at once — it is a picker, not a draft. An unsaved custom edit is carried along rather
// than discarded: coming back to Custom finds the text still there, and it is only committed by Save.
const setPromptMode = (mode: string): void => saveSettings({ systemPromptMode: mode as SystemPromptMode });

// The two built-in prompts, as text (GET /settings/system-prompt/{base}). Cached per base once fetched, so
// reopening the dialog is instant and forking doesn't re-fetch.
const builtinPrompts = ref<Partial<Record<string, BuiltinPromptText>>>({});
const viewingBase = ref<`intentic` | `claude` | undefined>(undefined);
const { busy: builtinBusy, error: builtinError, run: runBuiltin } = useAsyncAction();
const loadBuiltin = async (base: `intentic` | `claude`): Promise<BuiltinPromptText | undefined> => {
    if (builtinPrompts.value[base] === undefined) {
        await runBuiltin(async () => {
            builtinPrompts.value = { ...builtinPrompts.value, [base]: await sandboxJson<BuiltinPromptText>(`/settings/system-prompt/${base}`) };
        }, `Couldn't read that system prompt from your sandbox.`);
    }
    return builtinPrompts.value[base];
};
const viewBuiltin = async (base: `intentic` | `claude`): Promise<void> => {
    viewingBase.value = base;
    await loadBuiltin(base);
};
// Fork a built-in into the editor and switch to Custom. The TEXT is deliberately left unsaved: it is a starting
// point to edit, and saving it as-is would pin this sandbox to today's copy of a prompt it currently gets for
// free. The MODE is saved, because that is the click the user just made.
const forkBuiltin = async (base: `intentic` | `claude`): Promise<void> => {
    const fetched = await loadBuiltin(base);
    if (fetched !== undefined) {
        prompt.value = fetched.text;
        viewingBase.value = undefined;
        setPromptMode(`custom`);
    }
};

// iq code search: load the iq plugin so the agent reaches for the iq CLI over grep/find/glob.
const toggleIqSearch = (value: boolean): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, iqSearch: value });
};

// Pre-injection: search for the user's message before the turn starts and hand the ranked answer to the model
// with it, so the first search is already paid for (turn-context.ts).
const toggleIqContext = (value: boolean): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, iqContext: value });
};

// Its measurement control, the same turn-level holdout the terse steer takes.
const iqContextHoldoutPercent = computed<number>(() => Math.round((sandboxSettings.value?.iqContextHoldout ?? 0) * 100));
const setIqContextHoldout = (fraction: number): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, iqContextHoldout: fraction });
};

// Dormant usage-limit auto-resume control. The shared build gate keeps this handler inert and the switch off;
// retaining both makes re-enabling the implementation an explicit one-line product decision.
const toggleAutoResume = (value: boolean): void => {
    const current = sandboxSettings.value;
    if (!USAGE_LIMIT_AUTO_RESUME_ENABLED || current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, autoResumeOnLimit: value });
};

// Provider-outage auto-resume: re-run a turn the provider killed, on an escalating shared backoff. Defaults ON —
// see the field comment in schemas.ts for why this one and not the limit resume beside it.
const toggleResumeAfterOutage = (value: boolean): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, resumeAfterOutage: value });
};

// Restart auto-resume: re-run a turn the DAEMON died under, from the turn journal, next time it boots (see
// agent/turn-journal.ts). On by default for the same reason as the outage resume above — a restart is usually
// this sandbox's own doing, and approving an environment change must not cost the run that asked for it.
const toggleAutoResumeOnRestart = (value: boolean): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, autoResumeOnRestart: value });
};

// Auto-land: whether a clean turn's work applies to the workspace the moment it finishes, or waits on the
// agent's branch as a "Ready to land" card. The sandbox-wide default — each agent can override it from its
// review panel's hold toggle, and agents without an override follow this wherever it points next.
const toggleAutoLand = (value: boolean): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, autoLand: value });
};

/* --- The landing gate ----------------------------------------------------------------------------------------
 * The check command run over the COMPOSITE of every agent's landed work, once the fleet goes quiet and before
 * the user starts staging (the daemon's gate/gate.ts argues that moment against the four alternatives). It
 * belongs on this tab and not in personal Settings for the same reason the quick model does: it names something
 * that only exists inside this sandbox — a command that has to run in THIS workspace's toolchain.
 *
 * Empty is the default and it means OFF, which is why there is no separate enable switch to disagree with it:
 * only the owner knows what verifies their workspace, and a guessed `pnpm test` would read as the gate finding a
 * bug on its first run. Committed on change rather than per keystroke — every save is a daemon round-trip, and
 * a half-typed command is a command. */
const setGateCommand = (event: Event): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    const gateCommand = (event.target as HTMLInputElement).value.trim();
    if (gateCommand !== current.gateCommand) {
        saveSandboxSettings.mutate({ ...current, gateCommand });
    }
};

// Whether a red gate wakes a fixer by itself. On by default WITH a command configured, unlike the other
// unattended-spend toggles, because the spend is the point: a red verdict nobody acts on has moved the CI
// round-trip into the workspace without taking it out of the user's day.
const toggleGateAutoFix = (value: boolean): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, gateAutoFix: value });
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
// The id + label list lives in savingsChart.ts, next to the projections that draw the same mechanisms on the
// Usage tab: a switch here and a segment there must never end up named two different things. Each entry renders
// one switch; the checklist round-trips through the spec string the daemon already threads to the filter, so
// every cleaner is individually A/B-benchmarkable without touching the settings JSON by hand.

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
const setOutputHoldout = (fraction: number): void => {
    const current = sandboxSettings.value;
    if (current === undefined) {
        return;
    }
    saveSandboxSettings.mutate({ ...current, outputHoldout: fraction });
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

/* What each mechanism has been worth, all-time — the readout that belongs NEXT TO ITS SWITCH. Unwindowed on
 * purpose: this page is where a switch is flipped, not where a period is compared, and the Usage tab's Savings
 * section owns the windowed chart. */
const { savings } = useSavings({});
const savedTokens = computed(() => savedByCleaner(savings.value?.input));
const cleaningOn = computed(() => (sandboxSettings.value?.outputCleaners ?? ``) !== `off`);

/* WHETHER THE PER-CLEANER CONTROLS DO ANYTHING. Under the rtk backend the daemon sets INTENTIC_RUN_FILTER=0 and
 * the PreToolUse hook prefixes `rtk ` instead (agent.ts outputFilter, agent-terminals.ts) — rtk brings its own
 * handlers, so the checklist and the holdout are inert and rendering them live was the screen's worst lie:
 * sixteen switches, a measurement control, and a savings figure that came from none of them.
 *
 * The MASTER toggle is not in that set. It says whether shell output is compressed at all, which the daemon now
 * honours on both backends ("off" ⇒ no filter and no `rtk ` prefix) — greying it out under rtk made the one
 * control that still worked look like a dead switch stuck in the on position. */
const nativeFilter = computed(() => (sandboxSettings.value?.filterBackend ?? `native`) === `native`);

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

        <!-- A save the daemon accepted but stored WITHOUT one of its fields: the control below has already
             snapped back to its old value, and without this line that reads as an input refusing to be typed
             into rather than as a sandbox that predates the setting. -->
        <p v-if="settingsDropped" :class="cmp.alertWarning()">{{ settingsDropped }}</p>

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
                <!-- Per-cleaner switches (the spec, as a checklist) — only meaningful while cleaning is on AND
                     the native filter is the one running. Under rtk none of this is wired to anything, so the
                     row says who is doing the work instead of offering controls that quietly do nothing. -->
                <template v-if="sandboxSettings !== undefined && cleaningOn" #below>
                    <p v-if="!nativeFilter" class="text-2xs text-muted">
                        rtk is compressing output on this sandbox, and it brings its own handlers — the per-cleaner switches and the holdout apply
                        only once the backend below is back on Native.
                    </p>
                    <div v-else class="flex flex-col gap-2">
                        <div class="flex items-baseline justify-between gap-2">
                            <p class="text-2xs font-medium uppercase tracking-wide text-subtle">Cleaners</p>
                            <!-- What each switch is WORTH, all-time, next to the switch itself. This is the
                                 tuning job: sixteen identical toggles are a wall, sixteen toggles carrying
                                 their own savings are a ranked list you can prune. -->
                            <p class="text-2xs text-subtle">tokens saved, all time</p>
                        </div>
                        <div class="grid grid-cols-2 gap-x-4 gap-y-1.5">
                            <label v-for="cleaner in CLEANER_OPTIONS" :key="cleaner.id" class="flex items-center justify-between gap-2">
                                <span class="flex min-w-0 items-baseline gap-1.5">
                                    <span class="truncate text-xs text-content">{{ cleaner.label }}</span>
                                    <!-- A cleaner with nothing recorded says nothing rather than "0": it has
                                         not been measured, which is a different claim from "worth nothing". -->
                                    <span v-if="savedTokens.get(cleaner.id) !== undefined" class="shrink-0 text-2xs tabular-nums text-success">
                                        ~{{ formatTokens(savedTokens.get(cleaner.id) ?? 0) }}
                                    </span>
                                </span>
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
                                    @change="(event: Event) => commitPercent(event, holdoutPercent, setOutputHoldout)"
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

            <!-- Realized savings, from the ledger of whichever backend is doing the compressing. The hero is one
                 number; everything that qualifies it — source, freshness, what it is a share of — sits under it
                 rather than trailing it as a run-on, because those are the facts that tell a live figure from a
                 frozen one, and this card once sat on a ledger nothing was writing any more.
                 The breakdown BY mechanism lives on the Usage tab, where a window exists to compare it over. -->
            <Row icon="wave-pulse" title="Output savings">
                <template #description>
                    <template v-if="savings !== undefined && savings.input.commands > 0">
                        <span class="font-medium text-success">{{ savings.input.savedPct }}% saved</span>
                        · ~{{ formatTokens(savings.input.rawTokens) }} → ~{{ formatTokens(savings.input.emittedTokens) }} tokens over
                        {{ savings.input.commands }} commands
                        <span v-if="savings.input.holdout.measuredSavedPct !== undefined">
                            · <span class="text-content">{{ savings.input.holdout.measuredSavedPct }}%</span> measured against the holdout
                        </span>
                        <br />
                        <span class="text-muted">
                            via {{ savings.input.source === `rtk` ? `rtk gain` : `the output filter` }}
                            <template v-if="savings.input.updatedAt !== undefined"
                                >· last command {{ relativeTime(savings.input.updatedAt) }}</template
                            >
                        </span>
                    </template>
                    <!-- Absence used to be the empty state: the row simply wasn't rendered, so a page of
                         switches promising savings showed nothing at all about them. -->
                    <span v-else class="text-muted">
                        Nothing measured yet — the ledger fills as the agent runs shell commands, one row per command.
                    </span>
                </template>
                <template v-if="savings !== undefined && savings.input.gaps.length > 0" #below>
                    <div class="flex flex-col gap-1">
                        <p class="text-2xs font-medium uppercase tracking-wide text-subtle">Un-cleaned (add a handler)</p>
                        <p v-for="gap in savings.input.gaps.slice(0, 5)" :key="gap.command" class="truncate font-mono text-2xs text-muted">
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
                <!-- The steer is one line appended to the system prompt, so a custom prompt takes it with
                     everything else. Said here rather than left to be discovered: a switch that is on and doing
                     nothing is worse than one that is off. -->
                <template #below>
                    <p v-if="promptMode === `custom`" class="text-2xs text-warning">
                        Not applied while your own system prompt is set — say it in the prompt below instead.
                    </p>
                    <!-- The steer's measurement control. Unlike a cleaned command, which carries its own raw
                         baseline, a turn cannot be re-run to see what it would have said unsteered — so the
                         only way to know what this switch is worth is to leave a slice of turns unsteered and
                         compare. The control costs the very tokens it measures, which is why it is opt-in and
                         says what it buys. -->
                    <template v-else-if="sandboxSettings?.terseOutput === true">
                        <label class="flex items-center justify-between gap-3">
                            <span class="flex min-w-0 flex-col">
                                <span class="text-xs text-content">Measure it</span>
                                <span class="text-2xs text-muted">
                                    Run this % of turns without the steer, as a control. Both arms need ~30 turns before a figure is reported.
                                </span>
                            </span>
                            <span class="flex shrink-0 items-center gap-1">
                                <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    :value="terseHoldoutPercent"
                                    :class="cmp.input('w-16 text-right text-xs')"
                                    @change="(event: Event) => commitPercent(event, terseHoldoutPercent, setTerseHoldout)"
                                />
                                <span class="text-xs text-muted">%</span>
                            </span>
                        </label>
                        <p v-if="savings?.output !== undefined" class="mt-2 border-t border-line pt-2 text-2xs">
                            <template v-if="savings.output.deltaPct !== undefined">
                                <span class="tabular-nums" :class="savings.output.deltaPct < 0 ? `text-success` : `text-muted`">
                                    {{ savings.output.deltaPct < 0 ? `↓` : `↑` }}{{ Math.abs(savings.output.deltaPct) }}%
                                </span>
                                <span class="text-muted">
                                    output tokens per turn ± {{ savings.output.marginPct }}pp, over {{ savings.output.on.turns }} steered vs
                                    {{ savings.output.off.turns }} unsteered turns.
                                </span>
                            </template>
                            <span v-else class="text-muted">
                                Measuring — {{ savings.output.on.turns }} steered and {{ savings.output.off.turns }} unsteered turns so far, of
                                {{ savings.output.minTurns }} needed per arm.
                            </span>
                        </p>
                    </template>
                </template>
            </Row>

            <!-- System prompt — which prompt the agent IS. Two built-in bases the app maintains, and an escape
                 hatch that replaces them. It sits directly under Terse responses because Custom SUPERSEDES it:
                 that mode drops the steer along with everything else, and the row above says so when it does.

                 Every option can be read before it is chosen — a prompt picker whose options are three words
                 each is a guess, not a choice — and either base can be forked into a starting point. -->
            <Row icon="pencil" title="System prompt">
                <template #description>
                    <template v-if="promptMode === `custom`">Your own prompt — the agent runs on this text alone.</template>
                    <template v-else-if="promptMode === `claude`">Claude Code's own prompt, as shipped in your sandbox's CLI.</template>
                    <template v-else>Intentic's own prompt, tuned for this app.</template>
                </template>
                <template #control>
                    <Segmented :model-value="promptMode" :options="PROMPT_MODES" @update:model-value="setPromptMode" />
                </template>
                <template #below>
                    <!-- A base is read, not edited: the links are the whole surface. Forking is how you get from
                         "I like this but for one paragraph" to a custom prompt without retyping it. -->
                    <template v-if="promptMode !== `custom`">
                        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <button type="button" class="text-2xs font-medium text-link hover:underline" @click="viewBuiltin(promptMode)">
                                View this prompt
                            </button>
                            <button
                                type="button"
                                class="text-2xs font-medium text-link hover:underline disabled:opacity-50"
                                :disabled="builtinBusy"
                                @click="forkBuiltin(promptMode)"
                            >
                                Edit a copy of it
                            </button>
                            <button
                                type="button"
                                class="text-2xs font-medium text-muted hover:text-content hover:underline"
                                @click="viewBuiltin(promptMode === `intentic` ? `claude` : `intentic`)"
                            >
                                Compare with {{ promptMode === `intentic` ? `Claude's` : `Intentic's` }}
                            </button>
                        </div>
                    </template>

                    <template v-else>
                        <textarea
                            v-model="prompt"
                            rows="5"
                            :maxlength="PROMPT_MAX"
                            :disabled="sandboxSettings === undefined"
                            placeholder="Write the assistant's system prompt, or start from one of the built-in prompts below."
                            :class="cmp.input('w-full resize-y font-mono text-xs')"
                            aria-label="System prompt"
                            @change="savePrompt"
                        ></textarea>

                        <!-- What Custom actually costs, shown while they are in it rather than discovered later
                             when the chat's cards quietly stop appearing. -->
                        <p :class="cmp.alertWarning('mt-1.5 text-2xs')">
                            Your text becomes the whole system prompt. Both built-in prompts are gone, and so is what this app tells the assistant
                            about itself — the question and plan cards, the checklist panel, and the browser tools it would otherwise know to reach
                            for. Terse responses stops applying too. Describe whatever you still want.
                        </p>

                        <div class="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                            <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <button
                                    type="button"
                                    class="text-2xs font-medium text-link hover:underline disabled:opacity-50"
                                    :disabled="builtinBusy"
                                    @click="forkBuiltin(`intentic`)"
                                >
                                    Start from Intentic's
                                </button>
                                <button
                                    type="button"
                                    class="text-2xs font-medium text-link hover:underline disabled:opacity-50"
                                    :disabled="builtinBusy"
                                    @click="forkBuiltin(`claude`)"
                                >
                                    Start from Claude's
                                </button>
                            </span>
                            <span class="flex shrink-0 items-center gap-2">
                                <span v-if="prompt.length > PROMPT_MAX - 1000" class="text-2xs text-muted"
                                    >{{ prompt.length }} / {{ PROMPT_MAX }}</span
                                >
                                <!-- Blur already saves; the button is for the user who can't tell that it did.
                                     `mousedown.prevent` keeps focus in the textarea, so pressing it doesn't blur-save
                                     the field and unmount the button out from under the click that was landing on it. -->
                                <Button
                                    v-if="promptDirty"
                                    label="Save"
                                    size="small"
                                    :loading="saveSandboxSettings.isPending.value"
                                    @mousedown.prevent
                                    @click="savePrompt"
                                />
                            </span>
                        </div>
                    </template>
                    <p v-if="builtinError !== undefined" :class="cmp.alertDanger('mt-1.5 text-2xs')">{{ builtinError }}</p>
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

            <!-- Retrieve before the turn — the daemon searches for the message and hands the ranked answer to the
                 assistant with it, so a turn that would have opened with two or three searches opens with the
                 anchors. Directly under iq code search because they compose and are easy to confuse: that one
                 teaches the assistant to search, this one answers before it decides to. -->
            <Row
                icon="forward"
                title="Retrieve before the turn"
                description="Search the workspace for each message up front and hand the assistant the answer with it."
            >
                <template #control>
                    <ToggleSwitch
                        :model-value="sandboxSettings?.iqContext ?? false"
                        :disabled="sandboxSettings === undefined"
                        @update:model-value="toggleIqContext"
                    />
                </template>
                <template #below>
                    <!-- Same control the terse steer takes, for the same reason: a turn cannot be re-run without
                         the context it opened with, so the only way to know whether the injected tokens paid for
                         themselves is to leave a slice of turns cold and compare the cost. -->
                    <template v-if="sandboxSettings?.iqContext === true">
                        <label class="flex items-center justify-between gap-3">
                            <span class="flex min-w-0 flex-col">
                                <span class="text-xs text-content">Measure it</span>
                                <span class="text-2xs text-muted">
                                    Run this % of turns without the retrieved context, as a control. Both arms need ~30 turns before a figure is
                                    reported.
                                </span>
                            </span>
                            <span class="flex shrink-0 items-center gap-1">
                                <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    :value="iqContextHoldoutPercent"
                                    :class="cmp.input('w-16 text-right text-xs')"
                                    @change="(event: Event) => commitPercent(event, iqContextHoldoutPercent, setIqContextHoldout)"
                                />
                                <span class="text-xs text-muted">%</span>
                            </span>
                        </label>
                        <p v-if="savings?.context !== undefined" class="mt-2 border-t border-line pt-2 text-2xs">
                            <template v-if="savings.context.deltaPct !== undefined">
                                <span class="tabular-nums" :class="savings.context.deltaPct < 0 ? `text-success` : `text-muted`">
                                    {{ savings.context.deltaPct < 0 ? `↓` : `↑` }}{{ Math.abs(savings.context.deltaPct) }}%
                                </span>
                                <span class="text-muted">
                                    cost per turn ± {{ savings.context.marginPct }}pp, over {{ savings.context.on.turns }} retrieved vs
                                    {{ savings.context.off.turns }} cold turns.
                                </span>
                            </template>
                            <span v-else class="text-muted">
                                Measuring — {{ savings.context.on.turns }} retrieved and {{ savings.context.off.turns }} cold turns so far, of
                                {{ savings.context.minTurns }} needed per arm.
                            </span>
                        </p>
                    </template>
                </template>
            </Row>

            <!-- The two auto-resumes, adjacent because they answer the same question ("who restarts a turn that
                 died through no fault of its own?") and default OPPOSITE ways on purpose. A usage limit spends
                 the user's own allowance and waits hours, so it is opt-in; a provider outage spends nothing the
                 dead turn hadn't already committed and clears in minutes, so it is opt-out. Both are also
                 offered from the chat at the moment they would have helped. -->
            <Row
                icon="clock"
                title="Auto-resume after usage limits"
                description="Currently unavailable. Usage-limit turns remain stopped after the limit resets."
            >
                <template #control>
                    <ToggleSwitch
                        :model-value="USAGE_LIMIT_AUTO_RESUME_ENABLED && (sandboxSettings?.autoResumeOnLimit ?? false)"
                        :disabled="!USAGE_LIMIT_AUTO_RESUME_ENABLED || sandboxSettings === undefined"
                        @update:model-value="toggleAutoResume"
                    />
                </template>
            </Row>

            <Row
                icon="refresh"
                title="Auto-resume after provider outages"
                description="When the model provider fails a turn (500, 529 at capacity, a dropped connection), retry it automatically — waiting longer between each attempt, and only one attempt at a time across all your agents, so an outage isn't hammered."
            >
                <template #control>
                    <ToggleSwitch
                        :model-value="sandboxSettings?.resumeAfterOutage ?? true"
                        :disabled="sandboxSettings === undefined"
                        @update:model-value="toggleResumeAfterOutage"
                    />
                </template>
            </Row>

            <!-- Restart auto-resume — the third of these, for the last thing that kills a turn nobody chose to
                 kill: this sandbox restarting under it. Every update, environment approval and image rebuild
                 recreates the container, so the common case is the user's OWN approval taking down the run that
                 asked for it. On by default, like the outage row above it. -->
            <Row
                icon="refresh"
                title="Resume turns after a restart"
                description="When the sandbox restarts while an agent is mid-turn — an update, an approved environment change, a crash — pick that turn back up when it comes back."
            >
                <template #control>
                    <ToggleSwitch
                        :model-value="sandboxSettings?.autoResumeOnRestart ?? true"
                        :disabled="sandboxSettings === undefined"
                        @update:model-value="toggleAutoResumeOnRestart"
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

            <!-- Auto-land — the sandbox's standing answer to "does finished work reach my workspace by itself".
                 Daemon-side rather than a browser preference, because automation-opened agents (Discord,
                 webhooks, email) finish turns with no browser in the room. Off turns every clean completion
                 into a "Ready to land" card; per-agent exceptions live on the review panel's hold toggle. -->
            <Row
                icon="download"
                title="Land finished work automatically"
                description="When an agent finishes cleanly, apply its work to your workspace as uncommitted changes right away. Off, finished work waits on each agent's branch — the card reads “Ready to land” and you land it from the board or the review."
            >
                <template #control>
                    <ToggleSwitch
                        :model-value="sandboxSettings?.autoLand ?? true"
                        :disabled="sandboxSettings === undefined"
                        @update:model-value="toggleAutoLand"
                    />
                </template>
            </Row>

            <!-- The landing gate — the check run over the composite of everything that has landed, once the
                 fleet goes quiet. This is the shift-left of the CI round-trip: the same question CI asks, asked
                 of the same artifact (the uncommitted main tree), while the agents that wrote it are still warm
                 and their per-file attribution is still live. The verdict surfaces on the Changes panel. -->
            <Row
                icon="shield"
                title="Check landed work before you commit"
                description="Run this command over your workspace once the fleet goes quiet, and show the result on the Changes panel. It runs in the workspace root, exactly as a terminal would. Empty turns the gate off."
            >
                <template #control>
                    <input
                        type="text"
                        placeholder="pnpm test"
                        spellcheck="false"
                        :value="sandboxSettings?.gateCommand ?? ``"
                        :disabled="sandboxSettings === undefined"
                        :class="cmp.input(`w-56 font-mono text-xs`)"
                        @change="setGateCommand"
                    />
                </template>
            </Row>

            <!-- Only meaningful with a command configured, so it hides without one rather than sitting there
                 governing nothing — the same reason the terse-holdout row appears only once the steer is on. -->
            <Row
                v-if="(sandboxSettings?.gateCommand ?? ``) !== ``"
                icon="bolt"
                title="Fix a failed check with an agent"
                description="When the check fails, wake an agent on your workspace with the failing output and the files' agent attribution, to fix it in place before you commit. One attempt per result — a check that fails for a reason no agent can fix costs one turn, not a loop."
            >
                <template #control>
                    <ToggleSwitch
                        :model-value="sandboxSettings?.gateAutoFix ?? true"
                        :disabled="sandboxSettings === undefined"
                        @update:model-value="toggleGateAutoFix"
                    />
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

        <!-- Either built-in prompt, in full. Monospace and selectable because the point is to be READ and
             forked, not admired; Claude's version is on show because a fork taken today is a snapshot, and
             knowing which build it came from is the only way to tell how old one is. -->
        <Dialog
            :visible="viewingBase !== undefined"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :header="viewingBase === `claude` ? `Claude Code's system prompt` : `Intentic's system prompt`"
            :style="{ width: '48rem', maxWidth: '95vw' }"
            @update:visible="viewingBase = undefined"
        >
            <div v-if="builtinBusy" class="flex items-center gap-2 py-6 text-xs text-muted">
                <Icon name="spinner" class="animate-spin" />
                Reading it from your sandbox…
            </div>
            <p v-else-if="builtinError !== undefined" :class="cmp.alertDanger()">{{ builtinError }}</p>
            <template v-else-if="viewingBase !== undefined && builtinPrompts[viewingBase] !== undefined">
                <p class="text-xs text-muted">
                    <template v-if="viewingBase === `claude`">
                        Claude Code's own prompt, read out of the CLI in your sandbox
                        <span class="font-mono text-content">{{ builtinPrompts[viewingBase]?.version }}</span> — not a copy kept by this app. Choose
                        Claude and it keeps updating with the sandbox; fork it and you own it from here.
                    </template>
                    <template v-else>
                        Intentic's own prompt — the default, and the one we tune for this app. Choose Intentic and it keeps updating with the app;
                        fork it and you own it from here.
                    </template>
                    Either way, this app's own guidance about its question cards, checklist panel and browser tools is added on top; only a custom
                    prompt drops that.
                </p>
                <pre class="mt-2 max-h-[55dvh] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 text-2xs text-content">{{
                    builtinPrompts[viewingBase]?.text
                }}</pre>
                <div class="mt-3 flex items-center justify-end gap-2">
                    <CopyButton :text="builtinPrompts[viewingBase]?.text ?? ``" label="Copy" />
                    <Button label="Edit a copy" size="small" @click="forkBuiltin(viewingBase)" />
                </div>
            </template>
        </Dialog>
    </div>
</template>
