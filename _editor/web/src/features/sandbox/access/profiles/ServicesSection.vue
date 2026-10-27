<script setup lang="ts">
import { ServiceSchema, type Service } from "@intentic/sandbox-contract/schemas/services";
import { Await, Button, Icon, InlineRename, Notice, Picker, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useMembers } from "../../../../client/sandbox/useMembers";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { idFromName } from "../../../../lib/idFromName";
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
// A new service, while it is being named; one that exists is changed where its row shows it, a value at a time.
const draft = ref<Service>();
const notice = ref<ReturnType<typeof noticeFrom>>();
// Named, never given an id, as a profile is: a new service's id (what `runAs` names) is folded from its name when it is
// saved and fixed from then on, so a rename never unhooks the automations that run as it.
const name = computed(() => draft.value?.label?.trim() ?? ``);
const candidate = computed<Service | undefined>(() => {
    if (draft.value === undefined) {
        return undefined;
    }
    const { brief: _brief, ...service } = draft.value;
    const id = idFromName(name.value, services.value.map((entry) => entry.id), `service`);
    return { ...service, id, label: name.value === `` ? undefined : name.value };
});
const takenBy = (label: string, id: string | undefined): boolean =>
    services.value.some((entry) => entry.id !== id && (entry.label ?? entry.id).toLowerCase() === label.toLowerCase());
const nameTaken = computed(() => name.value !== `` && takenBy(name.value, candidate.value?.id));
const valid = computed(() => candidate.value !== undefined && name.value !== `` && !nameTaken.value && ServiceSchema.safeParse(candidate.value).success);
const busy = computed(() => save.isPending.value || remove.isPending.value);
const start = (): void => {
    draft.value = { id: ``, steward: owner.value ?? `` };
    notice.value = undefined;
};
const editable = computed(() => supportsRoute(`services.save`));

// ONE VALUE OF A SERVICE, CHANGED WHERE ITS ROW SHOWS IT: the stored service with that one change, written whole, and a
// refusal said under that row rather than over the list.
const rowNotice = ref<{ readonly id: string; readonly notice: ReturnType<typeof noticeFrom> }>();
const change = async (service: Service, patch: Partial<Service>): Promise<void> => {
    rowNotice.value = undefined;
    const { brief: _brief, ...stored } = service;
    try {
        await save.mutateAsync({ ...stored, ...patch });
    } catch (error) {
        rowNotice.value = { id: service.id, notice: noticeFrom(error, t(`sandbox.accessServices.saveFailed`)) };
    }
};
// The name's own field reports a refusal (InlineRename): a taken name is refused before the round trip.
const rename = async (service: Service, label: string): Promise<void> => {
    if (takenBy(label, service.id)) {
        throw new Error(t(`sandbox.accessServices.nameTaken`, { name: label }));
    }
    const { brief: _brief, ...stored } = service;
    await save.mutateAsync({ ...stored, label });
};
const submit = async (): Promise<void> => {
    if (busy.value || candidate.value === undefined || !valid.value) {
        return;
    }
    notice.value = undefined;
    try {
        await save.mutateAsync(candidate.value);
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
                        <strong class="mr-auto text-sm">{{ t(`sandbox.accessServices.add`) }}</strong
                        ><Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" :disabled="busy" @click="draft = undefined" /><Button
                            tier="accent"
                            type="submit"
                            :label="t(`ui.action.save`)"
                            size="small"
                            :loading="busy"
                            :disabled="busy || !valid"
                        />
                    </div>
                    <label class="flex flex-col gap-1 text-sm"
                        >{{ t(`sandbox.accessProfiles.label`)
                        }}<input
                            v-model="draft.label"
                            required
                            maxlength="60"
                            :placeholder="t(`sandbox.accessServices.namePlaceholder`)"
                            :class="ui.input()"
                    /></label>
                    <p v-if="nameTaken" class="text-sm text-warning">{{ t(`sandbox.accessServices.nameTaken`, { name }) }}</p>
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
            <!-- Each value is changed where the row shows it: the name in place, who stewards it and what it may reach by picking. -->
            <Row v-for="service in services" :key="service.id">
                <template #title>
                    <InlineRename
                        :value="service.label ?? service.id"
                        :write="(label: string) => rename(service, label)"
                        :label="t(`sandbox.accessProfiles.label`)"
                        :action="t(`ui.action.rename`)"
                        :editable="editable"
                        :maxlength="60"
                        :failure="t(`sandbox.accessServices.saveFailed`)"
                    />
                </template>
                <template #description>
                    <span v-if="editable" class="flex min-w-0 flex-wrap items-center gap-x-1">
                        <Picker
                            :model-value="service.steward"
                            :options="stewards"
                            variant="ghost"
                            :aria-label="t(`sandbox.accessServices.steward`)"
                            :header="t(`sandbox.accessServices.steward`)"
                            :disabled="busy"
                            @update:model-value="(steward: string | undefined) => steward !== undefined && change(service, { steward })"
                        />
                        <span aria-hidden="true">·</span>
                        <Picker
                            v-if="profilesAvailable"
                            :model-value="service.profile ?? ``"
                            :options="profileOptions"
                            variant="ghost"
                            :aria-label="t(`sandbox.accessProfiles.title`)"
                            :header="t(`sandbox.accessProfiles.title`)"
                            :disabled="busy"
                            @update:model-value="(profile: string | undefined) => change(service, { profile: profile || undefined })"
                        />
                        <span v-else>{{ profileName(service.profile) }}</span>
                    </span>
                    <template v-else>{{ [service.steward, profileName(service.profile)].join(` · `) }}</template>
                </template>
                <template #control
                    ><Button
                        v-if="supportsRoute(`services.remove`)"
                        :label="t(`ui.action.delete`)"
                        size="small"
                        tier="quiet"
                        tone="danger"
                        :disabled="busy"
                        @click="destroy(service.id)"
                /></template>
                <template v-if="rowNotice?.id === service.id" #below><Notice :of="rowNotice.notice" /></template>
            </Row>
            <RowNote v-if="services.length === 0 && !draft" variant="empty">{{ t(`sandbox.accessServices.empty`) }}</RowNote>
        </RowGroup>
    </Await>
</template>
