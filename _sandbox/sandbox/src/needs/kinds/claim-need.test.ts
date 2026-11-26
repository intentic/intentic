import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import type { ClaimHolder } from "../../account-routing/project-claims.js";
import { projectOfRemote } from "../../account-routing/account-outbox.js";
import { claimNeed } from "./claim-need.js";

// A project claimed for this sandbox, which only the owner's own platform sign-in can make: the agent's ask raises the
// card (or is met at once when the sandbox already claims it), the owner's press asks the platform from their browser,
// and the answer only confirms the platform now lists it. The platform's directory is a set standing in for it here.

const OWNER = "owner@example.com";

const harness = (options: { readonly mine?: readonly string[]; readonly holder?: ClaimHolder; readonly reachable?: boolean } = {}) => {
    const mine = new Set(options.mine ?? []);
    const kind = claimNeed({
        normalize: projectOfRemote,
        claimedHere: async () => (options.reachable === false ? { ok: false, problem: "the platform could not be reached" } : { ok: true, projects: [...mine] }),
        holder: async () => options.holder ?? { state: "none" },
        ownerEmail: async () => OWNER,
    });
    return { kind, mine };
};

const needOf = (subject: Need["subject"]): Need => ({ id: "need-1", conversationId: "conv-1", subject, title: "", status: "open", createdAt: 1, updatedAt: 1 });
const context = { conversationId: "conv-1", standing: undefined };

describe("claimNeed", () => {
    it("raises a card naming the project as the platform keys it, from any remote URL of it", async () => {
        const { kind } = harness();
        const resolved = await kind.resolve({ kind: "claim", project: "git@github.com:Acme/App.git" }, context);
        expect(resolved).toEqual({ kind: "raise", subject: { kind: "claim", project: "github.com/acme/app" }, title: "Claim github.com/acme/app for this sandbox" });
    });

    it("says which sandbox holds it now, so the card says the claim moves", async () => {
        const { kind } = harness({ holder: { state: "other", name: "billing" } });
        const resolved = await kind.resolve({ kind: "claim", project: "github.com/acme/app" }, context);
        expect(resolved).toMatchObject({ kind: "raise", subject: { heldBy: "billing" }, title: "Claim github.com/acme/app here, from billing" });
    });

    it("is met at once when this sandbox already claims it", async () => {
        const { kind } = harness({ mine: ["github.com/acme/app"] });
        expect(await kind.resolve({ kind: "claim", project: "https://github.com/acme/app" }, context)).toMatchObject({ kind: "met" });
    });

    it("refuses what names no repository, and a platform it cannot ask", async () => {
        expect(await harness().kind.resolve({ kind: "claim", project: "not a repo" }, context)).toMatchObject({ kind: "refused", code: "invalid_project" });
        expect(await harness({ reachable: false }).kind.resolve({ kind: "claim", project: "github.com/acme/app" }, context)).toMatchObject({
            kind: "refused",
            code: "platform",
        });
    });

    it("is met by the owner's press only once the platform lists it, and never by anyone else's", async () => {
        const { kind, mine } = harness();
        const need = needOf({ kind: "claim", project: "github.com/acme/app" });
        expect(await kind.answer(need, { kind: "approve" }, { email: "member@example.com" })).toMatchObject({ refused: expect.stringContaining("owner") });
        expect(await kind.answer(need, { kind: "approve" }, { email: OWNER })).toMatchObject({ refused: expect.stringContaining("does not list") });
        mine.add("github.com/acme/app");
        expect(await kind.answer(need, { kind: "approve" }, { email: "OWNER@example.com" })).toMatchObject({ status: "met" });
    });

    it("is met by its check however the claim was made, and keyed by the project", async () => {
        const { kind, mine } = harness();
        const need = needOf({ kind: "claim", project: "github.com/acme/app" });
        expect(await kind.check(need)).toBeUndefined();
        mine.add("github.com/acme/app");
        expect(await kind.check(need)).toMatchObject({ result: expect.stringContaining("github.com/acme/app") });
        expect(kind.key(need.subject)).toBe("github.com/acme/app");
    });
});
