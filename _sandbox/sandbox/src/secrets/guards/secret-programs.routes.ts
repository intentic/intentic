import { errorMessage } from "@intentic/base/errors";
import { secretsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { isOwnerBearer } from "../../auth/owner-gates.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { sandboxHeld } from "../device/device-secrets.js";
import { type ProgramGuard, widensPrograms } from "./program-guards.js";

// Each sandbox-held secret's program guard (program-guards.ts): the read a typing answers from, and the one edit. Who may
// make an edit turns on what it does, as for the host guard (secret-hosts.routes.ts): anybody this route admits (a
// maintainer, the agent's CLI) may take programs off or turn `anyField` off, since that only asks more often; adding a
// program or an app, or turning `anyField` on, is the owner's, asked on a card when the agent's CLI wants it and refused
// to everybody else. A secret a keyring holds keeps its list on that computer, and is refused here with where to go.

export type SecretProgramRoutesDeps = Pick<Services, "auth" | "deviceSecrets" | "programGuardGate" | "secretProgramGuards" | "secretRegistry">;

export const createSecretProgramRoutes = (services: SecretProgramRoutesDeps) => {
    const i = implement(secretsContract).$context<OrpcContext>();
    // Only a name a sandbox store holds has a list here; a keyring's copy is the keyring's entry, whose list is kept there.
    const subjectOf = async (subject: string): Promise<void> => {
        if ((await services.secretRegistry()).some((secret) => secret.name === subject && sandboxHeld(secret))) {
            return;
        }
        const kept = (await services.deviceSecrets.listed()).find((entry) => entry.pointer.name === subject);
        if (kept !== undefined) {
            throw new ORPCError("FORBIDDEN", {
                message: `${subject} is kept in the keyring on ${kept.machine}, which keeps its program list: change it on ${kept.machine}: intentic-machine keyring edit ${subject}`,
            });
        }
        throw new ORPCError("NOT_FOUND", { message: `no stored secret named "${subject}"` });
    };
    // A widening from somebody other than the owner: the agent's CLI asks the owner on a card and waits; anybody else is
    // told it is the owner's. Answers who approved it.
    const approveWidening = async (
        context: OrpcContext,
        change: { readonly subject: string; readonly from: ProgramGuard; readonly to: ProgramGuard; readonly conversationId?: string | undefined },
        signal: AbortSignal | undefined,
    ): Promise<string | undefined> => {
        if (context.headers.get("x-intentic-agent") === null) {
            throw new ORPCError("FORBIDDEN", {
                message: `Only the owner can loosen "${change.subject}"'s program guard: add a program or an app to it, or let it go into any field.`,
            });
        }
        const verdict = await services.programGuardGate.widen({
            subject: change.subject,
            from: change.from,
            to: change.to,
            conversationId: change.conversationId ?? context.headers.get("x-intentic-conversation") ?? undefined,
            signal: signal ?? new AbortController().signal,
        });
        if ("refusal" in verdict) {
            throw new ORPCError("FORBIDDEN", { message: verdict.refusal });
        }
        return verdict.approvedBy;
    };
    return {
        // Unreadable is an error here, not an empty list, which would read as nothing typed unasked anywhere.
        programs: i.programs.handler(async () => {
            try {
                return { guards: [...(await services.secretProgramGuards.list())] };
            } catch (error) {
                throw new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(error), cause: error });
            }
        }),
        setPrograms: i.setPrograms.handler(async ({ input, context, signal }) => {
            await subjectOf(input.subject);
            const next: ProgramGuard = { programs: [...new Set(input.programs)], packages: [...new Set(input.packages)], anyField: input.anyField };
            const current = await services.secretProgramGuards.guardFor(input.subject);
            const approvedBy =
                !widensPrograms(current, next) || (await isOwnerBearer(services, context.headers))
                    ? undefined
                    : await approveWidening(context, { subject: input.subject, from: current, to: next, conversationId: input.conversationId }, signal);
            await services.secretProgramGuards.set(input.subject, next);
            return { programs: [...next.programs], packages: [...next.packages], anyField: next.anyField, ...opt("approvedBy", approvedBy) };
        }),
    };
};
