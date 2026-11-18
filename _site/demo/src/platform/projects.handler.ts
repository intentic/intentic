import type { ProjectClaim } from "@intentic/api-contract";
import { normalizeProjectId } from "@intentic/sandbox-contract/ids/project-id";
import { rowOf } from "../world/sandboxRegistry";
import { type PlatformRouter, refusePlatform } from "./serve";

const claims = new Map<string, Omit<ProjectClaim, `sandboxName`>>();

const claimsOf = () => ({
    claims: [...claims.values()]
        .flatMap((claim) => {
            const sandbox = rowOf(claim.sandboxId);
            return sandbox?.tier === `owner` ? [{ ...claim, sandboxName: sandbox.name }] : [];
        })
        .sort((a, b) => a.project.localeCompare(b.project)),
});

const projectOf = (raw: string): string => normalizeProjectId(raw) ?? refusePlatform(`Name a project as its repository, e.g. github.com/acme/app.`);

export const projectsAnswers = {
    list: () => claimsOf(),
    claim: ({ sandboxId, project: raw }) => {
        const project = projectOf(raw);
        const sandbox = rowOf(sandboxId);
        if (sandbox?.tier !== `owner`) {
            return refusePlatform(`No sandbox ${sandboxId} on this account.`, 404);
        }
        claims.set(project, { project, sandboxId, createdAt: claims.get(project)?.createdAt ?? new Date().toISOString() });
        return claimsOf();
    },
    release: ({ project }) => {
        claims.delete(projectOf(project));
        return claimsOf();
    },
} satisfies NonNullable<PlatformRouter[`projects`]>;
