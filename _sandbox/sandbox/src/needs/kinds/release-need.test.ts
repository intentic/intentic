import type { CredentialGate, Need } from "@intentic/sandbox-contract";
import { createCredentialGrants } from "../../secrets/credential-grants.js";
import { releaseNeed } from "./release-need.js";

// A gated account or connector released to the rest of a conversation: asked of the named approvers only, answered
// only by them, and recorded where the next turn's mount reads it.

const GATE: CredentialGate = { subject: "reddit-work", kind: "capability", approvers: ["Bob@acme.dev"], scope: "conversation" };

const harness = (gates: CredentialGate[] = [GATE], known: readonly string[] = ["reddit-work"]) => {
    const grants = createCredentialGrants();
    return { kind: releaseNeed({ gates: async () => gates, grants: () => grants, exists: async (subject) => known.includes(subject), now: () => 42 }), grants };
};

const context = { conversationId: "conv-1", standing: undefined };
const needOf = (subject: Need["subject"]): Need => ({ id: "need-1", conversationId: "conv-1", subject, title: "", status: "open", createdAt: 1, updatedAt: 1 });
const NEED = needOf({ kind: "release", subject: "reddit-work", approvers: ["Bob@acme.dev"] });

describe("release need", () => {
    it("refuses what is not gated, pointing at the persona instead", async () => {
        const answer = await harness([]).kind.resolve({ kind: "release", subject: "reddit-work" }, context);
        expect(answer).toMatchObject({ kind: "refused", code: "not_gated" });
        expect(answer.kind === "refused" ? answer.message : "").toContain("grants request capability reddit-work");
    });

    it("tells a name nothing goes by apart from one that is simply not gated, and says how to ask for it instead", async () => {
        const answer = await harness([], []).kind.resolve({ kind: "release", subject: "OPENAI_API_KEY" }, context);
        expect(answer).toMatchObject({ kind: "refused", code: "unknown" });
        expect(answer.kind === "refused" ? answer.message : "").toContain("ask for it with `secrets ask OPENAI_API_KEY`");
    });

    it("refuses a per-use gate, which is asked at the use itself", async () => {
        expect(await harness([{ ...GATE, scope: "use" }]).kind.resolve({ kind: "release", subject: "reddit-work" }, context)).toMatchObject({ kind: "refused", code: "per_use" });
    });

    it("raises a release naming the approvers, and answers met once it is released", async () => {
        const { kind, grants } = harness();
        expect(await kind.resolve({ kind: "release", subject: "reddit-work" }, context)).toEqual({
            kind: "raise",
            title: 'Release "reddit-work" to this conversation',
            subject: { kind: "release", subject: "reddit-work", approvers: ["Bob@acme.dev"] },
        });
        grants.grant("conv-1", "reddit-work", { approvedBy: "bob@acme.dev", at: 1 });
        expect(await kind.resolve({ kind: "release", subject: "reddit-work" }, context)).toMatchObject({ kind: "met" });
    });

    it("lets only a named approver answer, yes or no, whatever the case of their address", () => {
        const { kind } = harness();
        expect(kind.mayAnswer?.(NEED, { email: "eve@acme.dev" })).toBe("Only Bob@acme.dev can answer this.");
        expect(kind.mayAnswer?.(NEED, { email: undefined })).toBe("Only Bob@acme.dev can answer this.");
        expect(kind.mayAnswer?.(NEED, { email: "bob@ACME.dev" })).toBeUndefined();
    });

    it("records the release for the conversation and says it mounts on the next turn", async () => {
        const { kind, grants } = harness();
        expect(await kind.answer(NEED, { kind: "release" }, { email: "BOB@acme.dev" })).toEqual({
            status: "met",
            result: '"reddit-work" is released to this conversation by bob@acme.dev.',
            use: ["It mounts from the conversation's next turn: finish what you can now, and the sandbox continues the conversation with it."],
        });
        expect(grants.has("conv-1", "reddit-work")).toEqual({ approvedBy: "bob@acme.dev", at: 42 });
        expect(kind.nextTurn(NEED)).toBe(true);
    });
});
