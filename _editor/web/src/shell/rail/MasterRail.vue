<!-- THE MASTER VIEW'S RAIL (models/home/masterRail.ts says when the shell wears it): the shell's own rail, its look and its
     account control, with the sandboxes as its tiles (features/home/HomeSandboxes.vue), then the processes under way
     (RailProcesses.vue), which the reader follows and answers here rather than on another screen. Signed out, which only Home
     allows, the account's place is the way to sign in: a returning person's sandboxes are behind it. -->
<script setup lang="ts">
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useAuth } from "../../client/auth/useAuth";
import HomeSandboxes from "../../features/home/HomeSandboxes.vue";
import { HOME_PATH } from "../../lib/routes/firstScreens";
import { signInAt } from "../../lib/routes/signIn";
import AccountPanel from "../AccountPanel.vue";
import RailProcesses from "./RailProcesses.vue";

const t = useT();
const { user } = useAuth();
const signedOut = computed(() => user.value === null);
</script>

<template>
    <nav class="icon-rail flex flex-col items-center border-r border-line bg-card" style="grid-area: rail">
        <HomeSandboxes />
        <!-- What runs for the reader meanwhile (a sign-in, this PC's setup, a sandbox's), its page on Home in the chat's place. -->
        <RailProcesses />
        <RouterLink
            v-if="signedOut"
            :to="signInAt(HOME_PATH)"
            class="icon-rail-tile ui-row-select ui-row-select-horizontal mt-auto flex items-center justify-center rounded-lg text-muted hover:text-content"
            :aria-label="t(`home.firstRun.signIn`)"
            v-tooltip.right="t(`home.firstRun.signIn`)"
        >
            <Icon name="sign-in" class="icon-rail-glyph" aria-hidden="true" />
        </RouterLink>
        <AccountPanel v-else />
    </nav>
</template>
