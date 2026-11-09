<!-- THE RAIL UNROLLED ONTO EVERY SANDBOX (models/home/masterRail.ts says when): what the shell's one rail holds then, drawn
     inside its `nav` (ShellDesktop.vue), which stays as the tiles change and plays the change (railMorph.ts). The
     sandboxes as its tiles (features/home/HomeSandboxes.vue), then the processes under way (RailProcesses.vue), less
     those about a sandbox that has its tile here, which wears them itself; at the foot the bookmark the sections were
     put away in (HomeSectionPicker.vue), over the account. Signed out, which only Home allows, the account's place is
     the way to sign in: a returning person's sandboxes are behind it. -->
<script setup lang="ts">
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useAuth } from "../../client/auth/useAuth";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { switchableSandboxes } from "../../models/sandbox/live/roster";
import HomeSandboxes from "../../features/home/HomeSandboxes.vue";
import { HOME_PATH } from "../../lib/routes/firstScreens";
import { signInAt } from "../../lib/routes/signIn";
import { useRole } from "../../client/sandbox/useRole";
import HomeSectionPicker from "./HomeSectionPicker.vue";
import AccountPanel from "../AccountPanel.vue";
import RailProcesses from "./RailProcesses.vue";

const t = useT();
const { user } = useAuth();
const signedOut = computed(() => user.value === null);
// The sandboxes HomeSandboxes.vue draws a tile for: their runs are worn on those tiles, not beside them.
const sandbox = useSandbox();
const tiled = computed(() => new Set(switchableSandboxes(sandbox.sandboxes.value).map((box) => box.id)));
// The bookmark holds a sandbox's sections once there is a sandbox to show; never for a member whose Home is all they
// reach (useRole `homeOnly`), who has no section to open.
const { homeOnly } = useRole();
const choosesSection = computed(() => tiled.value.size > 0 && !homeOnly.value);
</script>

<template>
    <HomeSandboxes />
    <!-- What runs for the reader meanwhile (a sign-in, this PC's setup, a sandbox's), its page on Home in the chat's place. -->
    <RailProcesses :tiled="tiled" />
    <RouterLink
        v-if="signedOut"
        :to="signInAt(HOME_PATH)"
        class="icon-rail-tile ui-row-select ui-row-select-horizontal mt-auto flex items-center justify-center rounded-lg text-muted hover:text-content"
        :aria-label="t(`home.firstRun.signIn`)"
        v-tooltip.right="t(`home.firstRun.signIn`)"
    >
        <!-- The account's empty place, as LocalAccountTile.vue draws it: an arrow into a door reads as leaving here. -->
        <Icon name="user" class="icon-rail-glyph" aria-hidden="true" />
    </RouterLink>
    <!-- The foot, held together at the bottom: the bookmark over the account, whose own top margin finds no room inside it. -->
    <div v-else class="mt-auto flex flex-col items-center" style="gap: var(--icon-rail-gap)">
        <HomeSectionPicker v-if="choosesSection" />
        <AccountPanel />
    </div>
</template>
