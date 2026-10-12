<script setup lang="ts">
import { EmptyState } from "@intentic/ui";
import { onErrorCaptured, shallowRef } from "vue";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { describeError, type ReportFields, reportClient } from "../app/clientDiagnostics";
import { extensionStatuses } from "../extension-host/loader";
import { registeredViews } from "../workbench/views/registry";

const t = useT();

/* Contains one extension view's render/lifecycle errors so a broken extension shows an inline card instead of unmounting the shell. */

// `extensionId` is the extension's id from a side view or document, and a view's own id from a rail or directory view.
const { extensionId } = defineProps<{ extensionId: string }>();
const error = shallowRef<unknown>();

// The card shows only to whoever is looking; the report is what a later reader has. It names which code the failing view
// ran, not only the id (the owner of a view id, then what the loader recorded running for that extension), and the
// failing component's own name (an SFC's file name when it declares none), which a bundled extension's stack often
// cannot give.
onErrorCaptured((captured, instance, info) => {
    error.value = captured;
    const { message, fields } = describeError(captured);
    const owner = registeredViews().find((entry) => entry.registration.id === extensionId)?.owner ?? extensionId;
    const detail: ReportFields = { ...fields, extensionId: owner, view: extensionId, info };
    const status = extensionStatuses.value.find((entry) => entry.extensionId === owner || entry.id === owner);
    if (status !== undefined) {
        detail[`loadState`] = status.state;
        detail[`revision`] = status.revision ?? `none`;
        detail[`bundle`] = status.bundle ?? `none`;
    }
    const component = instance?.$options.name ?? instance?.$options.__name;
    if (component !== undefined) {
        detail[`component`] = component;
    }
    reportClient(`extension.viewError`, message, { fields: detail });
    return false;
});
</script>

<template>
    <EmptyState
        v-if="error !== undefined"
        tone="danger"
        :title="t(`views.extensionErrorBoundary.extensionCrashedRenderingView`, { extensionId })"
        :line="messageOr(error, String(error))"
        class="h-full"
    />
    <slot v-else />
</template>
