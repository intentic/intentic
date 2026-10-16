import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditActor, AuditEvent } from "@intentic/sandbox-contract";
import { sandboxRouteFor } from "@intentic/sandbox-contract";
import type { Context, Next } from "hono";
import type { AppEnv } from "../app-env.js";
import { actorOfCaller } from "./audit-actor.js";
import type { AuditService } from "./audit-service.js";

// Which requests the audit trail records, decided in one place by the contract route a request resolves to, so a route
// is audited by being named here rather than by remembering a call in its handler. A handler adds what only it knows
// (which settings changed, the member a grant named) with noteAudit(), and may skip a record (a session renewal).

// Changes, recorded always: who may reach the sandbox and as what, what may leave it, what decides for the agent, and
// what was exported or deleted.
export const AUDITED_CHANGES = new Map<string, string>([
    ["settings.set", "settings.change"],
    ["settings.setAgentDomain", "settings.agent_domain.change"],
    ["settings.adoptRepoChecks", "settings.repo_checks.adopt"],
    ["privacy.setPolicy", "privacy.policy.change"],
    ["privacy.learn", "privacy.vault.learn"],
    ["privacy.forget", "privacy.vault.forget"],
    ["privacy.reveal", "privacy.reveal"],
    ["POST /members", "member.grant"],
    ["DELETE /members", "member.remove"],
    ["DELETE /members/self", "member.leave"],
    ["areas.save", "area.save"],
    ["areas.remove", "area.remove"],
    ["secrets.set", "secret.set"],
    ["secrets.generate", "secret.generate"],
    ["secrets.remove", "secret.remove"],
    ["secrets.reveal", "secret.reveal"],
    ["secrets.setGate", "secret.gate.set"],
    ["secrets.removeGate", "secret.gate.remove"],
    ["secrets.setHosts", "secret.hosts.set"],
    ["secrets.setPrograms", "secret.programs.set"],
    ["secrets.typeInto", "secret.type"],
    ["secrets.keyringPair", "secret.keyring.pair"],
    ["secrets.setPolicy", "secret.policy.set"],
    ["capabilities.add", "capability.add"],
    ["capabilities.remove", "capability.remove"],
    ["capabilities.setSecret", "capability.secret.set"],
    ["capabilities.otp", "capability.otp.read"],
    ["needs.answer", "approval.answer"],
    ["needs.provideSecret", "secret.provide"],
    ["needs.revokeGrant", "grant.revoke"],
    ["safety.setPolicy", "safety.policy.change"],
    ["personas.save", "persona.save"],
    ["personas.remove", "persona.remove"],
    ["personas.savePrompt", "persona.prompt.save"],
    ["personas.saveSkill", "persona.skill.save"],
    ["personas.removeSkill", "persona.skill.remove"],
    ["approvals.upsert", "approval.decide"],
    ["approvals.remove", "approval.remove"],
    ["approvals.approveHooks", "approval.hooks.approve"],
    ["approvals.dismissHooks", "approval.hooks.dismiss"],
    ["automations.approve", "automation.approve"],
    ["automations.reject", "automation.reject"],
    ["extensions.approve", "extension.approve"],
    ["POST /environment/approve", "environment.approve"],
    ["POST /environment/reject", "environment.reject"],
    ["agent.reply", "card.answer"],
    ["agents.discard", "conversation.discard"],
    ["agents.purge", "conversation.purge"],
    ["agents.breakPolicy", "conversation.break_policy"],
    ["history.restore", "workspace.restore"],
    ["system.session", "auth.sign_in"],
    ["POST /system/passkeys/assert", "auth.sign_in"],
    ["POST /system/session/recover", "auth.sign_in_recovery"],
    ["POST /system/passkeys/register", "passkey.add"],
    ["DELETE /system/passkeys/{id}", "passkey.remove"],
    ["POST /system/passkeys/policy", "passkey.policy.set"],
    ["POST /system/passkeys/recovery", "passkey.recovery.regenerate"],
    ["POST /system/control/tokens", "token.mint"],
    ["DELETE /system/control/tokens/{id}", "token.revoke"],
    ["POST /system/sessions/revoke", "auth.sessions.revoke"],
    ["POST /system/access/disable", "auth.access.disable"],
    ["POST /bundles", "export.bundle.create"],
    ["DELETE /bundles", "export.bundle.delete"],
    ["POST /bundles/ticket", "export.bundle.download"],
    ["workspace.downloadTicket", "export.workspace.download"],
    ["POST /definition/workspace/publish", "definition.publish"],
    ["share.create", "share.create"],
    ["share.update", "share.update"],
    ["share.remove", "share.remove"],
    ["public.publish", "public.publish"],
    ["public.unpublish", "public.unpublish"],
    ["audit.export", "audit.export"],
    // The data protection page: the public-office preset changes settings and the privacy shield together, and a
    // document a data protection officer downloads is an export of how the sandbox is set up.
    ["compliance.applyPreset", "compliance.preset.apply"],
    ["compliance.document", "export.compliance.document"],
    // A member confirming the AI notice is the record an office shows for the AI Act's literacy duty (Art. 4).
    ["settings.confirmAiLiteracy", "ai_notice.confirm"],
]);

