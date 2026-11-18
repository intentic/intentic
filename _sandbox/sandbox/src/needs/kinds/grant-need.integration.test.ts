import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import { type Capability, CapabilitySchema } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import { type Role, RolePowersSchema } from "@intentic/sandbox-contract/schemas/roles";
import type { TurnStanding } from "../../conversations/actor/turn-standing.js";
import { grantNeed } from "./grant-need.js";

// Reach a role withholds: asked for only when it is really withheld, refused when the people the conversation acts
// for hold it back whatever it wears, and otherwise answered by switching the conversation to a role whose access has
// it, from the conversation's next turn.

const STANDING: TurnStanding = {
    at: 0,
    unattended: false,
    role: { id: "research", name: "Research" },
    granted: [],
    withheldByRole: [],
    withheldByGate: [],
    withheldByReach: [],
    fence: ["intentic"],
    powers: { ...RolePowersSchema.parse({}), shell: false },
    runtime: "claude-code",
    secrets: "masked",
};

const REDDIT: Capability = CapabilitySchema.parse({ id: "reddit-work", kind: "browser", config: { platform: "reddit" } });
const X: Capability = CapabilitySchema.parse({ id: "x-main", kind: "browser", config: { platform: "x" } });
const LINEAR: Capability = CapabilitySchema.parse({ id: "linear", kind: "cli", config: { provider: "linear" } });

// Research wears the read-and-search profile and is fenced to `intentic`; Writer speaks through Reddit and is held to
// nothing; Locked is held without a shell; Elsewhere opens in a folder a fenced starter cannot reach.
const ROLES: readonly Role[] = [
    { id: "research", label: "Research", capabilities: [] },
    { id: "writer", label: "Writer", capabilities: ["reddit-work"] },
    { id: "locked", label: "Locked", capabilities: ["reddit-work"] },
    { id: "elsewhere", label: "Elsewhere", capabilities: [], workspace: { startIn: "other" } },
];
const AREAS: readonly Area[] = [{ id: "core", folders: ["intentic"] }];
const PROFILES: readonly AccessProfile[] = [
    { id: "role-research", tools: { shell: false }, areas: ["core"], roles: ["research"] },
    { id: "no-shell", tools: { shell: false }, credentials: { capabilities: [], secrets: [] }, roles: ["locked"] },
];

const harness = (allowedSites: readonly string[] = [], conversations: readonly string[] = ["conv-1"]) => {
    const worn: { conversationId: string; role: string }[] = [];
    const kind = grantNeed({
        capabilities: async () => [REDDIT, X, LINEAR],
        roles: async () => ROLES,
        profiles: async () => PROFILES,
        areas: async () => AREAS,
        wearRole: async (conversationId, role) => {
            worn.push({ conversationId, role });
            return conversations.includes(conversationId);
        },
        siteAllowed: async (site) => allowedSites.includes(site),
    });
    return { kind, worn };
};

const context = (standing: Partial<TurnStanding> = {}) => ({ conversationId: "conv-1", standing: { ...STANDING, ...standing } });
const needOf = (subject: Need["subject"], conversationId = "conv-1"): Need => ({ id: "need-1", conversationId, subject, title: "", status: "open", createdAt: 1, updatedAt: 1 });

const WRITER = { id: "writer", label: "Writer" };
const LOCKED = { id: "locked", label: "Locked" };
const ELSEWHERE = { id: "elsewhere", label: "Elsewhere" };
const ALL_ACCOUNTS = { id: "full-access", label: "All accounts" };
const NO_ACCOUNTS = { id: "no-accounts", label: "No accounts" };

