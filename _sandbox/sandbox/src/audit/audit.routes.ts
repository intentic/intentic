import { auditContract } from "@intentic/sandbox-contract/contracts/audit.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";

// The audit trail's own routes. Their floor (maintainer) is declared on the contract and enforced by the bearer
// middleware; that each one is opened is recorded by the middleware in audit-http.ts, exports always and the rest when
// reads are.
const MAX_EXPORT_DAYS = 3660;

export const createAuditRoutes = (services: Pick<Services, "audit">) => {
    const i = implement(auditContract).$context<OrpcContext>();
    return {
        list: i.list.handler(({ input }) => services.audit.log.list(input)),
        verify: i.verify.handler(() => services.audit.log.verify()),
        export: i.export.handler(({ input }) => {
            if (input.to <= input.from) {
                throw new ORPCError("BAD_REQUEST", { message: "the end of the period must come after its start" });
            }
            if (input.to - input.from > MAX_EXPORT_DAYS * 86_400_000) {
                throw new ORPCError("BAD_REQUEST", { message: "export at most ten years at a time" });
            }
            return services.audit.log.exportRange(input.from, input.to);
        }),
        status: i.status.handler(() => services.audit.status()),
    };
};
