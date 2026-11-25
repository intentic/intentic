import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import { RolePowersSchema } from "@intentic/sandbox-contract/schemas/roles";
import type { TurnStanding } from "../../conversations/actor/turn-standing.js";
import type { NamedSecret } from "../../secrets/secret-registry.js";
import { secretNeed } from "./secret-need.js";

// A secret the task needs: asked for by name, pasted by a person into the card, stored where its reference resolves,
// and never carried anywhere the agent reads.

const STANDING: TurnStanding = {
    at: 0,
    unattended: false,
    role: undefined,
    granted: [],
    withheldByRole: [],
    withheldByGate: [],
    withheldByReach: [],
    fence: undefined,
    powers: RolePowersSchema.parse({}),
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

    it("asks for a value with lines in a box with lines, keeps it exactly, and points the agent at the file form", async () => {
        const { kind, kept } = harness();
        const answer = await kind.resolve({ kind: "secret", name: "DEV_ENV", multiline: true }, context);
        expect(answer).toEqual({ kind: "raise", title: "The DEV_ENV secret", subject: { kind: "secret", name: "DEV_ENV", multiline: true } });
        const met = await kind.provide(needOf({ kind: "secret", name: "DEV_ENV", multiline: true }), "A=1\nB='two words'\n");
        expect(kept).toEqual([{ name: "DEV_ENV", value: "A=1\nB='two words'\n" }]);
        expect(met.use.join(" ")).toContain("{{secret:DEV_ENV|file}}");
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
        const { kind } = harness([{ name: "NPM_TOKEN", value: "old", source: "sandbox" }]);
        const answer = await kind.resolve({ kind: "secret", name: "NPM_TOKEN", replace: true }, context);
        expect(answer).toMatchObject({ kind: "raise", title: "A new value for NPM_TOKEN", subject: { replace: true } });
        expect(await kind.check(needOf({ kind: "secret", name: "NPM_TOKEN", replace: true }))).toBeUndefined();
    });

    it("is met once the name resolves, however it got there", async () => {
        const { kind, stored } = harness();
        const need = needOf({ kind: "secret", name: "STRIPE_KEY" });
        expect(await kind.check(need)).toBeUndefined();
        stored.push({ name: "STRIPE_KEY", value: "sk_test", source: "sandbox" });
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

    it("sends a value to be kept on a computer to that computer's keyring, and stores nothing in the sandbox", async () => {
        const sent: { name: string; value: string; device: string; mode: string }[] = [];
        const kept: string[] = [];
        const kind = secretNeed({
            registry: async () => [],
            keep: async (name) => void kept.push(name),
            keepOn: async (name, value, keepOn) => {
                sent.push({ name, value, ...keepOn });
                return { pending: true };
            },
        });
        const met = await kind.provide(needOf({ kind: "secret", name: "VPN_PASSWORD", hosts: ["vpn.example.com"] }), "vpn-value-never-shown", {
            keepOn: { device: "rog", mode: "each-use" },
            // A computer's keyring keeps its own list, so the card's hosts are not read for it.
            hosts: ["vpn.example.com"],
        });
        expect(met).toEqual({
            result:
                "VPN_PASSWORD was sent to the keyring on rog, where it waits for that computer's next unlock: once a person there unlocks the keyring and says yes, it is kept there and shared with this sandbox. Nothing was stored in the sandbox.",
            use: ["Write {{secret:VPN_PASSWORD}} where the value goes: each use asks the keyring on rog for it, and a person there says yes every time, so that computer has to be on."],
        });
        expect([sent, kept]).toEqual([[{ name: "VPN_PASSWORD", value: "vpn-value-never-shown", device: "rog", mode: "each-use" }], []]);
        expect(JSON.stringify(met)).not.toContain("vpn-value-never-shown");
    });

    it("carries the hosts the agent proposed onto the card, each once", async () => {
        const { kind } = harness();
        expect(await kind.resolve({ kind: "secret", name: "STRIPE_KEY", hosts: ["api.stripe.com", "files.stripe.com", "api.stripe.com"] }, context)).toMatchObject({
            kind: "raise",
            subject: { hosts: ["api.stripe.com", "files.stripe.com"] },
        });
    });

    // The order of events a guard start and a store make, and what the guard was started with.
    const guarded = (start: "started" | "kept" | "failed") => {
        const steps: string[] = [];
        const kind = secretNeed({
            registry: async () => [],
            keep: async (name) => void steps.push(`keep ${name}`),
            startGuard: async (name, hosts) => {
                steps.push(`guard ${name} ${hosts.join(",")}`);
                return start;
            },
        });
        return { kind, steps };
    };
    const proposed = needOf({ kind: "secret", name: "STRIPE_KEY", hosts: ["api.stripe.com", "files.stripe.com"] });

    it("starts the guard with the hosts the person kept, before the value is stored, and never with one nobody proposed", async () => {
        const { kind, steps } = guarded("started");
        const met = await kind.provide(proposed, "sk_live_never_shown", { hosts: ["api.stripe.com", "evil.example"] });
        expect(steps).toEqual(["guard STRIPE_KEY api.stripe.com", "keep STRIPE_KEY"]);
        expect(met.result).toBe("STRIPE_KEY is stored. Its host guard is on: it goes unasked only to api.stripe.com, and a use anywhere else asks a person first.");
    });

    it("leaves the guard alone when the person kept no host, and says what became of one already on or not written", async () => {
        const none = guarded("started");
        expect((await none.kind.provide(proposed, "sk", { hosts: [] })).result).toBe("STRIPE_KEY is stored.");
        expect(none.steps).toEqual(["keep STRIPE_KEY"]);
        expect((await guarded("kept").kind.provide(proposed, "sk", { hosts: ["api.stripe.com"] })).result).toBe(
            "STRIPE_KEY is stored. STRIPE_KEY already had its host guard on, which was left as it is: `secrets hosts STRIPE_KEY` shows where it may go.",
        );
        expect((await guarded("failed").kind.provide(proposed, "sk", { hosts: ["api.stripe.com"] })).result).toBe(
            "STRIPE_KEY is stored. Its host guard could not be set, so it is off: `secrets hosts STRIPE_KEY on` turns it on.",
        );
    });

    it("counts a name a computer's keyring shares as stored, so an ask for it is met, not raised", async () => {
        const kind = secretNeed({ registry: async () => [], keep: async () => {}, deviceHeld: async () => ["VPN_PASSWORD"] });
        expect(await kind.resolve({ kind: "secret", name: "VPN_PASSWORD" }, context)).toMatchObject({ kind: "met" });
    });
});
