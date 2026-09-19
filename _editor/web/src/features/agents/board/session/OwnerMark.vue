<script setup lang="ts">
import { computed } from "vue";
import type { SessionOwner } from "@intentic/sandbox-contract";
import { Avatar } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { RouterLink } from "vue-router";
import { useAuth } from "../../../auth/useAuth";
import { presenceOthers } from "../../../../shell/presence/usePresence";
import { identityHue } from "../../../../lib/identityHue";
import { ownerLook, starterLook } from "../ownership";

/* Whose conversation this is: its owner as a person (avatar and name, "you" for the reader's own); for one nobody owns, the program that started it (a control token's label) or the conversation that spawned it (a link to the parent). A wake nobody claimed draws nothing here; OriginMark names its automation. */

const props = defineProps<{ owner?: SessionOwner; startedBy?: string }>();

const t = useT();
const { user } = useAuth();

const person = computed(() => (props.owner === undefined ? undefined : ownerLook(props.owner, user.value?.email, presenceOthers.value)));
// The reader's own picture comes from their sign-in, which presence does not list them under.
const picture = computed(() => (person.value?.mine === true ? (user.value?.image ?? undefined) : person.value?.picture));
const starter = computed(() => (props.owner === undefined ? starterLook(props.startedBy) : undefined));
</script>

<template>
    <span
        v-if="person !== undefined"
        class="flex min-w-0 items-center gap-1.5 text-2xs text-muted"
        :aria-label="t(`agents.ownerMark.ownedBy`, { name: person.name })"
        v-tooltip.top="t(`agents.ownerMark.ownedBy`, { name: person.mine ? `${person.name} (${t(`agents.ownerMark.you`)})` : person.name })"
    >
        <Avatar :size="14" :name="person.name" :src="picture" :hue="identityHue(person.email)" />
        <span class="truncate font-medium">{{ person.mine ? t(`agents.ownerMark.you`) : person.name }}</span>
    </span>
    <span
        v-else-if="starter?.kind === `token`"
        class="flex min-w-0 items-center gap-1.5 text-2xs text-muted"
        :aria-label="t(`agents.ownerMark.startedByControlToken`, { tokenLabel: starter.label })"
        v-tooltip.top="t(`agents.ownerMark.startedByProgramHolding`, { tokenLabel: starter.label })"
    >
        <Icon name="key" class="shrink-0 text-2xs" />
        <span class="shrink-0 font-medium">{{ t(`agents.ownerMark.token`) }}</span>
        <span>·</span>
        <span class="truncate">{{ starter.label }}</span>
    </span>
    <RouterLink
        v-else-if="starter?.kind === `child`"
        :to="{ name: `agent`, params: { id: starter.parent } }"
        class="flex min-w-0 items-center gap-1.5 text-2xs text-muted hover:text-content"
        :aria-label="t(`agents.ownerMark.spawnedBy`, { parent: starter.parent })"
        v-tooltip.top="t(`agents.ownerMark.spawnedBy`, { parent: starter.parent })"
        @click.stop
    >
        <Icon name="sitemap" class="shrink-0 text-2xs" />
        <span class="shrink-0 font-medium">{{ t(`agents.ownerMark.child`) }}</span>
        <span>·</span>
        <span class="truncate">{{ starter.parent }}</span>
    </RouterLink>
</template>
