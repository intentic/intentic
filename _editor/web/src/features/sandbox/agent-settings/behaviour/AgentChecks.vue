<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useDraft } from "../../../../lib/useDraft";
import { NAMED_RULES } from "../../environment/rules";
import { useRules } from "../../environment/useRules";

// Five named toggles over the general rules engine (useRules.ts / NAMED_RULES); nothing here it can't already
// express. Verify-edits and verify-removals cover opposite halves of a turn (written vs. deleted code); the
// tests check is the only one that doubts a green result rather than a missing one.

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
        label: `Verify before finishing`,
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
        label: `Check what it deleted`,
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
        label: `Look at what it changed`,
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
        label: `Check what it did to the tests`,
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
        label: `Check before you push`,
        moment: `push.starting`,
        // Falls back to the schema's own default; not restated here.
        action: { kind: `command`, command, timeoutMs: existing?.action.kind === `command` ? existing.action.timeoutMs : 900_000 },
        enabled: true,
    });
};
</script>

<template>
    <RowGroup label="Checks">
        <!--
            Ledger of edited code against checks run for the turn; asks once if a turn ends with neither.
            Off by default: a repo with failing baseline tests would get an ask it can't satisfy.
        -->
        <Row icon="shield" title="Verify before finishing" description="Prompt the assistant to run a check after code changes.">
            <template #control>
                <ToggleSwitch :model-value="verify()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setVerify" />
            </template>
        </Row>

        <!--
            Weighs deleted lines against repository history; asks once for a line that was deleted before, came from
            a fix, or sat untouched. Off by default; silent on ordinary removals.
        -->
        <Row icon="shield" title="Check what it deleted" description="Ask about removed code the project's history defends.">
            <template #control>
                <ToggleSwitch :model-value="removals()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setRemovals" />
            </template>
        </Row>

        <!--
            Prompts a browser check after a turn edits a rendered surface, since a suite can't see a clipped label or a
            misaligned border. Off by default; silent if nothing rendered changed.
        -->
        <Row icon="eye" title="Look at what it changed" description="Prompt the assistant to open the view after changes to the interface.">
            <template #control>
                <ToggleSwitch :model-value="viewing()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setViewing" />
            </template>
        </Row>

        <!--
            Reads each touched test file against HEAD (for weakened assertions) and against pre-turn code (for a new
            test that already passed). Reports rather than blocks, since legitimate refactors pass both; off by default.
        -->
        <Row
            icon="list-check"
            title="Check what it did to the tests"
            description="Ask about assertions that got weaker, and a new test that passes without the change."
        >
            <template #control>
                <ToggleSwitch :model-value="tests()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setTests" />
            </template>
            <template #below>
                <p v-if="tests()?.enabled === true" class="text-2xs text-muted">
                    The re-run against the old code covers up to three test files per turn and only reverts source changed in the same package: a
                    sibling package is imported as its built output, where there is nothing to swap.
                </p>
            </template>
        </Row>

        <!--
            Runs the same check CI would, before the push leaves the machine. Full-width input, not a small control slot:
            truncating a long shell command would make a configured check look mistyped.
        -->
        <Row icon="shield" title="Check before you push" description="Run a check before pushing code.">
            <template #below>
                <div
                    class="ui-field-shell flex items-center gap-2 px-2.5 py-1.5"
                    :class="{ 'opacity-50': settings === undefined }"
                >
                    <span class="select-none font-mono text-xs text-subtle" aria-hidden="true">$</span>
                    <input
                        v-model="prepushDraft"
                        type="text"
                        placeholder="pnpm test"
                        spellcheck="false"
                        autocapitalize="off"
                        autocorrect="off"
                        aria-label="Pre-push check command"
                        :disabled="settings === undefined"
                        class="field-bare min-w-0 flex-1 font-mono md:text-xs"
                        @change="savePrepush"
                    />
                </div>
            </template>
        </Row>
    </RowGroup>
</template>
