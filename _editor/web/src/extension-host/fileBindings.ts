import type { Disposable } from "@intentic/extension-api";
import type { FileContribution } from "@intentic/extension-manifest";

// Browser-side half of the file→view table; core half is WORKSPACE_STATE_FILES (@intentic/sandbox-contract).
// Extensions declare bindings via contributes.files; the live union depends on which extensions are activated.
// Plain map, not a shallowRef: the only reader is systemEvents' push handler, which reads imperatively per frame.

// Keyed by extension id so re-activation replaces a predecessor's bindings instead of doubling them.
const bindings = new Map<string, readonly FileContribution[]>();

export const registerFileBindings = (extensionId: string, files: readonly FileContribution[]): Disposable => {
    bindings.set(extensionId, files);
    return {
        // Only removes the entry if it's still this activation's; a late dispose must not evict the replacement.
        dispose: (): void => {
            if (bindings.get(extensionId) === files) {
                bindings.delete(extensionId);
            }
        },
    };
};

export const contributedFileBindings = (): readonly FileContribution[] => [...bindings.values()].flat();
