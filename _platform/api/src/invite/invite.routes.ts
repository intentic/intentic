import { randomBytes } from "node:crypto";
import { apiContract, type InviteDelivery } from "@intentic/api-contract";
import { peopleChangeRefusal } from "@intentic/sandbox-contract/schemas/members";
import { GrantedRoleSchema } from "@intentic/sandbox-contract/schemas/shared";
import { errorMessage } from "@intentic/base/errors";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireRosterManager, requireUser, type RosterManager } from "../guards.js";
import { refuseWhenOrgHolds } from "../org/org-policy.js";
import { inviteLink, sendInviteEmail } from "./email.js";
import { INVITE_TTL_MS, inviteAcceptDecision, inviteStatus, rightsOnRow, storedGrant, toInviteRecord } from "./invites.js";

const os = implement(apiContract).$context<OrpcContext>();

// The sandbox's access roster, shaped for the wire; shared by every mutation so they all return the fresh list.
const listInvites = async (context: OrpcContext, sandboxId: string) => {
    const members = await context.prisma.sandboxMember.findMany({ where: { sandboxId }, orderBy: { createdAt: `asc` } });
    const now = new Date();
    return { members: members.map((member) => toInviteRecord(member, now)) };
};

// Delivery failures return as data rather than throwing, so a bad send never reads as the invite not happening.
const REASON_LIMIT = 300;

const deliverInvite = async (
    context: OrpcContext,
    invite: { to: string; sandboxName: string; inviterName: string; token: string },
): Promise<{ link: string; delivery: InviteDelivery; reason?: string }> => {
    const { to, sandboxName, inviterName, token } = invite;
    const link = inviteLink(context.config, token);
    try {
        return { link, delivery: await sendInviteEmail(context.config, context.logger, { to, sandboxName, inviterName, link }) };
    } catch (error) {
        context.logger.error({ err: error, to }, `invite email refused, the invite stands, the link did not travel`);
        const said = errorMessage(error);
        return { link, delivery: `refused`, reason: said.slice(0, REASON_LIMIT) };
    }
};

// Refuses a change the manager may not make to this person's access (`peopleChangeRefusal`, the daemon's own bound), in
// its words. Only People & access alone is ever refused; the owner and Full access change anyone's.
const refuseChange = (manager: RosterManager, target: Parameters<typeof peopleChangeRefusal>[1]) => {
    const refusal = peopleChangeRefusal(manager, target);
    if (refusal !== undefined) {
        throw new ORPCError(`FORBIDDEN`, { message: refusal });
    }
};

