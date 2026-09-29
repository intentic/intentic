import { errorMessage } from "@intentic/base/errors";
import { type CredentialGateKind, type HostGuardSetting, type SecretHostGuard, secretsContract, tightensHostGuard } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import { bearerFrom } from "../auth/auth.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";

// Each secret's host guard: the read every exit's check answers from, and the one edit. Who may make an edit turns on
// what it does rather than on a role: anybody this route admits (a maintainer, the agent's CLI) may turn a guard on or
// take hosts off it, since that only asks more often; turning one off or adding a host is the owner's, asked on a card
// when the agent's CLI wants it and refused to everybody else.

export type SecretHostRoutesDeps = Pick<Services, "auth" | "capabilities" | "hostGuardGate" | "hostGuards" | "secretHostGuards" | "secretRegistry">;

interface HostSubject {
    readonly subject: string;
    readonly kind: CredentialGateKind;
}

const sameSubject =
    (target: HostSubject) =>
    (guard: SecretHostGuard): boolean =>
        guard.subject === target.subject && guard.kind === target.kind;

export const createSecretHostRoutes = (services: SecretHostRoutesDeps) => {
    const i = implement(secretsContract).$context<OrpcContext>();
    // Whether this caller is the owner, refusing nobody: only a loosening turns on the answer.
    const isOwner = async (headers: Headers): Promise<boolean> => {
        if (services.auth === undefined) {
            return true;
        }
        return services.auth.authorizeOwner(bearerFrom(headers.get("authorization") ?? undefined)).then(
            () => true,
            () => false,
        );
    };
    // What an edit is about, by the gate's own rule: a name with a `/` is a capability's vault entry and answers to the
    // capability; otherwise a stored secret by that name, else a connected capability by that id.
    const subjectOf = async (subject: string, kind: CredentialGateKind | undefined): Promise<HostSubject> => {
        const id = subject.split("/")[0] ?? subject;
        const named = kind !== "capability" && !subject.includes("/") && (await services.secretRegistry()).some((secret) => secret.name === subject);
        if (named) {
            return { subject, kind: "secret" };
        }
        if (kind !== "secret" && (await services.capabilities.get(id)) !== undefined) {
            return { subject: id, kind: "capability" };
        }
        throw new ORPCError("NOT_FOUND", { message: `no stored secret or connected account named "${subject}"` });
    };
    // Off with no hosts to keep is no setting at all, unless a connector's default would take its place: then the owner's
    // off has to be written down to hold.
    const store = async (target: HostSubject, next: HostGuardSetting): Promise<void> => {
        if (next.guard || next.hosts.length > 0) {
            await services.secretHostGuards.set({ ...target, ...next });
            return;
        }
        await services.secretHostGuards.remove(target.subject, target.kind);
        if ((await services.hostGuards()).some(sameSubject(target))) {
            await services.secretHostGuards.set({ ...target, ...next });
        }
    };
    // A loosening from somebody other than the owner: the agent's CLI asks the owner on a card and waits; anybody else is
    // told it is the owner's. Answers who approved it.
    const approveLoosening = async (
        context: OrpcContext,
        change: {
            readonly target: HostSubject;
            readonly from: HostGuardSetting;
            readonly to: HostGuardSetting;
            readonly conversationId?: string | undefined;
        },
        signal: AbortSignal | undefined,
    ): Promise<string | undefined> => {
        if (context.headers.get("x-intentic-agent") === null) {
            throw new ORPCError("FORBIDDEN", {
                message: `Only the owner can loosen "${change.target.subject}"'s host guard: turn it off, or add a host to it.`,
            });
        }
        const verdict = await services.hostGuardGate.widen({
            subject: change.target.subject,
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
        // Unreadable is an error here, not an empty list: empty would say every guard is off.
        hosts: i.hosts.handler(async () => {
            try {
                return { guards: [...(await services.hostGuards())] };
            } catch (error) {
                throw new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(error), cause: error });
            }
        }),
        setHosts: i.setHosts.handler(async ({ input, context, signal }) => {
            const target = await subjectOf(input.subject, input.kind);
            const next: HostGuardSetting = { guard: input.guard, hosts: [...new Set(input.hosts)] };
            const current = (await services.hostGuards()).find(sameSubject(target));
            const from: HostGuardSetting = { guard: current?.guard ?? false, hosts: current?.hosts ?? [] };
            const approvedBy =
                tightensHostGuard(current, next) || (await isOwner(context.headers))
                    ? undefined
                    : await approveLoosening(context, { target, from, to: next, conversationId: input.conversationId }, signal);
            await store(target, next);
            return { guard: next.guard, hosts: [...next.hosts], ...opt("approvedBy", approvedBy) };
        }),
    };
};
