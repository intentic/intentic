<script setup lang="ts">
import { AccessProfileSchema, profileAccess, type AccessProfile, type AccessProfileEntry } from "@intentic/sandbox-contract/schemas/access-profiles";
import { tierOf } from "@intentic/sandbox-contract/schemas/members";
import { Await, Button, Icon, Notice, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useMembers } from "../../../../client/sandbox/useMembers";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { draftProblem } from "../accessGrant";
import { usePersonaReach } from "../usePersonaReach";
import { useAccessProfiles } from "../profiles/useAccessProfiles";
import { useServices } from "../profiles/useServices";
import ProfileAnswers from "../profiles/ProfileAnswers.vue";
const t = useT();
const { active } = useSandbox();
const owner = computed(() => active.value?.role === `owner`);
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
    readonly.value = !owner.value || profile?.origin === `org`;
    draft.value =
        profile === undefined ? { id: ``, agents: `off`, credentials: { capabilities: [], secrets: [] } } : AccessProfileSchema.parse(profile);
};
const valid = computed(() => {
    const profile = draft.value;
    if (
        profile === undefined ||
        !AccessProfileSchema.safeParse(profile).success ||
        (!existing.value && profiles.value.some((entry) => entry.id === profile.id))
    ) {
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
    if (busy.value || !valid.value || readonly.value || draft.value === undefined) {
        return;
    }
    notice.value = undefined;
    try {
        await save.mutateAsync(draft.value);
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
                    v-if="owner && supportsRoute(`accessProfiles.save`) && !draft"
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
                        <strong class="mr-auto text-sm">{{ draft.label || draft.id || t(`sandbox.accessProfiles.add`) }}</strong
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
                    <p v-if="readonly" class="text-sm text-muted">{{ t(`sandbox.accessProfiles.readOnly`) }}</p>
                    <label class="flex flex-col gap-1 text-sm"
                        >{{ t(`sandbox.accessProfiles.id`) }}<input v-model="draft.id" :disabled="existing || readonly" required :class="ui.input()"
                    /></label>
                    <label class="flex flex-col gap-1 text-sm"
                        >{{ t(`sandbox.accessProfiles.label`) }}<input v-model="draft.label" :disabled="readonly" maxlength="60" :class="ui.input()"
                    /></label>
                    <label class="flex flex-col gap-1 text-sm"
                        >{{ t(`sandbox.accessProfiles.brief`) }}<input v-model="draft.brief" :disabled="readonly" maxlength="200" :class="ui.input()"
                    /></label>
                    <ProfileAnswers :profile="draft" :disabled="readonly || busy" @change="draft = $event" />
                    <p v-if="!valid && !readonly" class="text-sm text-warning">{{ t(`sandbox.accessProfiles.incomplete`) }}</p>
                </form>
            </RowNote>
            <Row
                v-for="profile in profiles"
                :key="profile.id"
                :title="profile.label ?? profile.id"
                :description="
                    [
                        profile.brief,
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
                        :label="profile.origin === `org` || !owner ? t(`sandbox.accessProfiles.view`) : t(`ui.action.edit`)"
                        size="small"
                        tier="quiet"
                        @click="start(profile)" /><Button
                        v-if="owner && profile.origin !== `org` && supportsRoute(`accessProfiles.remove`)"
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
