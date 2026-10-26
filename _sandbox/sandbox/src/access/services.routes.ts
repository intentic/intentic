import { servicesContract } from "@intentic/sandbox-contract/contracts/services.contract";
import { memberAccess } from "@intentic/sandbox-contract/schemas/members";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import { noteAudit } from "../audit/audit-http.js";
import type { Services } from "../composition.js";

// The services unattended work runs as (docs/architecture/access.md). A maintainer writes automations, so a maintainer may
// name who they run as (the contract's floor); whoever writes one, its runs never reach more than its steward may.

export type ServicesRoutesDeps = Pick<Services, "services" | "accessProfiles" | "members" | "ownerEmail" | "automations" | "inboundLinks" | "controlTokens">;

const lower = (email: string): string => email.trim().toLowerCase();

// Why a steward cannot be named: they must be someone this sandbox's access names who runs agents here, the owner or a
// person on the roster. A steward nobody can name would make a service that reaches nothing from its first run, and one
// who does not run agents would hand unattended agents an authority they do not hold themselves.
const stewardRefusal = async (services: ServicesRoutesDeps, steward: string): Promise<string | undefined> => {
    const address = lower(steward);
    const [owner, roster] = await Promise.all([services.ownerEmail(), services.members.list()]);
    if (owner !== undefined && lower(owner) === address) {
        return undefined;
    }
    const member = roster.find((row) => lower(row.email) === address);
    if (member === undefined) {
        return `${address} is neither this sandbox's owner nor on its roster, so a service acting for them would reach nothing`;
    }
    const access = memberAccess(member);
    return access.manage || access.agents === "run" ? undefined : `${address} does not run agents here, so unattended work cannot act for them`;
};

// Everything still running as a service, named, so a deletion that would leave them reaching nothing says who.
const runningAs = async (services: ServicesRoutesDeps, id: string): Promise<string[]> => {
    const [automations, links, tokens] = await Promise.all([services.automations.list(), services.inboundLinks.list(), services.controlTokens.list()]);
    return [
        ...automations
            .filter((automation) => automation.runAs === id || (automation.senders?.rules.some((rule) => rule.runAs === id) ?? false))
            .map((automation) => `the automation "${automation.id}"`),
        ...links.filter((link) => link.terms.runAs === id).map((link) => `the link "${link.label}"`),
        ...tokens.filter((token) => token.runAs === id).map((token) => `the control token "${token.label}"`),
    ];
};

export const createServicesRoutes = (services: ServicesRoutesDeps) => {
    const i = implement(servicesContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => ({ services: await services.services.list() })),
        save: i.save.handler(async ({ input }) => {
            const refused =
                (await stewardRefusal(services, input.steward)) ??
                (input.profile === undefined || (await services.accessProfiles.get(input.profile)) !== undefined ? undefined : `no such access profile: ${input.profile}`);
            if (refused !== undefined) {
                throw new ORPCError("BAD_REQUEST", { message: refused });
            }
            const service = { ...input, steward: lower(input.steward) };
            noteAudit({ target: service.id, details: { profile: service.profile ?? "none" } });
            await services.services.upsert(service);
            return { ok: true as const };
        }),
        remove: i.remove.handler(async ({ input }) => {
            const users = await runningAs(services, input.id);
            if (users.length > 0) {
                throw new ORPCError("CONFLICT", { message: `${users.join(", ")} still ${users.length === 1 ? "runs" : "run"} as it; point them elsewhere first` });
            }
            noteAudit({ target: input.id });
            await services.services.remove(input.id);
            return { ok: true as const };
        }),
    };
};
