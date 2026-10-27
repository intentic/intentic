<!-- Who answered a card, as a face and a name, and only when it was somebody else: on a sandbox one person drives, "by
     you" under every card is a line saying nothing, while in a shared one the face is how a reader spots a teammate's
     answer at a glance. -->
<script setup lang="ts">
import { Avatar } from "@intentic/ui";
import { computed } from "vue";
import { identityHue } from "../../lib/identityHue";
import { useSomeoneElse } from "./cardPerson";

const { who } = defineProps<{ who: string | undefined }>();

const someoneElse = useSomeoneElse();
const shown = computed(() => (someoneElse(who) ? who : undefined));
</script>

<template>
    <span v-if="shown" class="inline-flex min-w-0 items-center gap-1.5 text-content/85" data-card-person>
        <Avatar :size="14" :name="shown" :hue="identityHue(shown)" />
        <span class="truncate">{{ shown }}</span>
    </span>
</template>
