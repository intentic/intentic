<script setup lang="ts">
import type { OrgDetail, OrgSummary } from "@intentic/api-contract";
import { Button, Notice, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { type NoticeModel, noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { onMounted, ref, shallowRef } from "vue";
import { apiClient } from "../../lib/useApi";
import OrgDetailPanel from "./OrgDetailPanel.vue";

// Settings ▸ Organisation (docs/architecture/organisations.md): the organisations this account is in, starting one
// where the platform allows it, and the one picked. Account-level, so it talks to the platform, never a daemon; what
// a policy does to a sandbox the daemon enforces, and the hub draws from the daemon's copy (useOrgPolicy.ts).

const t = useT();

const orgs = ref<readonly OrgSummary[]>([]);
const canCreate = ref(false);
const loaded = ref(false);
const picked = shallowRef<OrgDetail>();
const notice = shallowRef<NoticeModel>();
const name = ref(``);
const busy = ref(false);

const load = async (): Promise<void> => {
    try {
        const answer = await apiClient.org.list();
        orgs.value = answer.orgs;
        canCreate.value = answer.canCreate;
    } catch (error) {
        notice.value = noticeFrom(error, t(`organisations.console.couldntLoad`));
    } finally {
        loaded.value = true;
    }
};

const open = async (orgId: string): Promise<void> => {
    try {
        picked.value = await apiClient.org.get({ orgId });
        notice.value = undefined;
    } catch (error) {
        notice.value = noticeFrom(error, t(`organisations.console.couldntLoad`));
    }
};

const create = async (): Promise<void> => {
    if (busy.value || name.value.trim().length < 2) {
        return;
    }
    busy.value = true;
    try {
        picked.value = await apiClient.org.create({ name: name.value.trim() });
        name.value = ``;
        await load();
    } catch (error) {
        notice.value = noticeFrom(error, t(`organisations.console.couldntCreate`));
    } finally {
        busy.value = false;
    }
};

// The panel answers every change with the organisation as it now stands; the list's counts follow.
const changed = async (detail: OrgDetail): Promise<void> => {
    picked.value = detail;
    await load();
};

onMounted(load);
</script>

<template>
    <div class="flex flex-col gap-6">
        <Notice v-if="notice" :of="notice" />
        <RowGroup :label="t(`organisations.console.yours`)">
            <Row
                v-for="org in orgs"
                :key="org.id"
                as="button"
                icon="users"
                :title="org.name"
                :description="t(`organisations.console.summary`, { role: t(`organisations.role.${org.role}`), count: org.sandboxCount }, org.sandboxCount)"
                :selected="picked?.id === org.id"
                @click="open(org.id)"
            />
            <RowNote v-if="loaded && orgs.length === 0">{{ t(`organisations.console.none`) }}</RowNote>
            <RowNote v-if="canCreate" variant="block">
                <form class="flex flex-wrap items-center gap-2" @submit.prevent="create">
                    <input
                        v-model="name"
                        type="text"
                        autocomplete="organization"
                        :placeholder="t(`organisations.console.namePlaceholder`)"
                        :aria-label="t(`organisations.console.namePlaceholder`)"
                        :class="ui.input({ size: `sm` }, `min-w-48 flex-1`)"
                    />
                    <Button type="submit" :label="t(`organisations.console.create`)" size="small" :loading="busy" :disabled="busy" />
                </form>
            </RowNote>
        </RowGroup>
        <OrgDetailPanel v-if="picked" :key="picked.id" :org="picked" @changed="changed" />
    </div>
</template>
