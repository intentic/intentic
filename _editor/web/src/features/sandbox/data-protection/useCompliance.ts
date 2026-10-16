import type {
    ComplianceDocumentFormat,
    ComplianceDocumentKind,
    ComplianceLanguage,
    ComplianceReport,
    PresetApplyResult,
    PresetItem,
} from "@intentic/sandbox-contract/schemas/compliance";
import { useMutation } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { rpcKey } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";

// The data protection page's reads and its one write, through the daemon's compliance routes. The report and the
// preset are read fresh each time the page opens: what a data protection officer files has to be what is configured
// now, so neither is persisted between visits.

export function useComplianceReport() {
    const { query, error } = useSandboxQuery(rpcQuery(`compliance.report`, undefined, { unpersisted: true }));
    return {
        report: computed<ComplianceReport | undefined>(() => query.data.value),
        error,
        isLoading: computed(() => query.isLoading.value),
    };
}

export function usePreset() {
    const { query, error } = useSandboxQuery(rpcQuery(`compliance.preset`, undefined, { unpersisted: true }));
    const apply = useMutation(
        {
            mutationFn: (items: readonly string[]): Promise<PresetApplyResult> => sandboxRpc.compliance.applyPreset({ items: [...items] }),
            // Everything the preset may have moved, so each page that shows it reads it again.
            onSettled: async () => {
                await Promise.all(
                    ([`compliance.preset`, `compliance.report`, `settings.get`, `privacy.status`] as const).map((procedure) =>
                        queryClient.invalidateQueries({ queryKey: rpcKey(procedure) }),
                    ),
                );
            },
        },
        queryClient,
    );
    return {
        items: computed<readonly PresetItem[] | undefined>(() => query.data.value?.items),
        error,
        isLoading: computed(() => query.isLoading.value),
        apply,
    };
}

// How long a download's object URL outlives the click that started it, in milliseconds.
const DOWNLOAD_HOLD_MS = 10_000;

const bytesOf = (base64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

// Fetched at the click, never cached: the document is the configuration at the moment it is asked for.
export const downloadDocument = async (kind: ComplianceDocumentKind, language: ComplianceLanguage, format: ComplianceDocumentFormat): Promise<void> => {
    const drafted = await sandboxRpc.compliance.document({ kind, language, format });
    const blob = new Blob([drafted.encoding === `base64` ? bytesOf(drafted.content) : drafted.content], { type: drafted.mediaType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement(`a`);
    link.href = url;
    link.download = drafted.filename;
    link.click();
    // Held past the click: a browser that starts the download a beat later would otherwise find the bytes gone.
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_HOLD_MS);
};
