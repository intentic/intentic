<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";

/* WHAT A PERMISSION CARD SHOWS YOU BEFORE YOU ANSWER FOR IT.
 *
 * The rulebook that decides WHICH commands stop (settings.commandRules) is a different question and is set
 * elsewhere; this group is only about the moment after one has stopped, when a person is looking at it and
 * deciding. That moment is the one the product had least to say about: the card carried the command as a wall
 * of unhighlighted shell, and the answer to "which part of this is the part that stopped it" was somewhere in
 * the middle of it.
 *
 * Most of the fix needed no setting — the card colours the command now, and marks the fragment the classifier
 * fired on, on every card, for free. What is switchable is the part that costs something: a model call. */

const { settings, patch } = useSandboxSettings();
</script>

<template>
    <RowGroup label="Held commands">
        <!-- OFF BY DEFAULT, and the description says the price rather than burying it: this spends one
             quick-model call per card raised, on the owner's own connected account, at the moment they are
             waiting to answer. That is a real cost and it is theirs to accept.
             The card is never held back for it (the sentence arrives on its own frame and simply appears when
             it lands), and the command is never replaced by it — only folded one labelled click away, with the
             marked fragments still on the card. -->
        <Row
            icon="comments"
            title="Explain held commands"
            description="Describe each held command in one plain sentence, above the command itself."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.explainCommands ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ explainCommands: value })"
                />
            </template>
            <!-- The two facts that decide whether to switch it on, and neither is guessable from the row: what
                 it spends, and who writes the words. The second is the one worth stating out loud — a sentence
                 written by the agent being gated would be a safety prompt arguing for its own approval. -->
            <template #below>
                <p class="text-2xs text-subtle">
                    Costs one quick-model call per card, on your own connected account. Written from the command text by the quick model, never by the
                    agent asking. The command itself is always one click away.
                </p>
            </template>
        </Row>
    </RowGroup>
</template>
