import { demoAuditExport, demoAuditList, demoAuditStatus, demoAuditVerify } from "../../fixture/audit";
import type { Doors } from "../doors";

// A short sample trail, so the Audit log page draws its list, its intact verdict and an export.
export const auditDoors = {
    list: (query) => demoAuditList(query),
    verify: () => demoAuditVerify(),
    status: () => demoAuditStatus(),
    export: ({ from, to }) => demoAuditExport(from, to),
} satisfies Doors<`audit`>;
