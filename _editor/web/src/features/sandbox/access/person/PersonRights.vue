<script setup lang="ts">
import type { AgentAccess, ManageRight } from "@intentic/sandbox-contract/schemas/members";
import { Section } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, useId } from "vue";
import { rightsFor, rightsOffered } from "../accessGrant";

// WHAT ELSE A PERSON WITH CUSTOM ACCESS MAY RUN, one part of the sandbox at a time, so the owner can hand over who gets
// in, the secrets or the privacy shield without handing over the whole box (Full access holds every one). A switch row
// each, drawn as the panel's sign-in switch is: what it is, and in a line what it lets them do. AI accounts of their own
// are offered only to someone whose agents run; a person who only chats or works through their home conversation is
// offered none (`rightsOffered`). A right the person editing does not hold themselves stays a switch they cannot move,
// since People & access hands out only what its holder has.

const t = useT();

const { agents, manages, grantable } = defineProps<{
    agents: AgentAccess;
    manages: readonly ManageRight[] | undefined;
    // The rights the person editing may switch here; the owner and Full access may switch every one.
    grantable: ReadonlySet<ManageRight>;
}>();
const emit = defineEmits<{ change: [manages: ManageRight[]] }>();

const WORDS = {
    people: () => ({ label: t(`sandbox.sandboxAccess.rightPeople`), note: t(`sandbox.sandboxAccess.rightPeopleNote`) }),
    secrets: () => ({ label: t(`sandbox.sandboxAccess.rightSecrets`), note: t(`sandbox.sandboxAccess.rightSecretsNote`) }),
    privacy: () => ({ label: t(`sandbox.sandboxAccess.rightPrivacy`), note: t(`sandbox.sandboxAccess.rightPrivacyNote`) }),
    ownAccounts: () => ({ label: t(`sandbox.sandboxAccess.rightOwnAccounts`), note: t(`sandbox.sandboxAccess.rightOwnAccountsNote`) }),
} satisfies Record<ManageRight, () => { label: string; note: string }>;

const id = useId();
const rows = computed(() => rightsOffered(agents).map((right) => ({ right, id: `${id}-${right}`, on: manages?.includes(right) === true, ...WORDS[right]() })));
// Said only where some switches move and some do not: a panel that is read-only whole says why on its own.
const someHeldBack = computed(() => rows.value.some((row) => !grantable.has(row.right)) && rows.value.some((row) => grantable.has(row.right)));

const flip = (right: ManageRight, on: boolean): void => {
    const others = (manages ?? []).filter((held) => held !== right);
    emit(`change`, rightsFor(agents, on ? [...others, right] : others));
};
</script>

<template>
    <Section v-if="rows.length > 0" :label="t(`sandbox.sandboxAccess.rightsSection`)">
        <div class="-mx-1 flex flex-col">
            <div v-for="row in rows" :key="row.right" class="flex items-center gap-3 px-1 py-1.5">
                <label :for="row.id" class="flex min-w-0 flex-1 flex-col" :class="grantable.has(row.right) ? `cursor-pointer` : `cursor-default`">
                    <span class="text-sm" :class="grantable.has(row.right) ? `text-content` : `text-muted`">{{ row.label }}</span>
                    <span class="text-xs text-muted">{{ row.note }}</span>
                </label>
                <ToggleSwitch
                    :input-id="row.id"
                    :model-value="row.on"
                    :disabled="!grantable.has(row.right)"
                    class="ui-switch-sm shrink-0"
                    @update:model-value="(on: boolean) => flip(row.right, on)"
                />
            </div>
            <p v-if="someHeldBack" class="px-1 pt-1 text-xs text-muted">{{ t(`sandbox.sandboxAccess.rightsYoursOnly`) }}</p>
        </div>
    </Section>
</template>
