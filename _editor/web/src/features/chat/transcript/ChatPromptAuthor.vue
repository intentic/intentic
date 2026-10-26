<script setup lang="ts">
import { Avatar } from "@intentic/ui";
import { computed } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import { identityHue } from "../../../lib/identityHue";
import { usePaneView } from "../../../models/conversations/panel/useChat-view";
import { promptAuthorOf } from "../../../models/conversations/transcript/promptAuthor";
import type { ChatMessage } from "../../../models/conversations/transcript/transcript";
import { presenceOthers } from "../../../workbench/presence/usePresence";

// Whose prompt this is, on the bubble's outer edge, drawn only once several people have typed into this chat
// (promptAuthor.ts): in a chat of one, every prompt is the same person's and a face says nothing. The picture is the
// signed-in person's own, or another member's while they are connected (presence); anyone else wears their initials in
// their own hue, which is theirs on every surface. Top-aligned, so a tall prompt keeps its face at its first line.

const { message } = defineProps<{ message: ChatMessage }>();

const { self, severalPeople } = usePaneView();
const { user } = useAuth();

const face = computed(() => {
    const person = severalPeople.value ? promptAuthorOf(message, self.value) : undefined;
    if (person === undefined) {
        return undefined;
    }
    const email = person.email.toLowerCase();
    const picture =
        email === self.value?.email.toLowerCase()
            ? (user.value?.image ?? undefined)
            : presenceOthers.value.find((member) => member.email.toLowerCase() === email)?.picture;
    const name = person.name ?? person.email;
    return { name, picture, hue: identityHue(email), tip: person.name === undefined ? name : { title: name, note: person.email } };
});
</script>

<template>
    <Avatar v-if="face" :size="20" :name="face.name" :src="face.picture" :hue="face.hue" class="ml-1 shrink-0 self-start" v-tooltip.top="face.tip" />
</template>
