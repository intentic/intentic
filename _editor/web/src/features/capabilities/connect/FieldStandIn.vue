<!-- A field the form answers by doing rather than typing (fieldStandIn.ts): a key the sandbox makes, or a sign-in through
     the platform's own client. One element in the form's field loop, whichever it is. -->
<script setup lang="ts">
import type { CapabilityField } from "@intentic/extension-manifest";
import type { StandIn } from "../../../models/capabilities/fieldStandIn";
import SshKeyField from "../../../parts/capabilities/SshKeyField.vue";
import GoogleSignInField from "./GoogleSignInField.vue";

const { kind, field, values, entry, connection, stored = false, alarm } = defineProps<{
    kind: StandIn;
    field: CapabilityField;
    values: Record<string, string>;
    entry: string;
    connection?: string | undefined;
    stored?: boolean;
    alarm?: string | undefined;
}>();

const emit = defineEmits<{ left: [] }>();
</script>

<template>
    <!-- A key the sandbox makes: the private half never reaches this page, only the public half to authorize. -->
    <SshKeyField
        v-if="kind === `sshKey`"
        :field="field"
        :values="values"
        :entry="entry"
        :connection="connection"
        :stored="stored"
        :alarm="alarm"
        @left="emit(`left`)"
    />
    <GoogleSignInField v-else :field="field" :values="values" :stored="stored" :alarm="alarm" @left="emit(`left`)" />
</template>
