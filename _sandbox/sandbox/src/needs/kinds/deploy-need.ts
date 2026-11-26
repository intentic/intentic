import { errorMessage } from "@intentic/base/errors";
import type { Need, NeedAsk, NeedSubject } from "@intentic/sandbox-contract/schemas/needs";
import type { DeployNeed, StackGrant, StackGrantRef } from "@intentic/sandbox-contract/schemas/stack-grants";
import { opt } from "../../opt.js";
import type { Answerer, AskContext, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// (2026-11-25) A managed stack let receive some secrets (schemas/stack-grants.ts): a managed deploy fills a secret into a
// stack's `.env` only under the owner's grant, kept in the auth root where no turn and no extension can write it
// (secrets/stack-grants/stack-grants.ts). The agent asks by repository, stack, computer (its device card's id) and the names
// (`secrets grant-stack`); the core reads no manifest, so the card shows exactly what it was asked and what of it the
// stack holds already. Only the owner, or someone with Full access, signed in, may press it (the answer route also
// admits machine credentials, which never pass here), and a yes grants exactly the names the card showed, on the computer
// it showed. Met however the grant was given (the Deployments board's own Grant), once it covers them.

export interface DeployNeedDeps {
    // What the computer calls itself, for the card; throws, in words, when no device card of that id is paired.
    readonly device: (device: string) => Promise<{ readonly hostname: string | undefined }>;
    readonly grantFor: (ref: StackGrantRef) => Promise<StackGrant | undefined>;
    readonly grant: (ref: StackGrantRef, secrets: readonly string[], grantedBy: string | undefined) => Promise<StackGrant>;
}

const listed = (names: readonly string[]): string => names.join(", ");

const metFor = (subject: Pick<DeployNeed, "stack" | "device" | "secrets">): Met => ({
    result: `"${subject.stack}" on "${subject.device}" may receive ${listed(subject.secrets)}.`,
    use: ["Deploy it again (the Deployments extension's deploy_environment): this sandbox now fills them into its .env."],
});

// Whether the grant on file covers every name.
const covers = (grant: StackGrant | undefined, names: readonly string[]): boolean => grant !== undefined && names.every((name) => grant.secrets.includes(name));

const refOf = (subject: Pick<DeployNeed, "repo" | "stack" | "device">): StackGrantRef => ({ repo: subject.repo, stack: subject.stack, device: subject.device });

export const deployNeed = (deps: DeployNeedDeps): NeedKindHandler => {
    const subjectOf = (need: Need): DeployNeed | undefined => (need.subject.kind === "deploy" ? need.subject : undefined);
    // allow(silent-catch): an unreadable grants file reads as nothing granted here, which only keeps the card up; a deploy refuses on it by itself
    const grantOf = (ref: StackGrantRef): Promise<StackGrant | undefined> => deps.grantFor(ref).catch(() => undefined);

    const resolve = async (ask: NeedAsk, _context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "deploy") {
            return { kind: "refused", code: "invalid", message: "Not a stack grant ask." };
        }
        let hostname: string | undefined;
        try {
            ({ hostname } = await deps.device(ask.device));
        } catch (error) {
            return { kind: "refused", code: "invalid_device", message: `Nothing was asked: ${errorMessage(error)}` };
        }
        const secrets = [...new Set(ask.secrets)].toSorted();
        const ref = refOf(ask);
        const granted = (await grantOf(ref))?.secrets ?? [];
        const ungranted = secrets.filter((name) => !granted.includes(name));
        if (ungranted.length === 0) {
            return { kind: "met", message: metFor({ stack: ask.stack, device: ask.device, secrets }).result };
        }
        const subject: DeployNeed = { kind: "deploy", ...ref, ...opt("deviceName", hostname), secrets, ungranted };
        const what = ungranted.length === 1 ? `the secret ${ungranted[0] ?? ""}` : `${ungranted.length} secrets`;
        return { kind: "raise", subject, title: `Let ${ask.stack} on ${ask.device} receive ${what}` };
    };

    return {
        resolve,
        check: async (need): Promise<Met | undefined> => {
            const subject = subjectOf(need);
            return subject !== undefined && covers(await grantOf(refOf(subject)), subject.secrets) ? metFor(subject) : undefined;
        },
        answer: async (need, answer, by: Answerer) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "approve") {
                return { refused: "A stack grant is answered by granting it, or declined." };
            }
            if (by.maintainer !== true) {
                return { refused: "Only the owner, or someone with Full access, signed in, can let a stack receive secrets." };
            }
            await deps.grant(refOf(subject), subject.secrets, by.email);
            return { status: "met", ...metFor(subject) };
        },
        nextTurn: () => false,
        // The names too: an ask for one more name than an open card shows is a card of its own, not that one again.
        key: (subject: NeedSubject) => (subject.kind === "deploy" ? `${subject.repo}:${subject.stack}:${subject.device}:${subject.secrets.join(",")}` : ""),
    };
};
