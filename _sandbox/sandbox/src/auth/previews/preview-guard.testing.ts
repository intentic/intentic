import type { PreviewGuardScope } from "@intentic/sandbox-contract/schemas/ports";
import { createPreviewGuards, type PreviewGuardDeps, type PreviewGuards, type PreviewGuardStore, type PreviewPassKey } from "./preview-guard.js";

// The guard over memory, for suites: the scope a suite sets, and a key that names how many times it was replaced.
export const memoryPreviewGuardStore = (initial: PreviewGuardScope = "off"): PreviewGuardStore => {
    let scope = initial;
    return {
        scope: async () => scope,
        setScope: async (next) => {
            scope = next;
        },
    };
};

export const memoryPreviewPassKey = (initial = "test-preview-pass-key"): PreviewPassKey => {
    let key = initial;
    let rotations = 0;
    return {
        read: async () => key,
        rotate: async () => {
            rotations += 1;
            key = `${initial}-${String(rotations)}`;
        },
    };
};

export const TEST_SANDBOX_ID = "abcdef012345";
export const TEST_ZONE = "sbx.example.test";

export const memoryPreviewGuards = (overrides: Partial<PreviewGuardDeps> = {}): PreviewGuards =>
    createPreviewGuards({
        store: memoryPreviewGuardStore(),
        key: memoryPreviewPassKey(),
        sandboxId: TEST_SANDBOX_ID,
        zone: TEST_ZONE,
        mayPass: async () => true,
        ...overrides,
    });
