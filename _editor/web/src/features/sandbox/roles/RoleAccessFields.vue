<script setup lang="ts">
import { fenceCovers } from "@intentic/sandbox-contract/policy/fence-paths";
import { roleHome } from "@intentic/sandbox-contract/policy/role-home";
import type { AccessProfileEntry } from "@intentic/sandbox-contract/schemas/access-profiles";
import { Notice, type NoticeModel, Picker, SectionHeader, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useAccess } from "../../../client/sandbox/access/useAccess";
import { accessPath } from "../../../models/sandbox/sandboxNav";
import { roleBoundsWords } from "../../../models/sandbox/roles/roleBounds";
import { useAccessProfiles } from "../../../models/sandbox/access/useAccessProfiles";
import { useAreas } from "../../../models/sandbox/access/useAreas";
import FolderPicker from "../devices/FolderPicker.vue";

// A role's Access tab: where a conversation wearing it opens, and the access profile that holds it. What a role may
// reach is never written on the card (which sits in the workspace, where a conversation could edit it): it is the
// access profiles that list the card in \`roles\`, on the history volume beside the roster (docs/architecture/access.md).
// Picking one here moves the card onto that profile and off any other; what the profile allows is changed on
// Access ▸ Profiles, since several roles, people and services may share it.

const { roleId, startIn } = defineProps<{ roleId: string; startIn: string[] }>();
const emit = defineEmits<{ "update:startIn": [folders: string[]] }>();
const t = useT();

// Who can talk to this role, read off where it opens: a person holds areas, and an area whose folders cover the
// role's home is what hands it over (policy/role-home.ts). Nobody picks roles per person, so this line is the only
// place the consequence of a starting folder is visible while it is being chosen.
const { areas } = useAreas();
const reachedBy = computed<string[]>(() => {
    const home = roleHome({ workspace: startIn[0] === undefined ? {} : { startIn: startIn[0] } });
    return areas.value.filter((area) => fenceCovers(area.folders, home)).map((area) => area.label ?? area.id);
});

const { available, profiles, save } = useAccessProfiles();
const { holds } = useAccess();
const holding = computed<AccessProfileEntry[]>(() => profiles.value.filter((profile) => profile.roles?.includes(roleId) === true));
// An organisation's profile is read-only here: it can hold a card, but nobody in this sandbox moves a card onto or off it.
const fromOrg = computed(() => holding.value.filter((profile) => profile.origin === `org`));
const own = computed(() => holding.value.filter((profile) => profile.origin !== `org`));
const mayMove = computed(() => holds(`people`) && fromOrg.value.length === 0 && own.value.length <= 1);

const NONE = ``;
const options = computed(() => [
    { value: NONE, label: t(`sandbox.roleAccess.noProfile`) },
    ...profiles.value.filter((profile) => profile.origin !== `org`).map((profile) => ({ value: profile.id, label: profile.label ?? profile.id })),
]);
const picked = computed(() => own.value[0]?.id ?? NONE);

const failure = ref<NoticeModel | undefined>(undefined);
// Off every profile of the sandbox's own that lists it, onto the one picked: two writes at most, the second only once
// the first is in, so a refusal never leaves the card on two.
const pick = async (id: string | undefined): Promise<void> => {
    failure.value = undefined;
    const next = id ?? NONE;
    try {
        for (const profile of own.value.filter((entry) => entry.id !== next)) {
            const { origin: _origin, ...stored } = profile;
            await save.mutateAsync({ ...stored, roles: (profile.roles ?? []).filter((role) => role !== roleId) });
        }
        const target = profiles.value.find((profile) => profile.id === next && profile.origin !== `org`);
        if (target !== undefined && target.roles?.includes(roleId) !== true) {
            const { origin: _origin, ...stored } = target;
            await save.mutateAsync({ ...stored, roles: [...(target.roles ?? []), roleId] });
        }
    } catch (error) {
        failure.value = noticeFrom(error, t(`sandbox.roleAccess.moveFailed`));
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <div class="flex flex-col gap-1">
            <SectionHeader :label="t(`sandbox.roleForm.startsIn`)" />
            <FolderPicker
                :model-value="startIn"
                :label="t(`sandbox.roleForm.startsIn`)"
                :placeholder="t(`sandbox.roleForm.wholeWorkspace`)"
                @update:model-value="(folders: string[]) => emit(`update:startIn`, folders)"
            />
            <span class="text-2xs text-subtle">{{
                reachedBy.length === 0 ? t(`sandbox.roleForm.reachedByNobody`) : t(`sandbox.roleForm.reachedBy`, { areas: reachedBy.join(`, `) })
            }}</span>
            <span class="text-xs text-subtle">{{ t(`sandbox.roleForm.everySessionWorksIn`) }}</span>
        </div>

        <div class="flex flex-col gap-2">
            <SectionHeader :label="t(`sandbox.roleAccess.heldTo`)" />
            <p class="m-0 text-xs text-subtle">{{ t(`sandbox.roleAccess.intro`) }}</p>
            <!-- Read where the profiles cannot be: someone below Full access without People & access. -->
            <p v-if="!available" class="m-0 text-xs text-subtle">{{ t(`sandbox.roleAccess.unreadable`) }}</p>
            <template v-else>
                <ul v-if="holding.length > 0" class="m-0 flex list-none flex-col gap-1 p-0">
                    <li v-for="profile in holding" :key="profile.id" class="flex items-baseline gap-2 text-sm">
                        <span class="font-medium text-content">{{ profile.label ?? profile.id }}</span>
                        <span class="text-xs text-subtle">{{ roleBoundsWords([profile]) }}</span>
                        <span v-if="profile.origin === `org`" class="text-xs text-subtle">{{ t(`sandbox.accessProfiles.org`) }}</span>
                    </li>
                </ul>
                <p v-else class="m-0 text-xs text-subtle">{{ t(`sandbox.roleAccess.none`) }}</p>
                <label v-if="mayMove" class="flex max-w-xl items-center justify-between gap-3 text-sm">
                    <span>{{ t(`sandbox.roleAccess.pick`) }}</span>
                    <Picker
                        :model-value="picked"
                        :options="options"
                        :disabled="save.isPending.value"
                        :aria-label="t(`sandbox.roleAccess.pick`)"
                        variant="input"
                        @update:model-value="pick"
                    />
                </label>
                <p v-else class="m-0 text-xs text-subtle">{{ t(`sandbox.roleAccess.readOnly`) }}</p>
                <RouterLink :to="accessPath(`profiles`)" :class="ui.textButton({ tone: `quiet` })">{{ t(`sandbox.roleAccess.editProfiles`) }}</RouterLink>
            </template>
            <Notice v-if="failure !== undefined" :of="failure" />
        </div>
    </div>
</template>
