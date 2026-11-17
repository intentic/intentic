import { apiContract, type ProjectClaim } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import { normalizeProjectId } from "@intentic/sandbox-contract/project-id";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";

const os = implement(apiContract).$context<OrpcContext>();

/* The owner's half of account-level report routing (projects.routes.ts is the daemons'): which of their sandboxes
 * answers for which project. Only a signed-in owner writes here; a daemon can propose a claim on a card, which the
 * owner's browser then sends as this call. One sandbox per project per account, so claiming moves it. */

const claimsOf = async (prisma: PrismaClient, ownerId: string): Promise<{ claims: ProjectClaim[] }> => {
    const rows = await prisma.projectClaim.findMany({
        where: { ownerId },
        select: { project: true, createdAt: true, sandbox: { select: { id: true, name: true } } },
        orderBy: { project: `asc` },
    });
    return {
        claims: rows.map((row) => ({
            project: row.project,
            sandboxId: row.sandbox.id,
            sandboxName: row.sandbox.name,
            createdAt: row.createdAt.toISOString(),
        })),
    };
};

const projectOf = (raw: string): string => {
    const project = normalizeProjectId(raw);
    if (project === undefined) {
        throw new ORPCError(`BAD_REQUEST`, { message: `name a project as its repository, e.g. github.com/acme/app` });
    }
    return project;
};

export const projectsRoutes = () => ({
    list: os.projects.list.handler(async ({ context }) => claimsOf(context.prisma, requireUser(context).id)),

    // `sandboxId` is the registry id the editor holds (sandbox.list), or the sandbox's public tunnel id a daemon knows itself by.
    claim: os.projects.claim.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const project = projectOf(input.project);
        const sandbox = await context.prisma.sandbox.findFirst({ where: { ownerId: user.id, OR: [{ id: input.sandboxId }, { tunnelId: input.sandboxId }] }, select: { id: true } });
        if (sandbox === null) {
            throw new ORPCError(`NOT_FOUND`, { message: `sandbox not found` });
        }
        await context.prisma.projectClaim.upsert({
            where: { ownerId_project: { ownerId: user.id, project } },
            create: { ownerId: user.id, sandboxId: sandbox.id, project },
            update: { sandboxId: sandbox.id },
        });
        return claimsOf(context.prisma, user.id);
    }),

    release: os.projects.release.handler(async ({ context, input }) => {
        const user = requireUser(context);
        await context.prisma.projectClaim.deleteMany({ where: { ownerId: user.id, project: projectOf(input.project) } });
        return claimsOf(context.prisma, user.id);
    }),
});
