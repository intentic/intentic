<script setup lang="ts">
import { ServiceSchema, type Service } from "@intentic/sandbox-contract/schemas/services";
import { Await, Button, Icon, Notice, Picker, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useMembers } from "../../../../client/sandbox/useMembers";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { useServices } from "./useServices";
import { useAccessProfiles } from "./useAccessProfiles";
const t = useT();
const { available, loaded, services, save, remove } = useServices();
const { available: profilesAvailable, profiles } = useAccessProfiles();
const { owner, members } = useMembers({ enabled: available });
const stewards = computed(() =>
    [...new Set([owner.value, ...members.value.map((member) => member.email)].filter((email): email is string => typeof email === `string`))].map(
        (email) => ({ value: email, label: email }),
    ),
);
const profileOptions = computed(() => [
    { value: ``, label: t(`sandbox.accessServices.stewardReach`) },
    ...profiles.value.map((profile) => ({ value: profile.id, label: profile.label ?? profile.id })),
]);
const draft = ref<Service>();
const existing = ref(false);
const notice = ref<ReturnType<typeof noticeFrom>>();
const valid = computed(
    () =>
        draft.value !== undefined &&
        ServiceSchema.safeParse(draft.value).success &&
        (existing.value || !services.value.some((service) => service.id === draft.value?.id)),
);
const busy = computed(() => save.isPending.value || remove.isPending.value);
const start = (service?: Service): void => {
    existing.value = service !== undefined;
    draft.value = service === undefined ? { id: ``, steward: owner.value ?? `` } : { ...service };
    notice.value = undefined;
};
const submit = async (): Promise<void> => {
    if (busy.value || draft.value === undefined || !valid.value) {
        return;
    }
    notice.value = undefined;
    try {
        await save.mutateAsync(draft.value);
        draft.value = undefined;
    } catch (error) {
        notice.value = noticeFrom(error, t(`sandbox.accessServices.saveFailed`));
    }
};
const destroy = async (id: string): Promise<void> => {
    if (busy.value) {
        return;
    }
    notice.value = undefined;
    try {
        await remove.mutateAsync(id);
    } catch (error) {
        notice.value = noticeFrom(error, t(`sandbox.accessServices.removeFailed`));
    }
};
const profileName = (id: string | undefined): string =>
    id === undefined ? t(`sandbox.accessServices.stewardReach`) : (profiles.value.find((profile) => profile.id === id)?.label ?? id);
</script>
<template>
    <Await v-if="available" :of="loaded" imprint="sandbox.access.services">
        <RowGroup :label="t(`sandbox.accessServices.title`)">
            <template #actions
                ><Button
                    v-if="supportsRoute(`services.save`) && !draft"
                    :label="t(`sandbox.accessServices.add`)"
                    size="small"
                    tier="boring"
                    @click="start()"
                    ><template #icon><Icon name="plus" /></template></Button
            ></template>
            <RowNote variant="block">{{ t(`sandbox.accessServices.explain`) }}</RowNote>
            <RowNote v-if="notice" variant="block"><Notice :of="notice" /></RowNote>
            <RowNote v-if="draft" variant="block">
                <form class="flex flex-col gap-3" @submit.prevent="submit">
                    <div class="flex flex-wrap items-center gap-2">
                        <strong class="mr-auto text-sm">{{ draft.label || draft.id || t(`sandbox.accessServices.add`) }}</strong
                        ><Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" :disabled="busy" @click="draft = undefined" /><Button
                            type="submit"
                            :label="t(`ui.action.save`)"
                            size="small"
                            :loading="busy"
                            :disabled="busy || !valid"
                        />
                    </div>
                    <label class="flex flex-col gap-1 text-sm"
                        >{{ t(`sandbox.accessProfiles.id`) }}<input v-model="draft.id" :disabled="existing" required :class="ui.input()"
                    /></label>
                    <label class="flex flex-col gap-1 text-sm"
                        >{{ t(`sandbox.accessProfiles.label`) }}<input v-model="draft.label" maxlength="60" :class="ui.input()"
                    /></label>
                    <label class="flex flex-col gap-1 text-sm"
                        >{{ t(`sandbox.accessProfiles.brief`) }}<input v-model="draft.brief" maxlength="200" :class="ui.input()"
                    /></label>
                    <Picker
                        v-model="draft.steward"
                        :options="stewards"
                        :aria-label="t(`sandbox.accessServices.steward`)"
                        :header="t(`sandbox.accessServices.steward`)"
                        variant="input"
                    />
                    <Picker
                        v-if="profilesAvailable"
                        :model-value="draft.profile ?? ``"
                        :options="profileOptions"
                        :aria-label="t(`sandbox.accessProfiles.title`)"
                        :header="t(`sandbox.accessProfiles.title`)"
                        variant="input"
                        @update:model-value="draft.profile = $event || undefined"
                    />
                </form>
            </RowNote>
            <Row
                v-for="service in services"
                :key="service.id"
                :title="service.label ?? service.id"
                :description="[service.brief, service.steward, profileName(service.profile)].filter(Boolean).join(` · `)"
            >
                <template #control
                    ><Button
                        v-if="supportsRoute(`services.save`)"
                        :label="t(`ui.action.edit`)"
                        size="small"
                        tier="quiet"
                        @click="start(service)" /><Button
                        v-if="supportsRoute(`services.remove`)"
                        :label="t(`ui.action.delete`)"
                        size="small"
                        tier="quiet"
                        tone="danger"
                        :disabled="busy"
                        @click="destroy(service.id)"
                /></template>
            </Row>
            <RowNote v-if="services.length === 0 && !draft" variant="empty">{{ t(`sandbox.accessServices.empty`) }}</RowNote>
        </RowGroup>
    </Await>
</template>