// Reads, recorded only while `settings.audit.recordReads` is on: each is a page someone opened.
export const AUDITED_READS = new Map<string, string>([
    ["agents.transcript", "conversation.read"],
    ["sessions.get", "conversation.read"],
    ["workspace.file", "file.read"],
    ["GET /workspace/raw", "file.read"],
    ["activity.list", "activity.read"],
    ["audit.list", "audit.read"],
    ["audit.verify", "audit.verify"],
    ["compliance.report", "compliance.read"],
    ["settings.aiLiteracyConfirmations", "ai_notice.confirmations.read"],
]);

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

// What a handler adds to its request's record.
export interface AuditNote {
    actor?: AuditActor;
    target?: string;
    details?: Record<string, Json>;
    // This request records nothing (a renewal rather than a sign-in).
    skip?: boolean;
}

const notes = new AsyncLocalStorage<AuditNote>();

// Adds to the record of the request being served; does nothing outside an audited request, so a handler calls it
// without knowing whether its route is audited.
export const noteAudit = (note: AuditNote): void => {
    const current = notes.getStore();
    if (current === undefined) {
        return;
    }
    if (note.details !== undefined) {
        current.details = { ...current.details, ...note.details };
    }
    if (note.actor !== undefined) {
        current.actor = note.actor;
    }
    if (note.target !== undefined) {
        current.target = note.target;
    }
    if (note.skip === true) {
        current.skip = true;
    }
};

// The `{param}`s of a route template filled from the request path, joined: `/agents/{id}/discard` → the id.
export const pathTarget = (template: string, path: string): string | undefined => {
    const wanted = template.split("/");
    const got = path.split("/");
    const values = wanted.flatMap((part, index) => (part.startsWith("{") ? [decodeURIComponent(got[index] ?? "")] : []));
    return values.length === 0 ? undefined : values.join("/");
};

const QUERY_TARGETS = ["path", "id", "conversationId", "subject", "key"];

const targetOf = (c: Context<AppEnv>, template: string): string | undefined =>
    pathTarget(template, c.req.path) ?? QUERY_TARGETS.map((key) => c.req.query(key)).find((value) => value !== undefined && value !== "");

const outcomeOf = (status: number): "ok" | "refused" | undefined => {
    if (status < 400) {
        return "ok";
    }
    return status === 401 || status === 403 ? "refused" : undefined;
};

// The middleware: placed above authentication so a refused attempt is seen too, reading the caller once the request
// has been served. It never changes the answer and never waits on the write.
export const auditRequests =
    (audit: Pick<AuditService, "record" | "recordsReads">) =>
    async (c: Context<AppEnv>, next: Next): Promise<void> => {
        const route = sandboxRouteFor(c.req.method, c.req.path);
        const action = route === undefined ? undefined : (AUDITED_CHANGES.get(route.name) ?? (audit.recordsReads() ? AUDITED_READS.get(route.name) : undefined));
        if (route === undefined || action === undefined) {
            await next();
            return;
        }
        const note: AuditNote = {};
        await notes.run(note, next);
        const outcome = outcomeOf(c.res.status);
        const identity = c.get("identity");
        const principal = c.get("principal");
        // An unauthenticated refusal names nobody; recording it would only record that the internet exists.
        const anonymous = note.actor === undefined && identity === undefined && principal === undefined;
        if (note.skip === true || outcome === undefined || (outcome === "refused" && anonymous)) {
            return;
        }
        const event: AuditEvent = { actor: note.actor ?? actorOfCaller(identity, principal), action };
        const target = note.target ?? targetOf(c, route.path);
        if (target !== undefined) {
            event.target = target;
        }
        if (outcome !== "ok") {
            event.outcome = outcome;
        }
        if (note.details !== undefined) {
            event.details = note.details;
        }
        audit.record(event);
    };