describe("grant need", () => {
    it("refuses a capability that is not connected, pointing at the capability ask", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "grant", subject: "capability", what: "notion" }, context())).toMatchObject({ kind: "refused", code: "not_connected" });
    });

    it("answers use it for a capability the role does not withhold, and offers the roles that speak through one it does", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "grant", subject: "capability", what: "reddit-work" }, context())).toMatchObject({ kind: "met" });
        // Locked speaks through Reddit too, but its access spends nothing; No accounts speaks through nobody.
        expect(await kind.resolve({ kind: "grant", subject: "capability", what: "reddit-work" }, context({ withheldByRole: ["reddit-work"] }))).toEqual({
            kind: "raise",
            title: 'Switch this conversation to a role that uses "reddit-work"',
            subject: { kind: "grant", subject: "capability", what: "reddit-work", label: '"reddit-work" (browser)', roles: [WRITER, ALL_ACCOUNTS], role: "Research" },
        });
    });

    it("refuses a capability the people it works for were not given, since no role has more than they do", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "grant", subject: "capability", what: "linear" }, context({ withheldByReach: ["linear"], withheldByRole: ["linear"] }))).toMatchObject({
            kind: "refused",
            code: "out_of_reach",
        });
    });

    it("refuses when no role the conversation could wear has it", async () => {
        const { kind } = harness();
        // Wearing All accounts already: nobody else speaks through the X account.
        const wearingAll = context({ role: { id: "full-access", name: "All accounts" }, withheldByRole: ["x-main"] });
        expect(await kind.resolve({ kind: "grant", subject: "capability", what: "x-main" }, wearingAll)).toMatchObject({ kind: "refused", code: "no_role" });
    });

    it("asks for a folder only when it is outside the fence, whatever root it was named under, and offers the roles that reach it", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "grant", subject: "folder", what: "/work/intentic/_sandbox" }, context())).toMatchObject({ kind: "met" });
        expect(await kind.resolve({ kind: "grant", subject: "folder", what: "/mnt/intentic-main/refs/sdk/" }, context())).toEqual({
            kind: "raise",
            title: "Switch this conversation to a role that reaches refs/sdk",
            subject: { kind: "grant", subject: "folder", what: "refs/sdk", label: "the folder refs/sdk", roles: [WRITER, LOCKED, ELSEWHERE, ALL_ACCOUNTS, NO_ACCOUNTS], role: "Research" },
        });
        expect(await kind.resolve({ kind: "grant", subject: "folder", what: "../etc" }, context())).toMatchObject({ kind: "refused", code: "invalid" });
        expect(await kind.resolve({ kind: "grant", subject: "folder", what: "refs/sdk" }, context({ fence: undefined }))).toMatchObject({ kind: "met" });
    });

    it("refuses a folder outside the areas the conversation was born in, and offers no card homed outside them", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "grant", subject: "folder", what: "refs/sdk" }, context({ accessFence: ["intentic"] }))).toMatchObject({
            kind: "refused",
            code: "out_of_reach",
        });
        // Inside the starter's areas, but outside Research's own: a card homed at the root or elsewhere is not one its
        // starter may wear, so only the built-ins are offered.
        const fenced = await kind.resolve({ kind: "grant", subject: "folder", what: "intentic/app" }, context({ fence: ["intentic/docs"], accessFence: ["intentic"] }));
        expect(fenced).toMatchObject({ kind: "raise", subject: { roles: [ALL_ACCOUNTS, NO_ACCOUNTS] } });
    });

    it("refuses a shelf the access the conversation runs under holds back, since no role lifts it", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "grant", subject: "shelf", what: "shell" }, context({ ceiling: { shell: false } }))).toEqual({
            kind: "refused",
            code: "out_of_reach",
            message:
                "This conversation may not run commands: the people or the service it acts for are held back from it, and no role changes that: only the sandbox owner does, on the Access page. Carry on without it.",
        });
        // A ceiling over another shelf leaves this one to the role, which another role may have.
        expect(await kind.resolve({ kind: "grant", subject: "shelf", what: "shell" }, context({ ceiling: { web: false } }))).toMatchObject({ kind: "raise" });
    });

    it("asks for a shelf only when it is shut, offers the roles whose access has it, and refuses one that does not exist", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "grant", subject: "shelf", what: "web" }, context())).toMatchObject({ kind: "met" });
        // Locked is held without a shell, so it is not offered; the built-ins are held to nothing of their own.
        expect(await kind.resolve({ kind: "grant", subject: "shelf", what: "shell" }, context())).toEqual({
            kind: "raise",
            title: "Switch this conversation to a role that may run commands",
            subject: { kind: "grant", subject: "shelf", what: "shell", label: "the shell", roles: [WRITER, ELSEWHERE, ALL_ACCOUNTS, NO_ACCOUNTS], role: "Research" },
        });
        expect(await kind.resolve({ kind: "grant", subject: "shelf", what: "wizardry" }, context())).toMatchObject({ kind: "refused", code: "invalid" });
    });

    it("switches the conversation to the role picked, meets the need and says it reaches the next turn", async () => {
        const { kind, worn } = harness();
        const need = needOf({ kind: "grant", subject: "folder", what: "refs/sdk", label: "the folder refs/sdk", roles: [WRITER, ALL_ACCOUNTS], role: "Research" });
        expect(await kind.answer(need, { kind: "grant", role: "writer" }, { email: "owner@acme.dev" })).toEqual({
            status: "met",
            result: "Switched this conversation to the role Writer: the folder refs/sdk is within its reach.",
            use: ["It reaches this conversation from its next turn: finish what you can now, and the sandbox continues the conversation with it."],
        });
        expect(worn).toEqual([{ conversationId: "conv-1", role: "writer" }]);
        expect(kind.nextTurn(need)).toBe(true);
    });

    it("refuses a role the card did not offer, and a conversation that is gone, switching nothing for the first", async () => {
        const { kind, worn } = harness();
        const need = needOf({ kind: "grant", subject: "shelf", what: "shell", label: "the shell", roles: [WRITER] });
        expect(await kind.answer(need, { kind: "grant", role: "locked" }, { email: undefined })).toEqual({ refused: "Pick one of the roles the card offers." });
        expect(worn).toEqual([]);
        const gone = needOf({ kind: "grant", subject: "shelf", what: "shell", label: "the shell", roles: [WRITER] }, "conv-gone");
        expect(await kind.answer(gone, { kind: "grant", role: "writer" }, { email: undefined })).toEqual({ refused: "The conversation is gone." });
    });

    // Mirrored from the person's own browser's `ask_access` (webext-peer.ts): nobody answers it on the card, the browser does.
    it("meets a site once the person's browser allows it, however the site was written, and continues the turn running", async () => {
        const site = needOf({ kind: "grant", subject: "site", what: "https://GitHub.com/login", label: "github.com" });
        expect(await harness().kind.check(site)).toBeUndefined();
        const { kind } = harness(["github.com"]);
        expect(await kind.check(site)).toEqual({ result: "github.com is allowed in the person's browser.", use: ["Its browser tools reach the site now: carry on there."] });
        // Its tools answer at once, so it is told to the turn that asked rather than held for the next one.
        expect(kind.nextTurn(site)).toBe(false);
        expect(kind.key({ kind: "grant", subject: "site", what: "github.com/*", label: "" })).toBe(kind.key(site.subject));
        expect(await kind.answer(site, { kind: "grant", role: "writer" }, { email: "owner@acme.dev" })).toEqual({
            refused: "A site is allowed in the person's own browser, from its Intentic extension: this card shows when it is.",
        });
    });
});
