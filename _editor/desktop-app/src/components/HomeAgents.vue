<script setup lang="ts">
import { Button, Icon, Notice, Row, RowGroup, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import { signIn, workspaceOpen } from "../desktop";

// The way from a folder of this computer to an agent working on it. An account is all that stands between the two, so
// a reader who has never signed in here is offered exactly that, and one who has is offered the workspace their
// agents are in. Nothing else on Home needs an account, which is why this sits under it rather than in front.

const { accountSeen } = defineProps<{ accountSeen: boolean }>();

const t = useT();
// Signing in happens in the default browser (auth.rs), so this window's part ends when the browser opens; it says so
// rather than sitting there as if nothing had been pressed.
const handedOver = ref(false);
const failure = ref<string | undefined>(undefined);

const startSignIn = async (): Promise<void> => {
    failure.value = undefined;
    try {
        await signIn();
        handedOver.value = true;
    } catch (error) {
        failure.value = String(error);
    }
};

// Wrapped since `workspaceOpen` takes an optional path, and a bare click handler would pass it the MouseEvent.
const openWorkspace = (): Promise<void> => workspaceOpen();
</script>

<template>
    <RowGroup>
        <Row v-if="accountSeen" icon="robot" :title="t(`desktop.home.workspaceTitle`)" :description="t(`desktop.home.workspaceLead`)">
            <template #control>
                <Button size="small" severity="secondary" :label="t(`desktop.app.openWorkspace`)" @click="openWorkspace">
                    <template #icon><Icon name="arrow-up-right" /></template>
                </Button>
            </template>
        </Row>
        <Row
            v-else
            icon="robot"
            :title="t(`desktop.home.agentsTitle`)"
            :description="handedOver ? t(`desktop.home.finishInBrowser`) : t(`desktop.home.agentsLead`)"
        >
            <template #control>
                <Button size="small" severity="secondary" :label="t(`ui.action.signIn`)" @click="startSignIn">
                    <template #icon><Icon name="sign-in" /></template>
                </Button>
            </template>
        </Row>
        <RowNote v-if="failure" variant="block">
            <Notice tone="danger" class="text-2xs">{{ failure }}</Notice>
        </RowNote>
    </RowGroup>
</template>