// Every roster route is for whoever manages access (guards.ts `requireRosterManager`): the owner, Full access, or People
// & access. Each change is bounded by `refuseChange`; the daemon's authorized list is pushed separately by that person's
// browser, which the daemon bounds the same way.
export const inviteRoutes = {
    // The sandbox's roster, for anyone who manages its access.
    list: os.invite.list.handler(async ({ context, input }) => {
        const { sandbox } = await requireRosterManager(context, input.sandboxId);
        return listInvites(context, sandbox.id);
    }),
    // Records a pending grant and emails the link; idempotent for pending/expired, rejects an accepted invitee.
    // `manages` absent keeps a re-invited row's rights, none for a new one.
    create: os.invite.create.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const { sandbox, manager } = await requireRosterManager(context, input.sandboxId);
        await refuseWhenOrgHolds(context.prisma, sandbox, `access`);
        const email = input.email.toLowerCase();
        const existing = await context.prisma.sandboxMember.findUnique({ where: { sandboxId_email: { sandboxId: sandbox.id, email } } });
        if (existing?.acceptedAt) {
            throw new ORPCError(`CONFLICT`, { message: `${email} already has access to this sandbox.` });
        }
        const before = existing ? storedGrant(existing) : undefined;
        refuseChange(manager, { email, before, after: { role: input.role, manages: input.manages } });
        const manages = rightsOnRow(input.role, input.manages ?? before?.manages ?? []);
        const token = randomBytes(32).toString(`base64url`);
        const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
        await context.prisma.sandboxMember.upsert({
            where: { sandboxId_email: { sandboxId: sandbox.id, email } },
            create: { sandboxId: sandbox.id, email, role: input.role, manages, inviteToken: token, inviteExpiresAt },
            update: { role: input.role, manages, inviteToken: token, inviteExpiresAt },
        });
        const delivered = await deliverInvite(context, { to: email, sandboxName: sandbox.name, inviterName: user.name, token });
        return { ...(await listInvites(context, sandbox.id)), ...delivered };
    }),
    // Mints a fresh token and expiry and emails again; only for a not-yet-accepted invitee. It changes no grant, but the
    // invitee must still be someone the manager may change.
    resend: os.invite.resend.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const { sandbox, manager } = await requireRosterManager(context, input.sandboxId);
        await refuseWhenOrgHolds(context.prisma, sandbox, `access`);
        const email = input.email.toLowerCase();
        const existing = await context.prisma.sandboxMember.findUnique({ where: { sandboxId_email: { sandboxId: sandbox.id, email } } });
        if (!existing) {
            throw new ORPCError(`NOT_FOUND`, { message: `No invite for ${email}.` });
        }
        if (existing.acceptedAt) {
            throw new ORPCError(`CONFLICT`, { message: `${email} has already accepted.` });
        }
        const before = storedGrant(existing);
        refuseChange(manager, { email, before, after: { role: before.role } });
        const token = randomBytes(32).toString(`base64url`);
        const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
        await context.prisma.sandboxMember.update({ where: { id: existing.id }, data: { inviteToken: token, inviteExpiresAt } });
        const delivered = await deliverInvite(context, { to: email, sandboxName: sandbox.name, inviterName: user.name, token });
        return { ...(await listInvites(context, sandbox.id)), ...delivered };
    }),
    // Re-grades an invitee's role, and their rights when `manages` is given (absent keeps the row's); mirror-only, the
    // daemon's own grant is pushed separately by the manager's browser.
    setRole: os.invite.setRole.handler(async ({ context, input }) => {
        const { sandbox, manager } = await requireRosterManager(context, input.sandboxId);
        await refuseWhenOrgHolds(context.prisma, sandbox, `access`);
        const email = input.email.toLowerCase();
        const existing = await context.prisma.sandboxMember.findUnique({ where: { sandboxId_email: { sandboxId: sandbox.id, email } } });
        if (!existing) {
            throw new ORPCError(`NOT_FOUND`, { message: `No invite for ${email}.` });
        }
        const before = storedGrant(existing);
        refuseChange(manager, { email, before, after: { role: input.role, manages: input.manages } });
        const manages = rightsOnRow(input.role, input.manages ?? before.manages);
        await context.prisma.sandboxMember.update({ where: { id: existing.id }, data: { role: input.role, manages } });
        return listInvites(context, sandbox.id);
    }),
    // Revokes access; the manager's browser then removes the email from the daemon's authorized list. Full access may
    // revoke their own row, which is them leaving.
    revoke: os.invite.revoke.handler(async ({ context, input }) => {
        const { sandbox, manager } = await requireRosterManager(context, input.sandboxId);
        await refuseWhenOrgHolds(context.prisma, sandbox, `access`);
        const email = input.email.toLowerCase();
        const existing = await context.prisma.sandboxMember.findUnique({ where: { sandboxId_email: { sandboxId: sandbox.id, email } } });
        refuseChange(manager, { email, before: existing ? storedGrant(existing) : undefined });
        await context.prisma.sandboxMember.deleteMany({ where: { sandboxId: sandbox.id, email } });
        return listInvites(context, sandbox.id);
    }),
    // Public read for the accept page (no session); an unknown token reads as `invalid` with nothing else exposed.
    preview: os.invite.preview.handler(async ({ context, input }) => {
        const member = await context.prisma.sandboxMember.findUnique({ where: { inviteToken: input.token }, include: { sandbox: true } });
        if (!member) {
            return { status: `invalid` };
        }
        return {
            status: inviteStatus(member, new Date()),
            sandboxName: member.sandbox.name,
            invitedEmail: member.email,
            // Defaulted the way the roster read defaults it: a role this build does not know is the least it could be.
            role: GrantedRoleSchema.catch(`viewer`).parse(member.role),
        };
    }),
    // Flips the caller's pending grant to an active member; email-locked, idempotent once accepted.
    accept: os.invite.accept.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const member = await context.prisma.sandboxMember.findUnique({ where: { inviteToken: input.token } });
        if (!member) {
            throw new ORPCError(`NOT_FOUND`, { message: `This invite link is invalid.` });
        }
        const decision = inviteAcceptDecision(member, user.email, new Date());
        if (decision === `expired`) {
            throw new ORPCError(`BAD_REQUEST`, { message: `This invite link has expired, ask the owner to resend it.` });
        }
        if (decision === `wrong-email`) {
            throw new ORPCError(`FORBIDDEN`, { message: `This invite is for ${member.email}. Sign in with that Google account to accept.` });
        }
        if (decision === `accept`) {
            const acceptedAt = new Date();
            const accepted = await context.prisma.sandboxMember.updateMany({
                where: {
                    id: member.id,
                    inviteToken: input.token,
                    email: member.email,
                    acceptedAt: null,
                    OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gte: acceptedAt } }],
                },
                data: { acceptedAt },
            });
            if (accepted.count === 0) {
                // Another accept of this same link is idempotent; a resend, revoke or expiry invalidates this read.
                const current = await context.prisma.sandboxMember.findUnique({ where: { inviteToken: input.token } });
                if (current?.id !== member.id || inviteAcceptDecision(current, user.email, new Date()) !== `already-accepted`) {
                    throw new ORPCError(`CONFLICT`, {
                        message: `This invite changed while you were accepting it. Open the latest invite link and try again.`,
                    });
                }
            }
        }
        return { sandboxId: member.sandboxId };
    }),
};
