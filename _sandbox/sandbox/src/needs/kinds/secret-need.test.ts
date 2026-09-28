import { type Need, PersonaPowersSchema } from "@intentic/sandbox-contract";
import type { TurnStanding } from "../../conversations/actor/turn-standing.js";
import type { NamedSecret } from "../../secrets/secret-registry.js";
import { secretNeed } from "./secret-need.js";

// A secret the task needs: asked for by name, pasted by a person into the card, stored where its reference resolves,
// and never carried anywhere the agent reads.

const STANDING: TurnStanding = {
    at: 0,
    unattended: false,
    persona: undefined,
    granted: [],
    withheldByPersona: [],
    withheldByGate: [],
    fence: undefined,
    powers: PersonaPowersSchema.parse({}),
    runtime: "claude-code",
    secrets: "masked",
};

const harness = (stored: NamedSecret[] = []) => {
    const kept: { name: string; value: string }[] = [];
    const kind = secretNeed({
        registry: async () => stored,
        keep: async (name, value) => {
            kept.push({ name, value });
        },
    });
    return { kind, kept, stored };
};

const needOf = (subject: Need["subject"]): Need => ({ id: "need-1", conversationId: "conv-1", subject, title: "", status: "open", createdAt: 1, updatedAt: 1 });
const context = { conversationId: "conv-1", standing: STANDING };

describe("secret need", () => {
    it("answers with the reference when it is already stored, and says how to ask for a replacement", async () => {
        const { kind } = harness([{ name: "OPENAI_API_KEY", value: "sk-stored", source: "sandbox" }]);
        expect(await kind.resolve({ kind: "secret", name: "OPENAI_API_KEY" }, context)).toEqual({
            kind: "met",
            message:
                "OPENAI_API_KEY is already stored. Write {{secret:OPENAI_API_KEY}} where the value goes (a command, a header, an env assignment): the sandbox fills it in at execution, and it never appears in what you read. If the service refuses it, ask again with --replace.",
        });
    });

    it("raises a card for a missing one, carrying where it goes, where to get one and what it looks like", async () => {
        const { kind } = harness();
        const answer = await kind.resolve(
            { kind: "secret", name: "OPENAI_API_KEY", where: "the Authorization header", link: "https://platform.openai.com/api-keys", hint: "starts with sk-" },
            context,
        );
        expect(answer).toEqual({
            kind: "raise",
            title: "The OPENAI_API_KEY secret",
            subject: { kind: "secret", name: "OPENAI_API_KEY", where: "the Authorization header", link: "https://platform.openai.com/api-keys", hint: "starts with sk-" },
        });
    });

    it("asks for a replacement even though one is stored, and is not met by the old value existing", async () => {
        const { kind } = harness([{ name: "NPM_TOKEN", value: "old", source: "env" }]);
        const answer = await kind.resolve({ kind: "secret", name: "NPM_TOKEN", replace: true }, context);
        expect(answer).toMatchObject({ kind: "raise", title: "A new value for NPM_TOKEN", subject: { replace: true } });
        expect(await kind.check(needOf({ kind: "secret", name: "NPM_TOKEN", replace: true }))).toBeUndefined();
    });

    it("is met once the name resolves, however it got there", async () => {
        const { kind, stored } = harness();
        const need = needOf({ kind: "secret", name: "STRIPE_KEY" });
        expect(await kind.check(need)).toBeUndefined();
        stored.push({ name: "STRIPE_KEY", value: "sk_test", source: "env" });
        expect(await kind.check(need)).toMatchObject({ result: "STRIPE_KEY is stored." });
    });

    it("stores a given value under the asked name, and says so without the value", async () => {
        const { kind, kept } = harness();
        const met = await kind.provide(needOf({ kind: "secret", name: "STRIPE_KEY" }), "sk_live_never_shown");
        expect(kept).toEqual([{ name: "STRIPE_KEY", value: "sk_live_never_shown" }]);
        expect(met.result).toBe("STRIPE_KEY is stored.");
        expect(JSON.stringify(met)).not.toContain("sk_live_never_shown");
    });

    it("takes a person's word that it was stored elsewhere only when the store agrees", async () => {
        const { kind, stored } = harness();
        const need = needOf({ kind: "secret", name: "STRIPE_KEY" });
        expect(await kind.answer(need, { kind: "apply" }, { email: "owner@acme.dev" })).toEqual({
            refused: "STRIPE_KEY is not stored yet: paste its value into the card, or add it on the Secrets view.",
        });
        stored.push({ name: "STRIPE_KEY", value: "sk", source: "sandbox" });
        expect(await kind.answer(need, { kind: "apply" }, { email: "owner@acme.dev" })).toMatchObject({ status: "met" });
    });

    it("tells a runtime that fills in no references the truth about where the value can be used", async () => {
        const { kind } = harness([{ name: "OPENAI_API_KEY", value: "sk", source: "sandbox" }]);
        const answer = await kind.resolve({ kind: "secret", name: "OPENAI_API_KEY" }, { conversationId: "conv-1", standing: { ...STANDING, runtime: "codex", secrets: "none" } });
        expect(answer.kind === "met" ? answer.message : "").toContain("does not fill in {{secret:…}} references");
    });
});
