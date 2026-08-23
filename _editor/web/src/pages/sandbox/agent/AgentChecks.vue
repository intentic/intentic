<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useDraft } from "../../../composables/useDraft";
import { NAMED_RULES } from "../../../composables/sandbox/rules";
import { useRules } from "../../../composables/sandbox/useRules";

/* WHAT PROVES THE WORK. Two checks with nothing in common but that question: one the daemon asks of a turn that
 * edited code and proved nothing, and one the workspace runs at the last moment before code leaves the machine.
 *
 * BOTH ARE RULES (composables/sandbox/useRules.ts), written by these two rows rather than by the general add
 * flow below them. The rows stay because they are the two people ask for by name, and a switch reads better
 * than a form, but there is nothing behind them the table cannot express, which is why outgrowing either one
 * (a second command before a push, a check that only applies to one repo) needs no new setting.
 *
 * WHICH MODEL the failed check's suggested fix opens on is NOT here: it is `agentRunModels`, up in the Models
 * group, because that session is an agent run like the Fix button on a red pipeline and a Maintenance chore. */

const { settings, byId, upsert, remove, setEnabled } = useRules();

const verify = () => byId(NAMED_RULES.verify);
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
