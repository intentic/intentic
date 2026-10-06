// members: the daemon's shared-access roster (GET/POST/DELETE /members), who besides the owner reaches this sandbox
import { z } from "zod";
import { GrantedRoleSchema } from "./shared.js";

// One person on the roster as the daemon answers it. `areas` fences what of the workspace they reach, and with it which
// assistants they may talk to: absent is the whole workspace, empty is nothing.
export const MemberSchema = z.object({
    email: z.string().describe("Who, lowercased."),
    role: GrantedRoleSchema.describe("The tier they were granted."),
    areas: z.array(z.string()).optional().describe("The areas they are fenced to. Absent means the whole workspace."),
});
export type Member = z.infer<typeof MemberSchema>;

// What every roster write answers: the roster after it.
export const MembersListSchema = z.object({ members: z.array(MemberSchema) });
export type MembersList = z.infer<typeof MembersListSchema>;

// GET /members: the roster, plus the owner, an identity fact the roster file never holds. Absent before the first
// sign-in, on a loopback or test daemon.
export const MembersRosterSchema = MembersListSchema.extend({ owner: z.string().optional() });
export type MembersRoster = z.infer<typeof MembersRosterSchema>;

// POST /members: a grant is a role decision, so the role is required. Areas are optional, their absence being the whole
// workspace; a writer and a guest are refused without them, since for those two tiers the fence is the tier.
export const MemberGrantSchema = z.object({
    email: z.string(),
    role: GrantedRoleSchema,
    areas: z.array(z.string().min(1)).max(20).optional(),
});
export type MemberGrant = z.infer<typeof MemberGrantSchema>;

// DELETE /members: whose access to take back.
export const MemberEmailSchema = z.object({ email: z.string() });
