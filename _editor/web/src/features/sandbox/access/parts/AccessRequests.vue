<!-- What people on the roster have asked for, from where they were refused, above the people themselves: Review
     opens the person's panel, where granting them anything answers the request; Dismiss answers it without a grant. -->
<script setup lang="ts">
import type { AccessRequest, AccessWant } from "@intentic/sandbox-contract/schemas/members";
import { Button, Row, RowGroup, timeAgo } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { ref } from "vue";
import { useAccessRequests } from "../../../../client/sandbox/access/accessRequest";

const emit = defineEmits<{
    /** Open this person's panel, to grant what they asked for. */
    review: [email: string];
}>();

const { requests, dismiss } = useAccessRequests(true);
const dismissing = ref<string>();

// What they asked for, in the words a grant is chosen in.
const WANTS = {
    viewer: () => t(`sandbox.accessRequests.wants.viewer`),
    collaborator: () => t(`sandbox.accessRequests.wants.collaborator`),
    writer: () => t(`sandbox.accessRequests.wants.writer`),
    maintainer: () => t(`sandbox.accessRequests.wants.maintainer`),
    agents: () => t(`sandbox.accessRequests.wants.agents`),
    areas: () => t(`sandbox.accessRequests.wants.areas`),
    aiAccounts: () => t(`sandbox.accessRequests.wants.aiAccounts`),
} satisfies Record<AccessWant, () => string>;

const lineOf = (request: AccessRequest): string => `${WANTS[request.want]()} · ${t(`sandbox.accessRequests.from`, { place: request.place })} · ${timeAgo(request.at)}`;

const dismissOne = async (email: string): Promise<void> => {
    dismissing.value = email;
    try {
        await dismiss(email);
    } finally {
        dismissing.value = undefined;
    }
};
</script>

<template>
    <RowGroup v-if="requests.length > 0" :label="t(`sandbox.accessRequests.title`)">
        <Row v-for="request in requests" :key="request.email" icon="user" :description="lineOf(request)" indent>
            <template #title>
                <span class="break-all">{{ request.email }}</span>
            </template>
            <template #control>
                <Button size="small" tier="quiet" :label="t(`sandbox.accessRequests.review`)" @click="emit(`review`, request.email)" />
                <Button
                    size="small"
                    tier="quiet"
                    :label="t(`ui.action.dismiss`)"
                    :disabled="dismissing === request.email"
                    @click="dismissOne(request.email)"
                />
            </template>
        </Row>
    </RowGroup>
</template>
