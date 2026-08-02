<script setup lang="ts">
import { type AgentProvider, parsePinned } from "@intentic/sandbox-contract";
import { Picker, type PickerOptions, Row, RowGroup, Segmented } from "@intentic-app/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import { providerReady } from "../../../composables/chat/access";
import { effortsFor } from "../../../composables/chat/effortScale";
import { pickerEntries } from "../../../composables/chat/modelPicker";
import { providerDisplayLabel } from "../../../composables/chat/providerCatalog";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import ProviderLogo from "../../../chat/ProviderLogo.vue";

/* WHAT PROVES THE WORK. Two checks with nothing in common but that question: one the daemon asks of a turn that
 * edited code and proved nothing, and one the workspace runs at the last moment before code leaves the machine.
 * The fix model belongs here rather than with the other model pick because it is meaningless without the check
 * above it — it names where the suggested fix session opens, and the row hides itself when no check is set. */

const { settings, patch } = useSandboxSettings();

/* --- The pre-push check -------------------------------------------------------------------------------------
 * The command the workspace runs when a push is about to go out. It belongs on this tab and not in personal
 * Settings for the same reason the quick model does: it names something that only exists inside this sandbox —
 * a command that has to run in THIS workspace's toolchain.
 *
 * Empty is the default and it means OFF, which is why there is no separate enable switch to disagree with it:
 * only the owner knows what verifies their workspace, and a guessed `pnpm test` would read as the check finding
 * a bug on its first run. Committed on change rather than per keystroke — every save is a daemon round-trip,
 * and a half-typed command is a command. */
const prepushCommandDraft = ref(``);
let prepushSeededFrom: string | undefined;
watch(
    () => settings.value?.prepushCommand,
    (saved) => {
        if (saved === undefined) {
            return;
        }
        if (prepushSeededFrom === undefined || prepushCommandDraft.value === prepushSeededFrom) {
            prepushCommandDraft.value = saved;
        }
        prepushSeededFrom = saved;
    },
    { immediate: true },
);

const savePrepushCommand = (): void => {
    const prepushCommand = prepushCommandDraft.value.trim();
    if (prepushCommand !== settings.value?.prepushCommand) {
        patch({ prepushCommand });
    }
};

/* WHICH MODEL THE PROPOSED FIX OPENS ON. Every connected provider's full catalog in CATALOG order — pointedly
 * not cheapest-first like the quick model's list, because these are opposite jobs: the quick model exists to
 * keep a one-click helper off the frontier tier, while this one has to read a failing suite and repair it. The
 * empty row means "whatever the composer is set to", which is the honest floor — it is the model the user
 * already chose to work with, and it keeps following them as they change it. */
const fixModelOptions = computed<PickerOptions>(() => {
    const byProvider = new Map<AgentProvider, { value: string; label: string }[]>();
    for (const entry of pickerEntries.value) {
        // A provider with no credential is not offered: pinning a model this sandbox cannot send to would leave
        // the dialog opening on a locked row every time, which is a setting that only ever costs a correction.
        // ACP agents own their own model (empty id), so there is nothing here to pin.
        if (!providerReady(entry.provider) || entry.value === ``) {
            continue;
        }
        const options = byProvider.get(entry.provider) ?? [];
        byProvider.set(entry.provider, options);
        options.push({ value: entry.key, label: entry.label });
    }
    return [
        { options: [{ value: ``, label: `Composer default`, description: `Whatever your chat is set to` }] },
        ...[...byProvider].map(([provider, options]) => ({ label: providerDisplayLabel(provider), options })),
    ];
});

// The pinned choice, parsed — the effort scale below is a property of the MODEL, so there is nothing to offer
// until one is named.
const fixModel = computed(() => parsePinned(settings.value?.prepushFixModel ?? ``));
/* `thinking: false` because the setting pins a starting effort, not a turn: extended thinking is a per-turn
 * Claude knob the suggestion dialog still owns, and Conversation.effort re-clamps this pick against whatever it
 * is when the session actually opens.
 *
 * "Default" leads with the empty value, matching the model row above it, and is not decoration: an unpinned
 * effort really does mean "whatever the composer is set to", and rendering the scale's lowest segment as
 * selected instead would claim this sandbox had pinned `low` when it had pinned nothing. */
const fixEffortOptions = computed(() =>
    fixModel.value === undefined
        ? []
        : [
              { label: `Default`, value: `` },
              ...effortsFor(fixModel.value.provider, fixModel.value.model, false).map((e) => ({ label: e.label, value: e.value })),
          ],
);

