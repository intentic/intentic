import type { ClaimNeed, Need, NeedAsk, NeedSubject } from "@intentic/sandbox-contract/schemas/needs";
import type { ClaimHolder } from "../../account-routing/project-claims.js";
import { opt } from "../../opt.js";
import type { AskContext, Answerer, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// A project claimed for this sandbox (docs/architecture/account-routing.md): once it is, the problems the owner's other
// sandboxes see in that project (`projects report`) land in this sandbox's issues inbox. Only the owner, signed in to the
// platform, writes a claim (api projects.orpc.ts), so the agent proposes it here and the owner's press on the card makes
// it: the editor calls the platform under the owner's own session, then answers the need, which is met once the
// platform lists the project for this sandbox. Met as well when it is claimed some other way (Settings ▸ Projects).

export interface ClaimNeedDeps {
    // The project id as the platform keys claims (github.com/owner/repo), from any remote URL of it; undefined for one
    // that names no repository.
    readonly normalize: (raw: string) => string | undefined;
    // The projects this sandbox claims, or why the platform could not say.
    readonly claimedHere: () => Promise<{ readonly ok: true; readonly projects: readonly string[] } | { readonly ok: false; readonly problem: string }>;
    // Which other sandbox on the account claims a project now.
    readonly holder: (project: string) => Promise<ClaimHolder>;
    // The sandbox's bound owner: the only person whose platform session can write the claim.
    readonly ownerEmail: () => Promise<string | undefined>;
}

const metFor = (project: string): Met => ({
    result: `This sandbox claims ${project}: problems the owner's other sandboxes report about it land in this sandbox's issues inbox.`,
    use: ["Reports arrive by themselves; `projects` lists every project this sandbox answers for."],
});

const holds = async (deps: ClaimNeedDeps, project: string): Promise<boolean> => {
    const here = await deps.claimedHere();
    return here.ok && here.projects.includes(project);
};

const sameEmail = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const isOwner = async (deps: ClaimNeedDeps, by: Answerer): Promise<boolean> => {
    const owner = await deps.ownerEmail();
    return by.email !== undefined && owner !== undefined && sameEmail(by.email, owner);
};

export const claimNeed = (deps: ClaimNeedDeps): NeedKindHandler => {
    const subjectOf = (need: Need): ClaimNeed | undefined => (need.subject.kind === "claim" ? need.subject : undefined);

    const resolve = async (ask: NeedAsk, _context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "claim") {
            return { kind: "refused", code: "invalid", message: "Not a claim ask." };
        }
        const project = deps.normalize(ask.project);
        if (project === undefined) {
            return {
                kind: "refused",
                code: "invalid_project",
                message: `Nothing was asked: "${ask.project}" names no repository. Give it as github.com/owner/repo, or as any remote URL of it.`,
            };
        }
        const here = await deps.claimedHere();
        if (!here.ok) {
            return { kind: "refused", code: "platform", message: `Nothing was asked: ${here.problem}.` };
        }
        if (here.projects.includes(project)) {
            return { kind: "met", message: metFor(project).result };
        }
        const holder = await deps.holder(project);
        const heldBy = holder.state === "other" ? (holder.name ?? "another of the owner's sandboxes") : undefined;
        const subject: ClaimNeed = { kind: "claim", project, ...opt("heldBy", heldBy) };
        return { kind: "raise", subject, title: heldBy === undefined ? `Claim ${project} for this sandbox` : `Claim ${project} here, from ${heldBy}` };
    };

    return {
        resolve,
        // Met once the platform lists it for this sandbox, however it got there.
        check: async (need): Promise<Met | undefined> => {
            const subject = subjectOf(need);
            return subject !== undefined && (await holds(deps, subject.project)) ? metFor(subject.project) : undefined;
        },
        // The card's press has already asked the platform under the owner's session; this only confirms it took.
        answer: async (need, answer, by) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "approve") {
                return { refused: "A claim is answered by claiming the project, or declined." };
            }
            if (!(await isOwner(deps, by))) {
                return { refused: "Only this sandbox's owner can claim a project for it: the claim is theirs, made with their own sign-in." };
            }
            if (!(await holds(deps, subject.project))) {
                return { refused: `The platform does not list ${subject.project} for this sandbox yet: press again, or claim it in Settings ▸ Projects.` };
            }
            return { status: "met", ...metFor(subject.project) };
        },
        nextTurn: () => false,
        key: (subject: NeedSubject) => (subject.kind === "claim" ? subject.project : ""),
    };
};
