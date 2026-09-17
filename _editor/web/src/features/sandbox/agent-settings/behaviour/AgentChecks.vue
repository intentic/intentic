<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useDraft } from "../../../../lib/useDraft";
import { NAMED_RULES } from "../../environment/rules";
import { useRules } from "../../environment/useRules";
import { useT } from "@intentic/ui/i18n";

// Five named toggles over the general rules engine (useRules.ts / NAMED_RULES); nothing here it can't already
// express. Verify-edits and verify-removals cover opposite halves of a turn (written vs. deleted code); the
// tests check is the only one that doubts a green result rather than a missing one.

const t = useT();

const { settings, byId, upsert, remove, setEnabled } = useRules();

const verify = () => byId(NAMED_RULES.verify);
const removals = () => byId(NAMED_RULES.removals);
const viewing = () => byId(NAMED_RULES.viewing);
const tests = () => byId(NAMED_RULES.tests);
const prepush = () => byId(NAMED_RULES.prepush);

// Built-in: compares edited code against the checks that ran; not a command a user could type.
const setVerify = (on: boolean): void => {
    const existing = verify();
    if (existing !== undefined) {
        setEnabled(existing.id, on);
        return;
    }
    upsert({
        id: NAMED_RULES.verify,
        label: t(`sandbox.agentChecks.verifyBeforeFinishing`),
        moment: `turn.ending`,
        action: { kind: `builtin`, name: `verify-edits` },
        enabled: on,
    });
};

// Built-in: weighs deleted lines against `git log` history for those lines.
const setRemovals = (on: boolean): void => {
    const existing = removals();
    if (existing !== undefined) {
        setEnabled(existing.id, on);
        return;
    }
    upsert({
        id: NAMED_RULES.removals,
        label: t(`sandbox.agentChecks.checkWhatDeleted`),
        moment: `turn.ending`,
        action: { kind: `builtin`, name: `verify-removals` },
        enabled: on,
    });
};

// Built-in: tracks which rendered surfaces a turn changed and whether a browser observed them afterward.
const setViewing = (on: boolean): void => {
    const existing = viewing();
    if (existing !== undefined) {
        setEnabled(existing.id, on);
        return;
    }
    upsert({
        id: NAMED_RULES.viewing,
        label: t(`sandbox.agentChecks.lookAtWhatChanged`),
        moment: `turn.ending`,
        action: { kind: `builtin`, name: `verify-ui-edits` },
        enabled: on,
    });
};

// Built-in: compares touched test files against the same files at HEAD and against pre-turn code.
const setTests = (on: boolean): void => {
    const existing = tests();
    if (existing !== undefined) {
        setEnabled(existing.id, on);
        return;
    }
    upsert({
        id: NAMED_RULES.tests,
        label: t(`sandbox.agentChecks.checkWhatDidTo`),
        moment: `turn.ending`,
        action: { kind: `builtin`, name: `verify-tests` },
        enabled: on,
    });
};

// Command run before a push goes out; empty means off. Clearing the field deletes the rule rather than
// disabling it; the value commits on change, not per keystroke.
const prepushCommand = (): string => {
    const action = prepush()?.action;
    return action?.kind === `command` ? action.command : ``;
};

const prepushDraft = useDraft(prepushCommand);

const savePrepush = (): void => {
    const command = prepushDraft.value.trim();
    const existing = prepush();
    if (command === ``) {
        if (existing !== undefined) {
            remove(existing.id);
        }
        return;
    }
    if (existing?.action.kind === `command` && existing.action.command === command) {
        return;
    }
    upsert({
        id: NAMED_RULES.prepush,
        label: t(`sandbox.agentChecks.checkBeforePush`),
        moment: `push.starting`,
        // Falls back to the schema's own default; not restated here.
        action: { kind: `command`, command, timeoutMs: existing?.action.kind === `command` ? existing.action.timeoutMs : 900_000 },
        enabled: true,
    });
};
</script>

<template>
    <RowGroup :label="t(`sandbox.agentChecks.checks`)">
        <!-- Ledger of edited code against checks run for the turn; asks once if a turn ends with neither. -->
        <Row icon="shield" :title="t(`sandbox.agentChecks.verifyBeforeFinishing`)" :description="t(`sandbox.agentChecks.promptAssistantToRun`)">
            <template #control>
                <ToggleSwitch :model-value="verify()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setVerify" />
            </template>
        </Row>

        <!-- Weighs deleted lines against repository history; asks once for a line that was deleted before, came from a fix, or sat untouched. -->
        <Row icon="shield" :title="t(`sandbox.agentChecks.checkWhatDeleted`)" :description="t(`sandbox.agentChecks.askAboutRemovedCode`)">
            <template #control>
                <ToggleSwitch :model-value="removals()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setRemovals" />
            </template>
        </Row>

        <!-- Prompts a browser check after a turn edits a rendered surface, since a suite can't see a clipped label or a misaligned border. -->
        <Row icon="eye" :title="t(`sandbox.agentChecks.lookAtWhatChanged`)" :description="t(`sandbox.agentChecks.promptAssistantToOpen`)">
            <template #control>
                <ToggleSwitch :model-value="viewing()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setViewing" />
            </template>
        </Row>

        <!-- Reads each touched test file against HEAD (for weakened assertions) and against pre-turn code (for a new test that already passed). -->
        <Row icon="list-check" :title="t(`sandbox.agentChecks.checkWhatDidTo`)" :description="t(`sandbox.agentChecks.askAboutAssertionsGot`)">
            <template #control>
                <ToggleSwitch :model-value="tests()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setTests" />
            </template>
            <template #below>
                <p v-if="tests()?.enabled === true" class="text-2xs text-muted">
                    {{ t(`sandbox.agentChecks.reRunAgainstOld`) }}
                </p>
            </template>
        </Row>

        <!-- Runs the same check CI would, before the push leaves the machine. -->
        <Row icon="shield" :title="t(`sandbox.agentChecks.beforeEveryPush`)" :description="t(`sandbox.agentChecks.runOneCheckBefore`)">
            <template #below>
                <div class="ui-field-shell flex items-center gap-2 px-2.5 py-1.5" :class="{ 'opacity-50': settings === undefined }">
                    <span class="select-none font-mono text-xs text-subtle" aria-hidden="true">$</span>
                    <input
                        v-model="prepushDraft"
                        type="text"
                        :placeholder="t(`sandbox.agentChecks.pnpmTest`)"
                        spellcheck="false"
                        autocapitalize="off"
                        autocorrect="off"
                        :aria-label="t(`sandbox.agentChecks.prePushCheckCommand`)"
                        :disabled="settings === undefined"
                        class="field-bare min-w-0 flex-1 font-mono md:text-xs"
                        @change="savePrepush"
                    />
                </div>
            </template>
        </Row>
    </RowGroup>
</template>
