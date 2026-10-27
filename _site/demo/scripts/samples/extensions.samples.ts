import type { GroupSamples } from "./context.ts";

// The update lifecycle runs on `storefront`, the one extension installed from a repository whether or not vendor/ was
// synced: preview, apply, then revert, which puts the offer back. The workspace extension is created, read and removed
// again; the waiting one is approved with the digest its pending row carries.
export const extensionsSamples: GroupSamples<`extensions`> = () => ({
    list: undefined,
    setEnabled: { id: `intentic.pipelines`, enabled: true },
    settings: { id: `intentic.pipelines` },
    setSettings: { id: `intentic.pipelines`, settings: {} },
    create: { publisher: `smoke`, name: `smoke-view` },
    readiness: { id: `smoke.smoke-view` },
    removalPlan: { id: `smoke.smoke-view` },
    remove: { id: `smoke.smoke-view` },
    approve: { id: `acme.order-digest`, digest: `9c4e1f7a2b8d3c6e5f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a` },
    recordUsage: { reports: { storefront: { "GET /workspace/file": 2 } } },
    checkUpdates: undefined,
    updatePreview: { id: `storefront` },
    applyUpdate: { id: `storefront` },
    revert: { id: `storefront` },
    setUpdatePolicy: { id: `storefront`, updates: `agent` },
    processStart: { id: `intentic.slack`, name: `gateway` },
    processStatus: { id: `intentic.slack`, name: `gateway` },
    processStop: { id: `intentic.slack`, name: `gateway` },
    devClear: { id: `storefront` },
});
