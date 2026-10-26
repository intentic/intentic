import { z } from "zod";
import { entryId } from "./internal.js";
import {
    type AgentAccess,
    AgentAccessSchema,
    AiAccountKeySchema,
    CredentialReachSchema,
    type EditScope,
    EditScopeSchema,
    type MemberAccess,
} from "./members.js";
import { GrantedRoleSchema } from "./shared.js";
import { ToolCeilingSchema } from "./tool-ceiling.js";

// AN ACCESS PROFILE: the hard half of access, named and reusable (docs/architecture/access.md). One shape serves every
// kind of principal: a person holds one instead of answers of their own, and a service (schemas/services.ts) holds one
// to narrow what it does for its steward. So an intern and the marketing bot can be pointed at the same thing, and
// widening what both may spend is one edit.
// Every answer means what the same field on a roster row means (schemas/members.ts), absent included: absent areas is
// the whole workspace, absent credentials every one, absent AI accounts every one, absent tools no limit. `agents`,
// `edit`, `lands` and `assistants` are a person's answers and mean nothing for a service, which drives no editor.
// A profile cannot make a maintainer: that tier holds the owner's operating authority and is granted to a person,
// never through something shared.
export const AccessProfileSchema = z.object({
    id: entryId.describe("The profile's id, the name a roster row or a service points at."),
    label: z.string().max(60).optional().describe("What to call it on screen. Absent falls back to the id."),
    brief: z.string().max(200).optional().describe("What this access is for, in one line, so whoever grants it can tell what they are handing over."),
    areas: z
        .array(z.string().min(1))
        .max(20)
        .optional()
        .describe("The areas its holders see and their agents work in. Absent means the whole workspace."),
    agents: AgentAccessSchema.optional().describe(
        "For a person: whether their conversations run agents (off, chat, run, home). Absent means run. A service ignores it.",
    ),
    edit: EditScopeSchema.optional().describe("For a person: where they change files by hand. Absent means nowhere. A service ignores it."),
    lands: z
        .boolean()
        .optional()
        .describe("For a home-only person: whether their home conversation lands its work by itself. Absent means no."),
    credentials: CredentialReachSchema.optional().describe(
        "The connected capabilities and stored secrets its holders' conversations may spend. Absent means every one, including any connected later.",
    ),
    aiAccounts: z
        .array(AiAccountKeySchema)
        .max(500)
        .optional()
        .describe("The AI accounts its holders' turns may run on, `provider:account` or a provider alone. Absent means every one."),
    tools: ToolCeilingSchema.optional().describe("The most its holders' turns' tools may be; a persona only narrows inside it. Absent means no limit."),
    assistants: z
        .array(entryId)
        .max(50)
        .optional()
        .describe("For a guest who chats: which assistants working in their areas they may talk to. Absent means every one that works there."),
});
export type AccessProfile = z.infer<typeof AccessProfileSchema>;

// Where a profile listed beside the sandbox's own came from: the sandbox, or the organisation it is bound to, whose
// profiles arrive with its policy (schemas/organisation.ts) and are read-only here.
export const AccessProfileOriginSchema = z.enum(["sandbox", "org"]);
export type AccessProfileOrigin = z.infer<typeof AccessProfileOriginSchema>;

export const AccessProfileEntrySchema = AccessProfileSchema.extend({
    origin: AccessProfileOriginSchema.describe("The sandbox's own, or the organisation's, which nobody here can change."),
});
export type AccessProfileEntry = z.infer<typeof AccessProfileEntrySchema>;

export const AccessProfilesListSchema = z.object({
    profiles: z.array(AccessProfileEntrySchema).describe("Every profile this sandbox grants: its own, then its organisation's."),
});
export type AccessProfilesList = z.infer<typeof AccessProfilesListSchema>;

export const AccessProfileIdParamSchema = z.object({ id: entryId.describe("Which profile.") });

// What a profile save answers: each person holding it, with the tier their rewritten row now makes, so the editor can
// bring the platform's copy of their tier along (the daemon only enforces its own).
export const AccessProfileHolderSchema = z.object({
    email: z.string().describe("Who holds it, lowercased."),
    role: GrantedRoleSchema.exclude(["maintainer"]).describe("The tier the profile makes for them now."),
});
export const AccessProfileSavedSchema = z.object({
    ok: z.literal(true),
    holders: z.array(AccessProfileHolderSchema).describe("The people whose rows were rewritten, with the tier each now holds."),
});
export type AccessProfileSaved = z.infer<typeof AccessProfileSavedSchema>;

// The fields of a profile that decide a person's access, in the shape `memberAccess` reads a row in.
interface ProfileAccessFields {
    readonly areas?: readonly string[] | undefined;
    readonly agents?: AgentAccess | undefined;
    readonly edit?: EditScope | undefined;
    readonly lands?: boolean | undefined;
}

/**
 * The access a profile gives a person: never managing, `run` when it does not say, and no hand edits for a chatting or
 * home-only one, as a roster row reads (schemas/members.ts `memberAccess`). Its tier is `tierOf` of this.
 */
export const profileAccess = (profile: ProfileAccessFields): MemberAccess => {
    const agents = profile.agents ?? "run";
    const handsOff = agents === "chat" || agents === "home";
    const access: MemberAccess = { manage: false, agents, see: profile.areas, edit: handsOff ? "none" : (profile.edit ?? "none") };
    return profile.lands === true && agents === "home" ? { ...access, lands: true } : access;
};
