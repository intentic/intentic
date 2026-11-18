<script setup lang="ts">
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import type { BuiltInRoleView } from "../../../models/sandbox/roles/builtInRoles";
import { roleBoundsWords, profilesHolding } from "../../../models/sandbox/roles/roleBounds";
import { useAccessProfiles } from "../../../models/sandbox/access/useAccessProfiles";
import { Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, useId } from "vue";
import RoleTile from "../../../components/RoleTile.vue";

// Settings owns the actions. They sit beside the tile's selection button, never inside another button. Renaming is not
// one of them: it rides the open role's own heading, beside the name, the way the sandbox's name renames. A built-in
// (Full access, No accounts) has none: it wears a lock instead of a remove control, since it is always there.
const { role, selected, controls, signedIn, saving, builtIn } = defineProps<{
    role: Role;
    selected: boolean;
    controls: string;
    signedIn: boolean;
    saving: boolean;
    builtIn?: BuiltInRoleView;
}>();
const emit = defineEmits<{ select: []; remove: [] }>();
const t = useT();
const nameId = useId();
const descriptionId = useId();
const label = computed(() => role.label ?? role.id);
// What the card may reach is the access profiles listing it.
const { profiles } = useAccessProfiles();
const held = computed(() => profilesHolding(profiles.value, role.id));
const offline = computed(() => role.capabilities.length > 0 && !signedIn);
const description = computed(() =>
    builtIn !== undefined
        ? builtIn.note
        : [
              role.brief,
              held.value.length === 0 ? undefined : roleBoundsWords(held.value),
              offline.value ? t(`sandbox.sandboxRoles.notSignedIn`) : undefined,
          ]
              .filter(Boolean)
              .join(`\n`),
);
</script>

<template>
    <div class="relative size-28">
        <RoleTile
            :role="role"
            :label="label"
            :name-id="nameId"
            :selected="selected"
            :aria-label="label"
            :aria-pressed="selected"
            :aria-controls="controls"
            :aria-describedby="description === `` ? undefined : descriptionId"
            v-tooltip.bottom="description"
            class="size-full"
            @click="emit(`select`)"
        >
            <template #badges>
                <Icon v-if="builtIn" name="lock" class="absolute bottom-0 right-0 text-2xs text-subtle" aria-hidden="true" />
                <Icon v-else-if="saving" name="spinner" spin class="absolute bottom-0 right-0 text-2xs text-subtle" />
                <span v-else-if="offline" class="absolute bottom-1 right-0 size-2 rounded-full bg-warning ring-2 ring-canvas" aria-hidden="true" />
            </template>
            <span v-if="description !== ``" :id="descriptionId" class="sr-only">{{ description }}</span>
        </RoleTile>

        <button
            v-if="builtIn === undefined"
            type="button"
            :class="ui.iconButton({ tone: `danger` }, 'absolute right-0.5 top-0.5')"
            :aria-label="t(`sandbox.sandboxRoles.removeRole`)"
            :aria-describedby="nameId"
            v-tooltip.top="t(`sandbox.sandboxRoles.removeRole2`)"
            @click="emit(`remove`)"
        >
            <Icon name="trash" class="text-2xs" />
        </button>
    </div>
</template>
