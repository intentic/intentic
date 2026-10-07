import type { Automation, Need } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import { automationNeed } from "./automation-need.js";

// An automation an agent proposes: held to the Automations page's own rules before a card goes up, shown with what its
// check sees today, and saved, switched on, only by a person's approval.

const PROPOSAL: Automation = {
    id: "bun-1-4-3",
    enabled: true,
    trigger: { kind: "schedule", cron: "17 */6 * * *" },
    source: { kind: "npm", package: "bun", range: ">=1.4.3" },
    until: "first-fire",
    target: { kind: "conversation", conversationId: "here" },
    note: "Bun 1.4.3 is published",
    prompt: "Carry out the plan.",
};

const harness = () => {
    const saved: Automation[] = [];
    const state = { problem: undefined as string | undefined, existing: new Set<string>() };
    const kind = automationNeed({
        refuse: async () => {
            if (state.problem !== undefined) {
                throw new ORPCError("BAD_REQUEST", { message: state.problem });
            }
        },
        save: async (automation) => {
            saved.push(automation);
        },
        exists: async (id) => state.existing.has(id),
        firstCheck: async (automation) =>
            automation.source === undefined
                ? undefined
                : { pass: false, saw: "no published version of bun satisfies >=1.4.3 yet (latest is 1.4.2)", at: 5 },
    });
    return { kind, saved, state };
};

const context = { conversationId: "rapid-ridge", standing: undefined };
const needOf = (subject: Need["subject"]): Need => ({
    id: "need-1",
    conversationId: "rapid-ridge",
    subject,
    title: "",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
});

describe("automation need", () => {
    it("names the asking conversation for a target of here, and shows what the check sees today", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "automation", automation: { ...PROPOSAL, enabled: false } }, context)).toEqual({
            kind: "raise",
            title: "Run an automation unattended: Bun 1.4.3 is published",
            subject: {
                kind: "automation",
                automation: { ...PROPOSAL, target: { kind: "conversation", conversationId: "rapid-ridge" } },
                firstCheck: { pass: false, saw: "no published version of bun satisfies >=1.4.3 yet (latest is 1.4.2)", at: 5 },
            },
        });
    });

    it("refuses what the Automations page would refuse, before any card goes up", async () => {
        const { kind, state } = harness();
        state.problem = "a new agent needs a model to run on: pick at least one";
        expect(await kind.resolve({ kind: "automation", automation: PROPOSAL }, context)).toEqual({
            kind: "refused",
            code: "invalid_automation",
            message: "Nothing was proposed: a new agent needs a model to run on: pick at least one. Fix that and propose it again.",
        });
    });

    it("says when approving would replace an automation already there", async () => {
        const { kind, state } = harness();
        state.existing.add("bun-1-4-3");
        const resolved = await kind.resolve({ kind: "automation", automation: PROPOSAL }, context);
        expect(resolved).toMatchObject({
            kind: "raise",
            title: "Replace the automation bun-1-4-3: Bun 1.4.3 is published",
            subject: { replaces: true },
        });
    });

    it("saves it on approval, checked again, and refuses the yes when the world moved under it", async () => {
        const { kind, saved, state } = harness();
        const subject = {
            kind: "automation" as const,
            automation: { ...PROPOSAL, target: { kind: "conversation" as const, conversationId: "rapid-ridge" } },
        };
        expect(await kind.answer(needOf(subject), { kind: "approve" }, { email: undefined })).toMatchObject({
            status: "met",
            result: "The automation bun-1-4-3 is saved and switched on.",
        });
        expect(saved).toEqual([subject.automation]);
        state.problem = "there is no conversation rapid-ridge to continue";
        expect(await kind.answer(needOf(subject), { kind: "approve" }, { email: undefined })).toEqual({
            refused: "It cannot be saved as proposed: there is no conversation rapid-ridge to continue.",
        });
        expect(saved).toHaveLength(1);
    });

    it("is never met by anything but an approval", async () => {
        const { kind } = harness();
        expect(await kind.check(needOf({ kind: "automation", automation: PROPOSAL }))).toBeUndefined();
        expect(kind.key({ kind: "automation", automation: PROPOSAL })).toBe("bun-1-4-3");
    });
});
