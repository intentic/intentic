<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useDraft } from "../../../composables/useDraft";
import { NAMED_RULES } from "../../../composables/sandbox/rules";
import { useRules } from "../../../composables/sandbox/useRules";

/* WHAT PROVES THE WORK. Three checks with nothing in common but that question: two the daemon asks of a turn
 * that is trying to finish, and one the workspace runs at the last moment before code leaves the machine.
 *
 * THE TWO DAEMON CHECKS READ OPPOSITE HALVES OF THE SAME TURN, which is why they are two switches and not one.
 * "Verify before finishing" weighs what was WRITTEN against what was run; a deletion satisfies it trivially and
 * always will. "Check what it deleted" weighs what was REMOVED against what the repository's history says about
 * those lines, and it is the only thing here that can speak about a change which type-checks, keeps the suite
 * green, and reads in review as the diff getting shorter.
 *
 * ALL THREE ARE RULES (composables/sandbox/useRules.ts), written by these rows rather than by the general add
 * flow below them. The rows stay because they are the ones people ask for by name, and a switch reads better
 * than a form, but there is nothing behind them the table cannot express, which is why outgrowing any of them
 * (a second command before a push, a check that only applies to one repo) needs no new setting.
 *
 * WHICH MODEL the failed check's suggested fix opens on is NOT here: it is `agentRunModels`, up in the Models
 * group, because that session is an agent run like the Fix button on a red pipeline and a Maintenance chore. */

const { settings, byId, upsert, remove, setEnabled } = useRules();

const verify = () => byId(NAMED_RULES.verify);
const removals = () => byId(NAMED_RULES.removals);
const viewing = () => byId(NAMED_RULES.viewing);
const prepush = () => byId(NAMED_RULES.prepush);

// The proof ledger is a built-in action: what it does, read what the turn edited against what the turn ran:
// is not a command and never will be, so the rule names it rather than describing it.
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

// The deletion check is a built-in for the same reason: what it does, weigh the lines a turn deleted against
// what `git log` says about them, is not a command an owner could type, and the record it reads exists only
// while the turn is running.
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

// Looking at what was drawn is a built-in for the third time and the clearest case of the three: the record it
// reads, which rendered surfaces this turn changed and whether any browser call observed one afterwards, exists
// only while the turn is running and is not a question any command can be pointed at.
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

/* --- The pre-push check -------------------------------------------------------------------------------------
 * The command the workspace runs when a push is about to go out. It belongs on this tab and not in personal
 * Settings for the same reason the quick model does: it names something that only exists inside this sandbox:
 * a command that has to run in THIS workspace's toolchain.
 *
 * Empty is the default and it means OFF, which is why there is no separate enable switch to disagree with it:
 * only the owner knows what verifies their workspace, and a guessed `pnpm test` would read as the check finding
 * a bug on its first run. Emptying the box DELETES the rule rather than leaving a disabled one behind, so the
 * list below never fills up with blanks nobody wrote on purpose.
 *
 * Committed on change rather than per keystroke: every save is a daemon round-trip, and a half-typed command
 * is a command. */
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
        // The ceiling comes from the schema's own default rather than being restated here: one number, and the
        // place it is explained is the place it is defined.
        action: { kind: `command`, command, timeoutMs: existing?.action.kind === `command` ? existing.action.timeoutMs : 900_000 },
        enabled: true,
    });
};
</script>

<template>
    <RowGroup label="Checks">
        <!-- Verify before finishing: the daemon keeps a per-turn ledger of edited code against the checks
             that ran, and asks once when a turn tries to end with neither. Off by default because only the
             owner knows what verifies their workspace: a repo with failing baseline tests would get an ask
             it cannot satisfy, and the ask costs a whole model turn. -->
        <Row
            icon="shield"
            title="Verify before finishing"
            description="Prompt the assistant to run a check after code changes."
        >
            <template #control>
                <ToggleSwitch :model-value="verify()?.enabled ?? false" :disabled="settings === undefined" @update:model-value="setVerify" />
            </template>
        </Row>

        <!-- Check what it deleted: before a turn ends, the lines it removed are weighed against what the
             repository's history says about them, and it asks once when something it deleted has been deleted
             before, was introduced by a fix, or has stood untouched for months. Off by default like its
             neighbour, and quiet by construction: a turn that removed ordinary code spawns nothing. -->
        <Row
            icon="shield"
            title="Check what it deleted"
            description="Ask about removed code the project's history defends."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="removals()?.enabled ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="setRemovals"
                />
            </template>
        </Row>

        <!-- Look at what it changed: a suite cannot see a clipped label or a border cut at a corner, so a turn
             that edited a rendered surface and never opened a browser afterwards gets asked to. It asks for a
             stated expectation before the observation on purpose: the turns that got sent back for how they
             looked had ALREADY screenshotted more often than the ones that were accepted, so a glance is not
             the scarce thing. Off by default like its neighbours, and silent on any turn that touched no
             surface. -->
        <Row
            icon="eye"
            title="Look at what it changed"
            description="Prompt the assistant to open the view after changes to the interface."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="viewing()?.enabled ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="setViewing"
                />
            </template>
        </Row>

        <!-- The pre-push check, the shift-left of the CI round-trip: the same question CI asks, asked of the
             same artifact, at the last moment before it leaves the machine and while the user is still standing
             there. The command gets the row's full width rather than a 14rem control slot: it is a shell line,
             it is read left-to-right, and truncating `pnpm -w turbo run test --filter=…` at the tenth character
             made a configured check indistinguishable from a mistyped one. -->
        <Row
            icon="shield"
            title="Check before you push"
            description="Run a check before pushing code."
        >
            <template #below>
                <div
                    class="flex items-center gap-2 rounded-lg border border-line bg-canvas px-2.5 py-1.5 focus-within:border-line-strong"
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
                        class="min-w-0 flex-1 bg-transparent font-mono text-xs text-content placeholder:text-subtle focus:outline-none"
                        @change="savePrepush"
                    />
                </div>
            </template>
        </Row>
    </RowGroup>
</template>
