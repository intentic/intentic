import { errorMessage } from "@intentic/base/errors";
import { type DeployGrant, type DeployNeed, type StackRef, type StackSpec, stackSecretNames } from "@intentic/sandbox-contract/schemas/deploys";
import type { Need, NeedAsk, NeedSubject } from "@intentic/sandbox-contract/schemas/needs";
import { opt } from "../../opt.js";
import type { Answerer, AskContext, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// (2026-11-25) A managed stack let receive the secrets its manifest reads (schemas/deploys.ts, the daemon's deploys/): the
// deploy engine renders a secret into a stack's `.env` only under the owner's grant, which no turn can write. The agent
// asks by repository and stack (`deploys grant`); the daemon reads the manifest at the repository's HEAD for the computer
// and the names, so the card shows what a yes grants. Only the owner, or someone with Full access, signed in, may press
// it (the answer route also admits machine credentials, which never pass here), and a yes grants exactly the names the
// card showed, on the computer it showed: a manifest changed since asks again at its next deploy. Met however the grant
// was given (the Deployments board's own Grant), once it covers them.

export interface DeployNeedDeps {
    // The stack as the repository's HEAD declares it; throws, in words, when it declares none of that name.
    readonly stackAtHead: (ref: StackRef) => Promise<StackSpec>;
    readonly grantFor: (repo: string, stack: string, device: string) => Promise<DeployGrant | undefined>;
    readonly grant: (grant: Omit<DeployGrant, "grantedAt">) => Promise<DeployGrant>;
}

const listed = (names: readonly string[]): string => names.join(", ");

const metFor = (subject: Pick<DeployNeed, "repo" | "stack" | "device" | "secrets">): Met => ({
    result: `"${subject.stack}" on "${subject.device}" may receive ${listed(subject.secrets)}.`,
    use: [`Deploy it: \`deploys deploy ${subject.repo} ${subject.stack}\`.`],
});

// Whether the grant on file covers every name.
const covers = (grant: DeployGrant | undefined, names: readonly string[]): boolean => grant !== undefined && names.every((name) => grant.secrets.includes(name));

export const deployNeed = (deps: DeployNeedDeps): NeedKindHandler => {
    const subjectOf = (need: Need): DeployNeed | undefined => (need.subject.kind === "deploy" ? need.subject : undefined);
    // allow(silent-catch): an unreadable grants file reads as nothing granted here, which only keeps the card up; a deploy refuses on it by itself
    const grantOf = (repo: string, stack: string, device: string): Promise<DeployGrant | undefined> => deps.grantFor(repo, stack, device).catch(() => undefined);

    const resolve = async (ask: NeedAsk, _context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "deploy") {
            return { kind: "refused", code: "invalid", message: "Not a deploy grant ask." };
        }
        let spec: StackSpec;
        try {
            spec = await deps.stackAtHead(ask);
        } catch (error) {
            return { kind: "refused", code: "invalid_stack", message: `Nothing was asked: ${errorMessage(error)}` };
        }
        const secrets = stackSecretNames(spec);
        if (secrets.length === 0) {
            return { kind: "met", message: `"${spec.name}" reads no secrets, so there is nothing to grant: deploy it.` };
        }
        const granted = (await grantOf(ask.repo, spec.name, spec.device))?.secrets ?? [];
        const ungranted = secrets.filter((name) => !granted.includes(name));
        if (ungranted.length === 0) {
            return { kind: "met", message: metFor({ repo: ask.repo, stack: spec.name, device: spec.device, secrets }).result };
        }
        const subject: DeployNeed = { kind: "deploy", repo: ask.repo, stack: spec.name, device: spec.device, secrets, ungranted };
        const what = ungranted.length === 1 ? `the secret ${ungranted[0] ?? ""}` : `${ungranted.length} secrets`;
        return { kind: "raise", subject, title: `Let ${spec.name} on ${spec.device} receive ${what}` };
    };

    return {
        resolve,
        check: async (need): Promise<Met | undefined> => {
            const subject = subjectOf(need);
            return subject !== undefined && covers(await grantOf(subject.repo, subject.stack, subject.device), subject.secrets) ? metFor(subject) : undefined;
        },
        answer: async (need, answer, by: Answerer) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "approve") {
                return { refused: "A deploy grant is answered by granting it, or declined." };
            }
            if (by.maintainer !== true) {
                return { refused: "Only the owner, or someone with Full access, signed in, can let a stack receive secrets." };
            }
            await deps.grant({ repo: subject.repo, stack: subject.stack, device: subject.device, secrets: subject.secrets, ...opt("grantedBy", by.email) });
            return { status: "met", ...metFor(subject) };
        },
        nextTurn: () => false,
        key: (subject: NeedSubject) => (subject.kind === "deploy" ? `${subject.repo}:${subject.stack}:${subject.device}` : ""),
    };
};
