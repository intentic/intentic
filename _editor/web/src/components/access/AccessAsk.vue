<!-- The one press every access refusal offers: ask the owner for what stood in the way. Once asked it becomes a fact, as
     Request land does, and a refusal no grant can lift (an organisation's lock, the owner's own tier) draws nothing. -->
<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { AccessReason } from "../../client/sandbox/access/accessReason";
import { useAccessRequest, wantOf } from "../../client/sandbox/access/accessRequest";

const {
    reason,
    place,
    tier = `boring`,
    small = false,
} = defineProps<{
    reason: AccessReason;
    /** Where the person is, as its page or section is titled, so the owner knows what the request is for. */
    place: string;
    /** `accent` where asking is the one way forward (a gate); `boring` beside what the person can still do. */
    tier?: `accent` | `boring`;
    small?: boolean;
}>();

const { asked, asking, failure, ask } = useAccessRequest();
const askable = computed(() => wantOf(reason) !== undefined);
</script>

<template>
    <template v-if="askable">
        <span v-if="asked" class="inline-flex shrink-0 items-center gap-1 text-2xs text-muted">
            <Icon name="clock" class="text-2xs" />{{ t(`common.access.asked`) }}
        </span>
        <Button v-else :tier="tier" :size="small ? `small` : undefined" class="shrink-0 whitespace-nowrap" :disabled="asking" @click="ask(reason, place)">
            <Icon :name="asking ? `spinner` : `send`" :spin="asking" />{{ t(`common.access.ask`) }}
        </Button>
        <span v-if="failure !== undefined" role="alert" class="text-2xs text-danger">{{ failure }}</span>
    </template>
</template>
