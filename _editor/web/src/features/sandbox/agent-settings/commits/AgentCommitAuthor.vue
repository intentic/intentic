<script setup lang="ts">
import { type CommitAttribution, type GitPerson, GitPersonSchema } from "@intentic/sandbox-contract/schemas/settings";
import { Button, Notice, Row, RowGroup, RowNote, SegmentedControl, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import { useCommitIdentity } from "../../../../models/sandbox/useCommitIdentity";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";

// Whose name the commits made here carry, and the reader's own name and address for them. The choice is the sandbox's
// (settings.commitAttribution); the name and address are each person's own (settings.commitIdentity), typed here or
// taken from a suggestion with a press, never their sign-in address, since a pushed commit publishes it for good.

const t = useT();

const { settings, patch, refusal } = useSandboxSettings();
const { supported, state, setIdentity, saving, refusal: identityRefusal } = useCommitIdentity();
// Two saves write this group, the sandbox's choice and the reader's own; either one refused is said once, under the group.
const groupRefusal = computed(() => refusal.value ?? identityRefusal.value);

const ATTRIBUTION_OPTIONS = computed((): { label: string; value: CommitAttribution }[] => [
    { label: t(`sandbox.agentCommitAuthor.asAuthor`), value: `person` },
    { label: t(`sandbox.agentCommitAuthor.asCoAuthor`), value: `trailer` },
    { label: t(`sandbox.agentCommitAuthor.nobody`), value: `intentic` },
]);

// The fields start from what is kept, and again whenever that changes (a save, a forget). A suggestion is never typed
// into them: it is saved only by the press that names it, so nothing the reader did not choose reaches history.
const kept = computed(() => state.value?.identity);
const name = ref(``);
const email = ref(``);
watch(
    kept,
    (person) => {
        name.value = person?.name ?? ``;
        email.value = person?.email ?? ``;
    },
    { immediate: true },
);

// Sent as the daemon keeps it, trimmed, and only when it differs from what is kept and the contract's own rule takes it,
// so Save is never a write bound to be refused.
const typed = computed((): GitPerson => ({ name: name.value.trim(), email: email.value.trim() }));
const savable = computed(
    () => GitPersonSchema.safeParse(typed.value).success && (typed.value.name !== kept.value?.name || typed.value.email !== kept.value?.email),
);
const save = (): void => {
    if (savable.value && !saving.value) {
        setIdentity(typed.value);
    }
};
const suggested = computed(() => (kept.value === undefined ? state.value?.suggested : undefined));
</script>

<template>
    <RowGroup data-setting="agent-commit-author" :label="t(`sandbox.agentCommitAuthor.group`)">
        <Row icon="users" :title="t(`sandbox.agentCommitAuthor.attribution`)" :description="t(`sandbox.agentCommitAuthor.attributionNote`)">
            <template #control>
                <SegmentedControl
                    :model-value="settings?.commitAttribution ?? `trailer`"
                    :options="ATTRIBUTION_OPTIONS"
                    @update:model-value="(attribution: CommitAttribution) => patch({ commitAttribution: attribution })"
                />
            </template>
        </Row>

        <!-- Each person's own, through routes an older daemon lacks: there nothing would keep it, so it is not offered. -->
        <template v-if="supported">
            <Row icon="user" :title="t(`sandbox.agentCommitAuthor.yours`)" :description="t(`sandbox.agentCommitAuthor.yoursNote`)">
                <template #below>
                    <form class="flex flex-wrap items-center gap-2 pt-1" @submit.prevent="save">
                        <input
                            v-model="name"
                            type="text"
                            autocomplete="name"
                            spellcheck="false"
                            maxlength="120"
                            :aria-label="t(`sandbox.agentCommitAuthor.name`)"
                            :placeholder="t(`sandbox.agentCommitAuthor.name`)"
                            :class="ui.input({ size: `sm` }, `min-w-40 flex-1`)"
                            :disabled="state === undefined"
                        />
                        <input
                            v-model="email"
                            type="email"
                            autocomplete="email"
                            spellcheck="false"
                            maxlength="254"
                            :aria-label="t(`sandbox.agentCommitAuthor.email`)"
                            :placeholder="t(`sandbox.agentCommitAuthor.email`)"
                            :class="ui.input({ size: `sm` }, `min-w-48 flex-1`)"
                            :disabled="state === undefined"
                        />
                        <Button
                            v-if="kept !== undefined"
                            :label="t(`sandbox.agentCommitAuthor.forget`)"
                            size="small"
                            tier="quiet"
                            :disabled="saving"
                            @click="setIdentity(null)"
                        />
                        <Button
                            tier="accent"
                            type="submit"
                            :label="t(`ui.action.save`)"
                            size="small"
                            :loading="saving"
                            :disabled="!savable || saving"
                        />
                    </form>
                </template>
            </Row>
            <!-- The owner's connected git account, offered while they have set nothing; its noreply address where the account keeps its own private. -->
            <RowNote v-if="suggested !== undefined" variant="block">
                <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span>{{ t(`sandbox.agentCommitAuthor.suggested`, { name: suggested.name, email: suggested.email }) }}</span>
                    <Button
                        :label="t(`sandbox.agentCommitAuthor.useSuggested`)"
                        size="small"
                        tier="boring"
                        :disabled="saving"
                        @click="setIdentity(suggested)"
                    />
                </div>
            </RowNote>
        </template>
        <RowNote v-if="groupRefusal !== undefined" variant="block"><Notice :of="groupRefusal" /></RowNote>
    </RowGroup>
</template>
