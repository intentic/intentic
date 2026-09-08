import { randomBytes } from "node:crypto";
import { apiContract, type InviteDelivery } from "@intentic/api-contract";
import { GrantedRoleSchema } from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/base/errors";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireOwnedSandbox, requireUser } from "../guards.js";
import { inviteLink, sendInviteEmail } from "./email.js";
import { INVITE_TTL_MS, inviteAcceptDecision, inviteStatus, toInviteRecord } from "./invites.js";

const os = implement(apiContract).$context<OrpcContext>();

// The owner's access roster, shaped for the wire; shared by every mutation so they all return the fresh list.
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

export const inviteRoutes = {
    // The owner's roster for an owned sandbox; the daemon's authorized list is pushed separately by the browser.
    list: os.invite.list.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        return listInvites(context, sandbox.id);
    }),
    // Records a pending grant and emails the link; idempotent for pending/expired, rejects an accepted invitee.
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
        const delivered = await deliverInvite(context, { to: email, sandboxName: sandbox.name, inviterName: user.name, token });
        return { ...(await listInvites(context, sandbox.id)), ...delivered };
    }),
    // Mints a fresh token and expiry and emails again; only for a not-yet-accepted invitee.
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
        const delivered = await deliverInvite(context, { to: email, sandboxName: sandbox.name, inviterName: user.name, token });
        return { ...(await listInvites(context, sandbox.id)), ...delivered };
    }),
    // Re-grades an invitee's role; mirror-only, the daemon's own grant is pushed separately by the owner's browser.
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
    // Revokes access; the owner's browser then removes the email from the daemon's authorized list.
    revoke: os.invite.revoke.handler(async ({ context, input }) => {
        const sandbox = await requireOwnedSandbox(context, input.sandboxId);
        await context.prisma.sandboxMember.deleteMany({ where: { sandboxId: sandbox.id, email: input.email.toLowerCase() } });
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
            await context.prisma.sandboxMember.update({ where: { id: member.id }, data: { acceptedAt: new Date() } });
        }
        return { sandboxId: member.sandboxId };
    }),
};
