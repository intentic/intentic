import type { PrismaClient } from "@intentic/prisma";
import { normalizeProjectId } from "@intentic/sandbox-contract/project-id";
import { mintSandboxPass, SANDBOX_PASS_TTL_MS } from "@intentic/sandbox-contract/sandbox-pass";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { ingressServer } from "../ingress.js";
import { identitySigningKeyOf } from "../sign-in.js";
import { orgCrossing } from "./org-crossing.js";
import { routeResolveHandler } from "./route-resolve.js";

/* ACCOUNT-LEVEL REPORT ROUTING, the daemon's half: a directory and a notary, never a mailbox. A sandbox asks which
 * sandbox on its own account answers for a project, and gets that sandbox's address and a pass signed with the
 * platform's identity key (sandbox-contract sandbox-pass.ts). The report itself goes straight from one daemon to the
 * other through the edge, so its content (stacks, paths, what an agent saw) never rests here.
 *
 * The connect token is the only word on who is asking: `from` in the pass is read from it, never from the body, and
 * only the asking sandbox's owner's claims are searched, so no sandbox can reach another account's. */

type ProjectsEnv = { Variables: { logger: Logger } };

export interface ProjectsDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    readonly now?: () => Date;
}

export const projectsHttpRoutes = ({ config, prisma, now = () => new Date() }: ProjectsDeps) => {
    const app = new Hono<ProjectsEnv>();
    const ingress = ingressServer(app, `/projects`);

    // 404, not 401, for an unknown token, as the wallet's doors answer: a probe learns nothing about which part was wrong.
    const callerOf = async (token: string | undefined) =>
        token === undefined
            ? undefined
            : await prisma.sandbox.findUnique({
                  where: { tokenDigest: sha256Hex(token) },
                  select: { id: true, ownerId: true, tunnelId: true, name: true, org: { select: { id: true, name: true } } },
              });

    ingress(`projectResolve`, async (_c, kit) => {
        const caller = await callerOf(kit.connectToken);
        if (caller === null || caller === undefined) {
            return kit.refuse(404, `unknown sandbox`);
        }
        const body = await kit.body();
        const project = body === undefined ? undefined : normalizeProjectId(body.project);
        if (project === undefined) {
            return kit.refuse(400, `name a project as its repository, e.g. github.com/acme/app`);
        }
        const claim = await prisma.projectClaim.findUnique({
            where: { ownerId_project: { ownerId: caller.ownerId, project } },
            select: { sandbox: { select: { id: true, tunnelId: true, name: true, daemonUrl: true, org: { select: { id: true, name: true } } } } },
        });
        if (claim === null) {
            return kit.refuse(
                404,
                `no sandbox on your account claims ${project}: the sandbox that owns it asks its owner to claim it (\`projects claim ${project}\` there raises the card), or the owner claims it in Settings ▸ Projects`,
            );
        }
        const target = claim.sandbox;
        if (target.id === caller.id) {
            return kit.refuse(409, `this sandbox claims ${project} itself: record the problem here rather than reporting it to yourself`);
        }
        if (target.daemonUrl === null) {
            return kit.refuse(409, `${target.name}, which claims ${project}, has never come online, so it has no address yet`);
        }
        const issuedAtMs = now().getTime();
        // Reports cross an organisation's line freely (the owner's choice, 2026-11-24), but never silently.
        const crossesOrg = orgCrossing(caller.org, target.org);
        const pass = mintSandboxPass(identitySigningKeyOf(config), {
            from: caller.tunnelId,
            fromName: caller.name,
            to: target.tunnelId,
            project,
            issuedAtMs,
            crossesOrg,
        });
        return kit.answer({
            project,
            sandboxId: target.tunnelId,
            name: target.name,
            address: target.daemonUrl,
            pass,
            expiresAt: new Date(issuedAtMs + SANDBOX_PASS_TTL_MS).toISOString(),
            crossesOrg,
        });
    });

    // Routing as a person (route-resolve.ts): every scope, toward any sandbox the named person reaches.
    ingress(`routeResolve`, routeResolveHandler({ config, prisma, now }));

    ingress(`projectsMine`, async (_c, kit) => {
        const caller = await callerOf(kit.connectToken);
        if (caller === null || caller === undefined) {
            return kit.refuse(404, `unknown sandbox`);
        }
        const claims = await prisma.projectClaim.findMany({ where: { sandboxId: caller.id }, select: { project: true }, orderBy: { project: `asc` } });
        return kit.answer({ projects: claims.map((claim) => claim.project) });
    });

    return app;
};
