import { randomBytes } from "node:crypto";
import { apiContract } from "@intentic-app/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireOwnedSandbox, requireUser } from "../guards.js";
import { sendInviteEmail } from "./email.js";
import { INVITE_TTL_MS, inviteAcceptDecision, inviteStatus, toInviteRecord } from "./invites.js";

const os = implement(apiContract).$context<OrpcContext>();

// The owner's access roster, shaped for the wire (pending/accepted/expired derived per row). Shared by every
// invite mutation so they all return the fresh list.
const listInvites = async (context: OrpcContext, sandboxId: string) => {
    const members = await context.prisma.sandboxMember.findMany({ where: { sandboxId }, orderBy: { createdAt: `asc` } });
    const now = new Date();
    return { members: members.map((member) => toInviteRecord(member, now)) };
};

export const inviteRoutes = {
    // The owner's access roster for an owned sandbox: every invited email plus its derived state. The daemon's
    // own authorized list is pushed separately by the owner's browser — the server can't call the daemon.
    list: os.invite.list.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        return listInvites(context, sandbox.id);
    }),
    // Invite an email: record a PENDING grant with its role and a one-shot token, and email the accept link.
    // Idempotent for a still-pending/expired invitee (re-mints the link, re-grades the role); rejects if they
    // already accepted (setRole is the re-grade for an active member). The row is written before the email so a
    // send failure leaves a resendable pending invite. The owner's browser separately pushes this grant to the
    // daemon so an accepted invitee has access immediately.
    create: os.invite.create.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        const email = input.email.toLowerCase();
        const existing = await context.prisma.sandboxMember.findUnique({ where: { sandboxId_email: { sandboxId: sandbox.id, email } } });
        if (existing?.acceptedAt) {
            throw new ORPCError(`CONFLICT`, { message: `${email} already has access to this sandbox.` });
        }
        const token = randomBytes(32).toString(`base64url`);
        const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
        await context.prisma.sandboxMember.upsert({
            where: { sandboxId_email: { sandboxId: sandbox.id, email } },
            create: { sandboxId: sandbox.id, email, role: input.role, inviteToken: token, inviteExpiresAt },
            update: { role: input.role, inviteToken: token, inviteExpiresAt },
        });
        await sendInviteEmail(context.config, context.logger, { to: email, sandboxName: sandbox.name, inviterName: user.name, token });
        return listInvites(context, sandbox.id);
    }),
    // Re-send an invite: mint a fresh token + expiry and email again. Only for a not-yet-accepted invitee.
    resend: os.invite.resend.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        const email = input.email.toLowerCase();
        const existing = await context.prisma.sandboxMember.findUnique({ where: { sandboxId_email: { sandboxId: sandbox.id, email } } });
        if (!existing) {
            throw new ORPCError(`NOT_FOUND`, { message: `No invite for ${email}.` });
        }
        if (existing.acceptedAt) {
            throw new ORPCError(`CONFLICT`, { message: `${email} has already accepted.` });
        }
        const token = randomBytes(32).toString(`base64url`);
        const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
        await context.prisma.sandboxMember.update({ where: { id: existing.id }, data: { inviteToken: token, inviteExpiresAt } });
        await sendInviteEmail(context.config, context.logger, { to: email, sandboxName: sandbox.name, inviterName: user.name, token });
        return listInvites(context, sandbox.id);
    }),
    // Re-grade an existing invitee (pending or accepted) to a different role. The owner's browser separately
    // pushes the same grant to the daemon — whose list is the enforced one, applied on the member's next
    // request. Mirror-only here, like every other grant write.
    setRole: os.invite.setRole.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        const email = input.email.toLowerCase();
        const existing = await context.prisma.sandboxMember.findUnique({ where: { sandboxId_email: { sandboxId: sandbox.id, email } } });
        if (!existing) {
            throw new ORPCError(`NOT_FOUND`, { message: `No invite for ${email}.` });
        }
        await context.prisma.sandboxMember.update({ where: { id: existing.id }, data: { role: input.role } });
        return listInvites(context, sandbox.id);
    }),
    // Revoke access (pending or accepted). The owner's browser then removes the email from the daemon's
    // authorized list.
    revoke: os.invite.revoke.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        await context.prisma.sandboxMember.deleteMany({ where: { sandboxId: sandbox.id, email: input.email.toLowerCase() } });
        return listInvites(context, sandbox.id);
    }),
    // Public read for the accept page (no session): what the invite behind this token is for. Unknown token
    // reads as `invalid` with nothing else exposed.
    preview: os.invite.preview.handler(async ({ context, input }) => {
        const member = await context.prisma.sandboxMember.findUnique({ where: { inviteToken: input.token }, include: { sandbox: true } });
        if (!member) {
            return { status: `invalid` };
        }
        return { status: inviteStatus(member, new Date()), sandboxName: member.sandbox.name, invitedEmail: member.email };
    }),
    // Accept an invite: flip the caller's pending grant to an active member. email-locked (the daemon authorizes
    // by the exact invited email); idempotent once accepted. The sandbox then surfaces in the caller's list.
    accept: os.invite.accept.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const member = await context.prisma.sandboxMember.findUnique({ where: { inviteToken: input.token } });
        if (!member) {
            throw new ORPCError(`NOT_FOUND`, { message: `This invite link is invalid.` });
        }
        const decision = inviteAcceptDecision(member, user.email, new Date());
        if (decision === `expired`) {
            throw new ORPCError(`BAD_REQUEST`, { message: `This invite link has expired — ask the owner to resend it.` });
        }
        if (decision === `wrong-email`) {
            throw new ORPCError(`FORBIDDEN`, { message: `This invite is for ${member.email}. Sign in with that Google account to accept.` });
        }
        if (decision === `accept`) {
            await context.prisma.sandboxMember.update({ where: { id: member.id }, data: { acceptedAt: new Date() } });
        }
        return { sandboxId: member.sandboxId };
    }),
};
