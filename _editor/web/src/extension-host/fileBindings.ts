import type { Disposable } from "@intentic/extension-api";
import type { FileContribution } from "@intentic/extension-manifest";

/* WHICH WORKSPACE FILES THE LIVE EXTENSIONS DERIVE FROM, the browser-side half of the file→view table whose
 * core half is WORKSPACE_STATE_FILES (@intentic/sandbox-contract).
 *
 * Extensions declare it statically in `contributes.files`, so this holds no policy of its own: it exists because
 * WHICH extensions are activated is a runtime fact. A builtin registers at shell boot, a git-installed bundle
 * once the sandbox is reachable, and one that fails its engines check or its manifest gate never does, the
 * daemon's push handler must union exactly the live set, and only the host knows it.
 *
 * A plain module-level map rather than a `shallowRef` (the pattern core-views/registry.ts follows for views):
 * the sole reader is systemEvents' push handler, which is imperative and reads on each frame. Nothing renders
 * from this, so nothing needs to re-render when it changes. */

// Keyed by extension id, so a re-activation REPLACES its predecessor's bindings instead of doubling them, the
// same rule registerView holds, for the same reason (a hot-reloaded host module re-runs activate against a
// registry that kept its instance).
const bindings = new Map<string, readonly FileContribution[]>();

export const registerFileBindings = (extensionId: string, files: readonly FileContribution[]): Disposable => {
    bindings.set(extensionId, files);
    return {
        // Only if it is still OURS: a superseded activation disposing late must not evict the live replacement.
        dispose: (): void => {
            if (bindings.get(extensionId) === files) {
                bindings.delete(extensionId);
            }
        },
    };
};

export const contributedFileBindings = (): readonly FileContribution[] => [...bindings.values()].flat();
