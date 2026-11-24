import type { RouteCandidates } from "@intentic/api-contract/ingress";
import type { Prisma, PrismaClient } from "@intentic/prisma";
import { normalizeProjectId } from "@intentic/sandbox-contract/project-id";
import { mintSandboxPass, SANDBOX_PASS_TTL_MS } from "@intentic/sandbox-contract/sandbox-pass";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Context } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { IngressHandler } from "../ingress.js";
import { identitySigningKeyOf } from "../sign-in.js";
import { orgCrossing } from "./org-crossing.js";

/* ACCOUNT-LEVEL ROUTING AS A PERSON, the directory's half (docs/architecture/account-routing.md): a pass for one scope to
 * a sandbox the named person reaches, whoever owns it. The connect token says which sandbox is asking; the person must
 * be on it (its owner, or a member who accepted), and the target must be one they reach too, so a sandbox can only ever
 * name its own people, toward sandboxes those people are already in. The pass alone opens a report door and nothing
 * else: every other scope is admitted over there only beside a pairing secret the person gave the asking sandbox, which
 * this platform never sees. */

type Env = { Variables: { logger: Logger } };

const ORG = { select: { id: true, name: true } } as const;
const TARGET = { id: true, tunnelId: true, name: true, daemonUrl: true, org: ORG } as const;

// A sandbox this person reaches: they own it, or they accepted a place on it. Addresses compare without case, as a
// sign-in lowercases them and an address kept from before might not.
const reaches = (email: string): Prisma.SandboxWhereInput => ({
    OR: [
        { owner: { email: { equals: email, mode: `insensitive` } } },
        { members: { some: { email: { equals: email, mode: `insensitive` }, acceptedAt: { not: null } } } },
    ],
});

type Target = Prisma.SandboxGetPayload<{ select: typeof TARGET }>;
type Found = { readonly target: Target } | { readonly status: 400 | 403 | 404 | 409; readonly error: string; readonly candidates?: readonly Target[] };

const candidatesOf = (rows: readonly Target[]): RouteCandidates[`candidates`] => rows.map((row) => ({ sandboxId: row.tunnelId, name: row.name }));

// A report's target: the one sandbox claiming the project among those the person reaches, or with no person, the claim on
// the asking sandbox's own owner's account (what projectResolve has always answered).
const reportTarget = async (prisma: PrismaClient, caller: { id: string; ownerId: string }, project: string, person: string | undefined): Promise<Found> => {
    const claims = await prisma.projectClaim.findMany({
        where: person === undefined ? { ownerId: caller.ownerId, project } : { project, sandbox: { removedAt: null, ...reaches(person) } },
        select: { sandbox: { select: TARGET } },
    });
    const targets = claims.map((claim) => claim.sandbox);
    if (targets.some((target) => target.id === caller.id)) {
        return { status: 409, error: `this sandbox claims ${project} itself: record the problem here rather than reporting it to yourself` };
    }
    if (targets.length > 1) {
        return { status: 409, error: `${targets.length} sandboxes you are in claim ${project}: name one with --to`, candidates: targets };
    }
    const [target] = targets;
    return target === undefined
        ? { status: 404, error: `no sandbox you are in claims ${project}: the sandbox that owns it asks its owner to claim it (\`projects claim ${project}\` there)` }
        : { target };
};

// Any other scope's target: named by its tunnel id, its platform id or its name, among the sandboxes the person reaches.
const namedTarget = async (prisma: PrismaClient, caller: { id: string }, named: string, person: string): Promise<Found> => {
    const rows = await prisma.sandbox.findMany({
        where: {
            removedAt: null,
            id: { not: caller.id },
            AND: [reaches(person), { OR: [{ tunnelId: named }, { id: named }, { name: { equals: named, mode: `insensitive` } }] }],
        },
        select: TARGET,
    });
    // An id is exact; a name can be shared by two sandboxes of different owners.
    const exact = rows.filter((row) => row.tunnelId === named || row.id === named);
    const matched = exact.length > 0 ? exact : rows;
    if (matched.length > 1) {
        return { status: 409, error: `${matched.length} sandboxes you are in are called ${named}: name one by its id`, candidates: matched };
    }
    const [target] = matched;
    return target === undefined ? { status: 404, error: `no sandbox you are in is called ${named}` } : { target };
};

