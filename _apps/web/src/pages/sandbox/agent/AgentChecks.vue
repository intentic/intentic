<script setup lang="ts">
import { Row, RowGroup } from "@intentic-app/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { ref, watch } from "vue";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";

/* WHAT PROVES THE WORK. Two checks with nothing in common but that question: one the daemon asks of a turn that
 * edited code and proved nothing, and one the workspace runs at the last moment before code leaves the machine.
 *
 * WHICH MODEL the failed check's suggested fix opens on is NOT here — it is `agentRunModel`, up in the Models
 * group, because that session is an agent run like the Fix button on a red pipeline and a Maintenance chore.
 * Keeping a second pinned model down here would have meant this tab quietly governing the same thing twice,
 * with two settings free to disagree about a question that has one answer. */

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
    </RowGroup>
</template>
