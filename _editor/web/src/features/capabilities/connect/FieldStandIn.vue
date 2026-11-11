<!-- A field the form answers by doing rather than typing (model/fieldStandIns.ts): a key the sandbox makes, a sign-in
     with the field's provider (Google through the platform's own client, Microsoft or an MCP server through the sandbox),
     or the GitHub or GitLab card a private repository is read with. One element in the form's field loop, whichever. -->
<script setup lang="ts">
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { McpAuthCheck } from "@intentic/sandbox-contract/schemas/mcp-sign-in";
import type { StoredSecrets } from "../../../models/capabilities/form";
import type { FormStandIn } from "../model/fieldStandIns";
import SshKeyField from "../../../parts/capabilities/SshKeyField.vue";
import CertificateRequestField from "../../../parts/capabilities/CertificateRequestField.vue";
import GitConnectionField from "./GitConnectionField.vue";
import GoogleSignInField from "./GoogleSignInField.vue";
import McpSignInField from "./McpSignInField.vue";
import MicrosoftSignInField from "./MicrosoftSignInField.vue";
import { computed } from "vue";

// Handed whole by the form (model/fieldStandIns.ts), which decides the kind.
const { kind, tile, field, values, instance, mcpCheck, kept, alarm } = defineProps<{
    kind: FormStandIn;
    /** The tile, for a sign-in that sends the form's config the way the probe does. */
    tile: CapabilityCatalogEntry;
    field: CapabilityField;
    values: Record<string, string>;
    /** The connection being edited; undefined while adding one. */
    instance?: CapabilitySummary | undefined;
    /** What an MCP address asks of a client, for its sign-in. */
    mcpCheck?: McpAuthCheck | undefined;
    /** The credentials the connection being edited already holds. */
    kept: StoredSecrets;
    alarm?: string | undefined;
}>();

const emit = defineEmits<{ left: []; paste: [] }>();
const entry = computed(() => tile.id);
const connection = computed(() => instance?.id);
const stored = computed(() => kept.has(field.key));
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
    <!-- A key the sandbox makes for a certificate: only its request is shown, to send the issuer. -->
    <CertificateRequestField
        v-else-if="kind === `certificateRequest`"
        :entry="tile"
        :field="field"
        :values="values"
        :connection="connection"
        :stored="stored"
        :alarm="alarm"
        @left="emit(`left`)"
    />
    <GoogleSignInField
        v-else-if="kind === `googleSignIn`"
        :field="field"
        :values="values"
        :stored="stored"
        :alarm="alarm"
        @left="emit(`left`)"
    />
    <!-- Which GitHub or GitLab card reads a private repository, said rather than typed. -->
    <GitConnectionField v-else-if="kind === `gitConnection`" :field="field" :values="values" :kept="kept" />
    <!-- An MCP server that names an OAuth sign-in: the sandbox signs in and keeps the tokens (mcpSignIn.ts). -->
    <McpSignInField
        v-else-if="kind === `mcpSignIn`"
        v-bind="{ field, values, instance, auth: mcpCheck, stored, alarm }"
        @left="emit(`left`)"
        @paste="emit(`paste`)"
    />
    <MicrosoftSignInField
        v-else-if="kind === `microsoftSignIn`"
        :tile="tile"
        :field="field"
        :values="values"
        :connection="connection"
        :kept="kept"
        :stored="stored"
        :alarm="alarm"
        @left="emit(`left`)"
    />
</template>
