import { demoApprovals, removeDemoApproval, upsertDemoApproval } from "../../fixture/approvals";
import { approveHooks, dismissHooks, hookRequests } from "./hooks";
import { type Doors, okAfter } from "../doors";

export const approvalsDoors = {
    list: () => ({ approvals: [...demoApprovals()], invalid: [] }),
    upsert: (item) => okAfter(() => upsertDemoApproval(item)),
    remove: ({ id }) => okAfter(() => removeDemoApproval(id)),
    // The workspace's own Claude settings declare a formatter hook nobody has approved yet (daemon/hooks.ts).
    hookRequests,
    approveHooks: ({ digest }) => okAfter(() => approveHooks(digest)),
    dismissHooks: ({ digest }) => okAfter(() => dismissHooks(digest)),
} satisfies Doors<`approvals`>;