type Body = NonNullable<Awaited<ReturnType<Parameters<IngressHandler<Env, `routeResolve`>>[1][`body`]>>>;

// What is wrong with the ask itself, before anything is looked up: a report names its project; anything else routes as
// one person to one named sandbox, and never carries a project (a daemon from before scopes would read it as a report).
const askProblem = (body: Body, project: string | undefined): string | undefined => {
    if (body.scope === `report`) {
        return project === undefined ? `name a project as its repository, e.g. github.com/acme/app` : undefined;
    }
    return body.project !== undefined || body.sandbox === undefined || body.person === undefined
        ? `a ${body.scope} routes as one person to one sandbox: name both, and no project`
        : undefined;
};

const callerOf = async (prisma: PrismaClient, token: string | undefined) =>
    token === undefined
        ? null
        : await prisma.sandbox.findFirst({
              where: { tokenDigest: sha256Hex(token), removedAt: null },
              select: { id: true, ownerId: true, tunnelId: true, name: true, org: ORG },
          });

type Caller = NonNullable<Awaited<ReturnType<typeof callerOf>>>;

const targetFor = (prisma: PrismaClient, caller: Caller, body: Body, project: string | undefined): Promise<Found> =>
    body.scope === `report` ? reportTarget(prisma, caller, project ?? ``, body.person) : namedTarget(prisma, caller, body.sandbox ?? ``, body.person ?? ``);

// The ask checked and its target found, or the refusal to answer instead.
const resolveAsk = async (prisma: PrismaClient, caller: Caller, body: Body): Promise<Found> => {
    const project = body.project === undefined ? undefined : normalizeProjectId(body.project);
    const problem = askProblem(body, project);
    if (problem !== undefined) {
        return { status: 400, error: problem };
    }
    if (body.person !== undefined && (await prisma.sandbox.count({ where: { id: caller.id, ...reaches(body.person) } })) === 0) {
        return { status: 403, error: `that person is not on this sandbox` };
    }
    const found = await targetFor(prisma, caller, body, project);
    if (`target` in found && found.target.daemonUrl === null) {
        return { status: 409, error: `${found.target.name} has never come online, so it has no address yet` };
    }
    return found;
};

type Deps = { readonly config: Config; readonly prisma: PrismaClient; readonly now: () => Date };

// The pass and the answer for a found target: `project` on a report alone, `crossesOrg` when the two differ.
const issued = (deps: Deps, caller: Caller, target: Target & { daemonUrl: string }, body: Body) => {
    const issuedAtMs = deps.now().getTime();
    const crossesOrg = orgCrossing(caller.org, target.org);
    const project = body.scope === `report` && body.project !== undefined ? normalizeProjectId(body.project) : undefined;
    const pass = mintSandboxPass(identitySigningKeyOf(deps.config), {
        from: caller.tunnelId,
        fromName: caller.name,
        to: target.tunnelId,
        scope: body.scope,
        project,
        person: body.person,
        issuedAtMs,
        crossesOrg,
    });
    const expiresAt = new Date(issuedAtMs + SANDBOX_PASS_TTL_MS).toISOString();
    return { scope: body.scope, project, sandboxId: target.tunnelId, name: target.name, address: target.daemonUrl, pass, expiresAt, crossesOrg };
};

export const routeResolveHandler =
    (deps: Deps): IngressHandler<Env, `routeResolve`> =>
    async (c: Context<Env>, kit) => {
        const caller = await callerOf(deps.prisma, kit.connectToken);
        if (caller === null) {
            return kit.refuse(404, `unknown sandbox`);
        }
        const body = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, `name a scope, and the project (a report) or the sandbox (anything else)`);
        }
        const found = await resolveAsk(deps.prisma, caller, body);
        if (!(`target` in found)) {
            return found.candidates === undefined
                ? kit.refuse(found.status, found.error)
                : c.json({ error: found.error, candidates: candidatesOf(found.candidates) } satisfies RouteCandidates, found.status);
        }
        const { target } = found;
        return target.daemonUrl === null ? kit.refuse(409, `no address`) : kit.answer(issued(deps, caller, { ...target, daemonUrl: target.daemonUrl }, body));
    };