// The effort scale belongs to the model, so a new model drops the old pick rather than carrying one its scale
// may not contain. Empty re-seeds from the composer — the same floor the model row itself defaults to.
const setPrepushFixModel = (value: string): void => patch({ prepushFixModel: value, prepushFixEffort: `` });

// A pinned key is `${provider}:${model}` — the provider prefix drives the row's brand mark.
const providerOfKey = (key: string): AgentProvider => key.slice(0, key.indexOf(`:`)) as AgentProvider;
</script>

<template>
    <RowGroup label="Checks">
        <!-- Verify before finishing — the daemon keeps a per-turn ledger of edited code against the checks
             that ran, and asks once when a turn tries to end with neither. Off by default because only the
             owner knows what verifies their workspace: a repo with failing baseline tests would get an ask
             it cannot satisfy, and the ask costs a whole model turn. -->
        <Row
            icon="shield"
            title="Verify before finishing"
            description="If a turn changes code and no check passes afterwards, ask the assistant once to run one."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.verifyOnStop ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ verifyOnStop: value })"
                />
            </template>
            <template #below>
                <p v-if="settings?.verifyOnStop === true" class="text-2xs text-muted">
                    It names the test/lint/typecheck scripts this workspace actually defines, and asks at most twice per turn. Edits to documentation
                    never trigger it.
                </p>
            </template>
        </Row>

        <!-- The pre-push check — the shift-left of the CI round-trip: the same question CI asks, asked of the
             same artifact, at the last moment before it leaves the machine and while the user is still standing
             there. The command gets the row's full width rather than a 14rem control slot: it is a shell line,
             it is read left-to-right, and truncating `pnpm -w turbo run test --filter=…` at the tenth character
             made a configured check indistinguishable from a mistyped one. -->
        <Row
            icon="shield"
            title="Check before you push"
            description="Run this command over your workspace when you push. It runs in the workspace root, exactly as a terminal would — pass and the push goes, fail and you get the output. Empty turns the check off."
        >
            <template #below>
                <div
                    class="flex items-center gap-2 rounded-lg border border-line bg-canvas px-2.5 py-1.5 focus-within:border-line-strong"
                    :class="{ 'opacity-50': settings === undefined }"
                >
                    <span class="select-none font-mono text-xs text-subtle" aria-hidden="true">$</span>
                    <input
                        v-model="prepushCommandDraft"
                        type="text"
                        placeholder="pnpm test"
                        spellcheck="false"
                        autocapitalize="off"
                        autocorrect="off"
                        aria-label="Pre-push check command"
                        :disabled="settings === undefined"
                        class="min-w-0 flex-1 bg-transparent font-mono text-xs text-content placeholder:text-subtle focus:outline-none"
                        @change="savePrepushCommand"
                    />
                </div>
            </template>
        </Row>

        <!-- Only meaningful with a command configured, so it hides without one rather than sitting there
             governing nothing — the same reason the terse-holdout row appears only once the steer is on. -->
        <Row
            v-if="(settings?.prepushCommand ?? ``) !== ``"
            icon="bolt"
            title="Model for fixing a failed check"
            description="Where the suggested fix session opens when the check fails. Nothing runs on its own — the prompt, this model and its effort are all editable in the dialog before you start it."
        >
            <template #control>
                <Picker
                    :model-value="settings?.prepushFixModel ?? ``"
                    :options="fixModelOptions"
                    :disabled="settings === undefined"
                    class="w-56 py-1.5 text-xs"
                    aria-label="Model for fixing a failed check"
                    @update:model-value="(value: string | undefined) => setPrepushFixModel(value ?? ``)"
                >
                    <template #icon="{ option }">
                        <Icon v-if="option.value === ``" name="comments" class="shrink-0 text-xs text-muted" aria-hidden="true" />
                        <ProviderLogo v-else :provider="providerOfKey(option.value)" class="shrink-0 text-xs text-muted" />
                    </template>
                </Picker>
            </template>
            <!-- The effort scale belongs to the model, so it appears only once one is pinned — and a model
                 whose runtime forwards no effort at all publishes none, which correctly draws nothing. -->
            <template v-if="fixEffortOptions.length > 0" #below>
                <div class="flex items-center justify-between gap-3">
                    <span class="text-xs text-muted">Reasoning effort</span>
                    <Segmented
                        :model-value="settings?.prepushFixEffort ?? ``"
                        :options="fixEffortOptions"
                        @update:model-value="(prepushFixEffort: string) => patch({ prepushFixEffort })"
                    />
                </div>
            </template>
        </Row>
    </RowGroup>
</template>
