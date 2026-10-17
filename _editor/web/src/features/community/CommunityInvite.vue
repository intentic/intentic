<!-- The community invitation, said once (communityInvite.ts says when). `note` is the account menu's and a phone Menu's:
     a title, a line, Join and No thanks (for good: the plain row stays for later). `inline` is the finished checklist's:
     one line and Join, since the panel's own Done already puts it away. Never a dialog and never on a timer: it sits
     where the reader already looked. -->
<script setup lang="ts">
import { Button, Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { onMounted } from "vue";
import type { InviteAnswer, InvitePlace } from "./communityInvite";
import { useCommunityInvite } from "./useCommunityInvite";

const { place, look = `note` } = defineProps<{ place: InvitePlace; look?: `note` | `inline` }>();
const emit = defineEmits<{ answered: [answer: InviteAnswer] }>();

const t = useT();
const invite = useCommunityInvite();

onMounted(() => invite.seen(place));

// Recorded a tick later: the answer takes this card off the page, and Join's link has to be followed first.
const answer = (given: InviteAnswer): void => {
    setTimeout(() => {
        invite.answer(place, given);
        emit(`answered`, given);
    }, 0);
};
</script>

<template>
    <div class="flex flex-col gap-2 rounded-lg border border-line-subtle bg-content/[0.03] p-2.5" data-test="community-invite">
        <div v-if="look === 'note'" class="flex items-center gap-2">
            <Icon name="discord" class="shrink-0 text-base text-accent" />
            <p class="text-xs font-semibold text-content">{{ t(`community.note.title`) }}</p>
        </div>
        <p class="text-2xs leading-relaxed text-muted">{{ look === 'note' ? t(`community.note.line`) : t(`community.finishedLine`) }}</p>
        <div class="flex items-center gap-3">
            <Button as="a" :href="invite.url" target="_blank" rel="noopener" size="small" tier="boring" data-test="community-join" @click="answer(`joined`)">
                <Icon v-if="look === 'inline'" name="discord" class="mr-1.5 text-xs" />{{ t(`community.join`) }}
            </Button>
            <button v-if="look === 'note'" type="button" :class="ui.textButton({ tone: 'quiet', size: 'xs' })" data-test="community-no-thanks" @click="answer(`declined`)">
                {{ t(`community.noThanks`) }}
            </button>
        </div>
    </div>
</template>
