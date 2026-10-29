<script setup lang="ts">
import { AccessProfileSchema, profileAccess, type AccessProfile, type AccessProfileEntry } from "@intentic/sandbox-contract/schemas/access-profiles";
import { tierOf } from "@intentic/sandbox-contract/schemas/members";
import { Await, Button, Icon, Notice, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { selfMember, useMembers } from "../../../../client/sandbox/useMembers";
import { useAccess } from "../../../../client/sandbox/access/useAccess";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { idFromName } from "../../../../lib/idFromName";
import { draftProblem } from "../accessGrant";
import { usePersonaReach } from "../usePersonaReach";
import { useAccessProfiles } from "../profiles/useAccessProfiles";
import { useServices } from "../profiles/useServices";
import ProfileAnswers from "../profiles/ProfileAnswers.vue";
const t = useT();
// Whoever runs people and access writes the sandbox's profiles; below Full access, never the one their own access comes
// from, which the daemon refuses (access-profiles.routes.ts), since that would let them widen it.
const { holds, role } = useAccess();
const self = selfMember();
const runsPeople = computed(() => holds(`people`));
const ownProfile = computed(() => (role.value === `owner` || role.value === `maintainer` ? undefined : self.value?.profile));
const editable = (profile: AccessProfileEntry): boolean => runsPeople.value && profile.origin !== `org` && profile.id !== ownProfile.value;
const readOnlyLine = ref(``);
const { profiles, loaded, save, remove } = useAccessProfiles();
const { services } = useServices();
const { members } = useMembers();
const { namesOf } = usePersonaReach();
const draft = ref<AccessProfile>();
const existing = ref(false);
const readonly = ref(false);
const notice = ref<ReturnType<typeof noticeFrom>>();
const busy = computed(() => save.isPending.value || remove.isPending.value);
const holders = (id: string): string =>
    [
        ...members.value.filter((person) => person.profile === id).map((person) => person.email),
        ...services.value.filter((service) => service.profile === id).map((service) => service.label ?? service.id),
    ].join(`, `) || t(`sandbox.accessProfiles.noHolders`);
const start = (profile?: AccessProfileEntry): void => {
    notice.value = undefined;
    existing.value = profile !== undefined;
    readonly.value = profile === undefined ? !runsPeople.value : !editable(profile);
    readOnlyLine.value =
        profile?.origin === `org`
            ? t(`sandbox.accessProfiles.readOnlyOrg`)
            : runsPeople.value
              ? t(`sandbox.accessProfiles.readOnlyOwn`)
              : t(`sandbox.accessProfiles.readOnly`);
    draft.value =
        profile === undefined ? { id: ``, agents: `off`, credentials: { capabilities: [], secrets: [] } } : AccessProfileSchema.parse(profile);
};
// A profile is named, never given an id: a new one's id is folded from its name when it is saved and fixed from then on,
// so renaming it moves what everyone reads and never what a person or a service points at. The one-line purpose it once
// had is gone with the id field: the name and the access it grants say what it is.
const name = computed(() => draft.value?.label?.trim() ?? ``);
const candidate = computed<AccessProfile | undefined>(() => {
    if (draft.value === undefined) {
        return undefined;
    }
    const { brief: _brief, ...profile } = draft.value;
    const id = existing.value ? profile.id : idFromName(name.value, profiles.value.map((entry) => entry.id), `profile`);
    return { ...profile, id, ...(name.value === `` ? { label: undefined } : { label: name.value }) };
});
// Two profiles by one name would be one choice in every picker that offers them.
const nameTaken = computed(
    () =>
        name.value !== `` &&
        profiles.value.some((entry) => entry.id !== candidate.value?.id && (entry.label ?? entry.id).toLowerCase() === name.value.toLowerCase()),
);
const valid = computed(() => {
    const profile = candidate.value;
    if (profile === undefined || name.value === `` || nameTaken.value || !AccessProfileSchema.safeParse(profile).success) {
        return false;
    }
    return (
        draftProblem(
            { ...profileAccess(profile), emailSignIn: false, credentials: profile.credentials ?? `all`, aiAccounts: profile.aiAccounts ?? `all` },
            namesOf(profile.areas).length,
        ) === undefined &&
        (profile.agents !== `chat` || profile.assistants === undefined || profile.assistants.length > 0)
    );
});
const submit = async (): Promise<void> => {
    if (busy.value || !valid.value || readonly.value || candidate.value === undefined) {
        return;
    }
    notice.value = undefined;
    try {
        await save.mutateAsync(candidate.value);
        draft.value = undefined;
    } catch (error) {
        notice.value = noticeFrom(error, t(`sandbox.accessProfiles.saveFailed`));
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
        notice.value = noticeFrom(error, t(`sandbox.accessProfiles.removeFailed`));
    }
};
</script>
<template>
    <Await :of="loaded" imprint="sandbox.access.profiles">
        <RowGroup :label="t(`sandbox.accessProfiles.title`)">
            <template #actions
                ><Button
                    v-if="runsPeople && supportsRoute(`accessProfiles.save`) && !draft"
                    :label="t(`sandbox.accessProfiles.add`)"
                    size="small"
                    tier="boring"
                    @click="start()"
                    ><template #icon><Icon name="plus" /></template></Button
            ></template>
            <RowNote v-if="notice" variant="block"><Notice :of="notice" /></RowNote>
            <RowNote v-if="draft" variant="block">
                <form class="flex flex-col gap-4" @submit.prevent="submit">
                    <div class="flex flex-wrap items-center gap-2">
                        <strong class="mr-auto text-sm">{{ existing ? name || draft.id : t(`sandbox.accessProfiles.add`) }}</strong
                        ><Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" :disabled="busy" @click="draft = undefined" /><Button
                            tier="accent"
                            v-if="!readonly"
                            type="submit"
                            :label="t(`ui.action.save`)"
                            size="small"
                            :disabled="!valid || busy"
                            :loading="busy"
                        />
                    </div>
                    <p v-if="readonly" class="text-sm text-muted">{{ readOnlyLine }}</p>
                    <label class="flex flex-col gap-1 text-sm"
                        >{{ t(`sandbox.accessProfiles.label`)
                        }}<input
                            v-model="draft.label"
                            :disabled="readonly"
                            required
                            maxlength="60"
                            :placeholder="t(`sandbox.accessProfiles.namePlaceholder`)"
                            :class="ui.input()"
                    /></label>
                    <p v-if="nameTaken" class="text-sm text-warning">{{ t(`sandbox.accessProfiles.nameTaken`, { name }) }}</p>
                    <ProfileAnswers :profile="draft" :disabled="readonly || busy" @change="draft = $event" />
                    <p v-if="!valid && !readonly && !nameTaken && name !== ``" class="text-sm text-warning">{{ t(`sandbox.accessProfiles.incomplete`) }}</p>
                </form>
            </RowNote>
            <Row
                v-for="profile in profiles"
                :key="profile.id"
                :title="profile.label ?? profile.id"
                :description="
                    [
                        t(`sandbox.sandboxAccess.${tierOf(profileAccess(profile))}`),
                        holders(profile.id),
                        profile.origin === `org` ? t(`sandbox.accessProfiles.org`) : undefined,
                    ]
                        .filter(Boolean)
                        .join(` · `)
                "
            >
                <template #control
                    ><Button
                        :label="editable(profile) ? t(`ui.action.edit`) : t(`sandbox.accessProfiles.view`)"
                        size="small"
                        tier="quiet"
                        @click="start(profile)" /><Button
                        v-if="editable(profile) && supportsRoute(`accessProfiles.remove`)"
                        :label="t(`ui.action.delete`)"
                        size="small"
                        tier="quiet"
                        tone="danger"
                        :disabled="busy"
                        @click="destroy(profile.id)"
                /></template>
            </Row>
            <RowNote v-if="profiles.length === 0 && !draft" variant="empty">{{ t(`sandbox.accessProfiles.empty`) }}</RowNote>
        </RowGroup>
    </Await>
</template>
