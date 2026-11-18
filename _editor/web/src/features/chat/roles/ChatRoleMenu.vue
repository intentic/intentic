<script setup lang="ts">
import { FULL_ACCESS_ROLE, type Role } from "@intentic/sandbox-contract/schemas/roles";
import { roleBoundsWords, profilesHolding } from "../../../models/sandbox/roles/roleBounds";
import { useAccessProfiles } from "../../../models/sandbox/access/useAccessProfiles";
import { browserOwnsClick, FACE_SIZES, RoleFace, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useRoles } from "../../../models/sandbox/roles/useRoles";
import { builtInRoleViews } from "../../../models/sandbox/roles/builtInRoles";
import { useTier } from "../../../client/sandbox/useTier";
import { here, page } from "../../../lib/routes/links";
import { useT } from "@intentic/ui/i18n";

// The composer's role picker: who this chat speaks as to the outside world. The two built-ins come first and are always
// there: All accounts (what no pick means, so picking it sends none) and No accounts. A role whose accounts are all
// signed out is still offered, marked rather than hidden: it's still meaningful, just unable to post yet.

const t = useT();

const { picked } = defineProps<{ picked?: string }>();
const emit = defineEmits<{ picked: [role: string | undefined] }>();

const { roles, isConnected } = useRoles();
// A guest picks among the roles it holds and nothing wider: All accounts would reach every account, which is exactly
// what a guest is not handed, No accounts the whole toolbox, and the roles are the owner's to manage: the links to
// their page are offered only to a maintainer, who may open it.
const { isGuest, canShip } = useTier();

// What a card may reach is the access profiles listing it; the badge is drawn only for a card one of them holds.
const { profiles } = useAccessProfiles();
const heldBy = (role: Role) => profilesHolding(profiles.value, role.id);

// True once any one of a role's accounts is connected; only a role that reaches nothing is marked.
const ready = (role: Role): boolean => role.capabilities.some((id) => isConnected(id));

// Shown because a mark can't tell reddit-work from reddit-personal, and that's the reason a role exists.
const accountsOf = (role: Role): string => role.capabilities.join(` · `);

const empty = computed(() => roles.value.length === 0);

// The built-ins as rows: All accounts is what no pick means, so it is ticked for none and picking it sends none.
const builtIns = computed(() =>
    builtInRoleViews().map((view) => {
        const sends = view.id === FULL_ACCESS_ROLE ? undefined : view.id;
        return { ...view, sends, on: picked === sends || (sends === undefined && picked === FULL_ACCESS_ROLE) };
    }),
);

// Closes the menu only on a plain click; a click the browser owns (Ctrl/Cmd, opening a new tab) must leave this menu
// open.
const closeMenu = (event: MouseEvent): void => {
    if (!browserOwnsClick(event)) {
        emit(`picked`, picked);
    }
};
</script>

<template>
    <!-- Hairline between rows, so a picked row and a hovered neighbor read as two highlights, not one block. -->
    <div class="flex flex-col gap-0.5 p-1">
        <!-- The tick marks the current pick, built-ins included: with none ticked, an unset role would read as a broken menu. -->
        <template v-if="!isGuest">
            <button
                v-for="row in builtIns"
                :key="row.id"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3 text-sm md:text-xs"
                :class="{ 'ui-row-select-on': row.on }"
                :aria-selected="row.on"
                @click="emit(`picked`, row.sends)"
            >
                <Icon :name="row.icon" class="shrink-0 text-xs text-subtle" />
                <span class="flex min-w-0 flex-col">
                    <span class="text-sm text-content md:text-xs">{{ row.label }}</span>
                    <span class="text-2xs text-subtle">{{ row.note }}</span>
                </span>
                <Icon v-if="row.on" name="check" class="ml-auto shrink-0 text-2xs text-accent" aria-hidden="true" />
            </button>
        </template>

        <!-- Not an error: the copy explains what an empty list means and where to fix it. -->
        <template v-if="empty">
            <p class="px-2.5 py-3 text-2xs text-subtle">
                {{ isGuest ? t(`chat.chatRoleMenu.noGuestYet`) : t(`chat.chatRoleMenu.noRolesYetChat`) }}
            </p>
            <RouterLink
                v-if="canShip"
                :to="here(page.sandboxSettings(`roles`))"
                class="ui-row-select flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="closeMenu"
            >
                <Icon name="plus" class="shrink-0 text-xs text-subtle" />
                <span class="text-sm text-content md:text-xs">{{ t(`chat.words.setUpRole`) }}</span>
            </RouterLink>
        </template>

        <template v-else>
            <button
                v-for="role in roles"
                :key="role.id"
                type="button"
                class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1 text-left max-md:py-3"
                :class="{ 'ui-row-select-on': role.id === picked }"
                :aria-selected="role.id === picked"
                @click="emit(`picked`, role.id)"
            >
                <!-- Same face, at the same size, as this role's row on its own page; the tighter `py` is what pays for it. -->
                <RoleFace :role :size="FACE_SIZES.row" class="mt-0.5" />
                <span class="flex min-w-0 flex-col">
                    <span class="flex min-w-0 items-baseline gap-1.5">
                        <span class="truncate text-sm text-content md:text-xs">{{ role.label ?? role.id }}</span>
                        <StatusBadge v-if="heldBy(role).length > 0" variant="neutral" size="xs">{{ roleBoundsWords(heldBy(role)) }}</StatusBadge>
                    </span>
                    <!-- An account-less role still bounds the turn and still names the speaker. -->
                    <!-- The role's own blurb, when set: what a chat is matched on, and what tells "Work" from "Studio" fastest. -->
                    <span v-if="role.brief !== undefined" class="truncate text-2xs text-subtle">{{ role.brief }}</span>
                    <span v-if="role.capabilities.length > 0" class="truncate text-2xs" :class="ready(role) ? `text-subtle` : `text-muted`">
                        {{ accountsOf(role) }}<template v-if="!ready(role)">{{ t(`chat.chatRoleMenu.notSignedInYet`) }}</template>
                    </span>
                </span>
                <Icon v-if="role.id === picked" name="check" class="ml-auto shrink-0 text-2xs text-accent" aria-hidden="true" />
            </button>

            <!-- Link to the page that owns these roles, placed where a list's "manage" row always is. -->
            <RouterLink
                v-if="canShip"
                :to="here(page.sandboxSettings(`roles`))"
                class="ui-row-select flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
                @click="closeMenu"
            >
                <Icon name="cog" class="shrink-0 text-xs text-subtle" />
                <span class="text-2xs text-subtle">{{ t(`chat.words.manageRoles`) }}</span>
            </RouterLink>
        </template>
    </div>
</template>
