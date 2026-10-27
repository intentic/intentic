import type { GroupSamples } from "./context.ts";

const HOOK_DIGEST = `9f2c4e7a1b3d5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8`;

export const approvalsSamples: GroupSamples<`approvals`> = ({ prepared }) => ({
    list: undefined,
    upsert: prepared,
    remove: { id: prepared.id },
    hookRequests: undefined,
    // The formatter hook set daemon/hooks.ts holds, dismissed and then approved.
    dismissHooks: { digest: HOOK_DIGEST },
    approveHooks: { digest: HOOK_DIGEST },
});
