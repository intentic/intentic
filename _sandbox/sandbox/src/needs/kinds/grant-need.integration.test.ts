import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Capability, CapabilitySchema, type Need, type Persona, PersonaPowersSchema } from "@intentic/sandbox-contract";
import type { TurnStanding } from "../../conversations/actor/turn-standing.js";
import { type ConversationGrants, fileConversationGrants } from "../../personas/conversation-grants.js";
import { grantNeed } from "./grant-need.js";

// Reach a persona or area withholds: asked for only when it is really withheld, allowed for one conversation or on the
// persona itself, and continued into the conversation's next turn either way.

const STANDING: TurnStanding = {
    at: 0,
    unattended: false,
    persona: { id: "research", name: "Research" },
    granted: [],
    withheldByPersona: [],
    withheldByGate: [],
    fence: ["intentic"],
    powers: { ...PersonaPowersSchema.parse({}), shell: false, connectors: ["github"] },
    runtime: "claude-code",
    secrets: "masked",
};

const REDDIT: Capability = CapabilitySchema.parse({ id: "reddit-work", kind: "browser", config: { platform: "reddit" } });
const LINEAR: Capability = CapabilitySchema.parse({ id: "linear", kind: "cli", config: { provider: "linear" } });

const harness = (allowedSites: readonly string[] = []) => {
    const grants: ConversationGrants = fileConversationGrants(join(mkdtempSync(join(tmpdir(), "grants-")), "conversation-grants.json"));
    const personas = new Map<string, Persona>([
        ["research", { id: "research", label: "Research", capabilities: [], powers: { ...PersonaPowersSchema.parse({}), shell: false, connectors: ["github"] }, workspace: { folders: ["intentic"] } }],
    ]);
    const kind = grantNeed({
        capabilities: async () => [REDDIT, LINEAR],
        personas: {
            get: async (id) => personas.get(id),
            upsert: async (persona) => {
                personas.set(persona.id, persona);
            },
        },
        grants: () => grants,
        personaIdByName: async (name) => [...personas.values()].find((persona) => (persona.label ?? persona.id) === name)?.id,
        siteAllowed: async (site) => allowedSites.includes(site),
    });
    return { kind, grants, personas };
};

const context = (standing: Partial<TurnStanding> = {}) => ({ conversationId: "conv-1", standing: { ...STANDING, ...standing } });
const needOf = (subject: Need["subject"]): Need => ({ id: "need-1", conversationId: "conv-1", subject, title: "", status: "open", createdAt: 1, updatedAt: 1 });

describe("grant need", () => {
    it("refuses a capability that is not connected, pointing at the capability ask", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "grant", subject: "capability", what: "notion" }, context())).toMatchObject({ kind: "refused", code: "not_connected" });
    });

    it("answers use it for a capability the persona does not withhold, and raises a grant for one it does", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "grant", subject: "capability", what: "reddit-work" }, context())).toMatchObject({ kind: "met" });
        expect(await kind.resolve({ kind: "grant", subject: "capability", what: "reddit-work" }, context({ withheldByPersona: ["reddit-work"] }))).toEqual({
            kind: "raise",
            title: 'Let this conversation use "reddit-work"',
            subject: { kind: "grant", subject: "capability", what: "reddit-work", label: '"reddit-work" (browser)', persona: "Research" },
        });
    });

    it("asks for a folder only when it is outside the fence, whatever root it was named under", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "grant", subject: "folder", what: "/work/intentic/_sandbox" }, context())).toMatchObject({ kind: "met" });
        expect(await kind.resolve({ kind: "grant", subject: "folder", what: "/mnt/intentic-main/refs/sdk/" }, context())).toEqual({
            kind: "raise",
            title: "Let this conversation reach refs/sdk",
            subject: { kind: "grant", subject: "folder", what: "refs/sdk", label: "the folder refs/sdk", persona: "Research" },
        });
        expect(await kind.resolve({ kind: "grant", subject: "folder", what: "../etc" }, context())).toMatchObject({ kind: "refused", code: "invalid" });
        expect(await kind.resolve({ kind: "grant", subject: "folder", what: "refs/sdk" }, context({ fence: undefined }))).toMatchObject({ kind: "met" });
    });

    it("asks for a shelf only when it is shut, and refuses one that does not exist", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "grant", subject: "shelf", what: "web" }, context())).toMatchObject({ kind: "met" });
        expect(await kind.resolve({ kind: "grant", subject: "shelf", what: "shell" }, context())).toMatchObject({
            kind: "raise",
            title: "Let this conversation run commands",
        });
        expect(await kind.resolve({ kind: "grant", subject: "shelf", what: "wizardry" }, context())).toMatchObject({ kind: "refused", code: "invalid" });
    });

    it("records a conversation grant, meets the need and says it reaches the next turn", async () => {
        const { kind, grants } = harness();
        const need = needOf({ kind: "grant", subject: "folder", what: "refs/sdk", label: "the folder refs/sdk", persona: "Research" });
        const answered = await kind.answer(need, { kind: "grant", scope: "conversation" }, { email: "owner@acme.dev" });
        expect(answered).toEqual({
            status: "met",
            result: "Allowed for this conversation: the folder refs/sdk.",
            use: ["It reaches this conversation from its next turn: finish what you can now, and the sandbox continues the conversation with it."],
        });
        expect(await grants.of("conv-1")).toMatchObject({ folders: ["refs/sdk"], capabilities: [], shelves: [], by: "owner@acme.dev" });
        expect(kind.nextTurn(need)).toBe(true);
    });

    it("writes a persona grant onto the card itself, into the list each kind of reach lives in", async () => {
        const { kind, personas } = harness();
        await kind.answer(needOf({ kind: "grant", subject: "capability", what: "reddit-work", label: "", persona: "Research" }), { kind: "grant", scope: "persona" }, { email: undefined });
        await kind.answer(needOf({ kind: "grant", subject: "capability", what: "linear", label: "", persona: "Research" }), { kind: "grant", scope: "persona" }, { email: undefined });
        await kind.answer(needOf({ kind: "grant", subject: "folder", what: "refs/sdk", label: "", persona: "Research" }), { kind: "grant", scope: "persona" }, { email: undefined });
        await kind.answer(needOf({ kind: "grant", subject: "shelf", what: "shell", label: "", persona: "Research" }), { kind: "grant", scope: "persona" }, { email: undefined });
        expect(personas.get("research")).toMatchObject({
            capabilities: ["reddit-work"],
            powers: { shell: true, connectors: ["github", "linear"] },
            workspace: { folders: ["intentic", "refs/sdk"] },
        });
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
        expect(await kind.answer(site, { kind: "grant", scope: "conversation" }, { email: "owner@acme.dev" })).toEqual({
            refused: "A site is allowed in the person's own browser, from its Intentic extension: this card shows when it is.",
        });
    });

    it("refuses a persona grant for a conversation that wears no persona", async () => {
        const { kind } = harness();
        expect(await kind.answer(needOf({ kind: "grant", subject: "shelf", what: "shell", label: "the shell" }), { kind: "grant", scope: "persona" }, { email: undefined })).toEqual({
            refused: "This conversation wears no persona that could take it: allow it for the conversation instead.",
        });
    });
});
