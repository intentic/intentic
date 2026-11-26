import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import type { StackGrant } from "@intentic/sandbox-contract/schemas/stack-grants";
import { ORPCError } from "@orpc/server";
import { memoryStackGrants } from "../../secrets/stack-grants/stack-grants.js";
import { deployNeed } from "./deploy-need.js";

// A managed stack let receive some secrets: the agent asks by repository, stack, computer and names, the card shows
// which of them the stack holds already, and only a person signed in with the owner's reach may press it, which grants
// exactly what the card showed. The grants are memory here.

const AT = new Date("2026-11-25T12:00:00.000Z");

const harness = (held: readonly StackGrant[] = []) => {
    const grants = memoryStackGrants(held, () => AT);
    const kind = deployNeed({
        device: async (device) => {
            if (device !== "rog") {
                throw new ORPCError("BAD_REQUEST", { message: `"${device}" is not a computer paired with this sandbox: name one by its device card's id, as Devices lists it.` });
            }
            return { hostname: "rog-desktop" };
        },
        grantFor: (ref) => grants.forStack(ref),
        grant: (ref, secrets, by) => grants.add(ref, secrets, by),
    });
    return { kind, grants };
};

const context = { conversationId: "conv-1", standing: undefined };
const ASK = { kind: "deploy" as const, repo: "shop", stack: "web", device: "rog", secrets: ["DB_URL", "API_TOKEN", "DB_URL"] };

describe("deployNeed", () => {
    it("raises a card naming the computer and every name asked, the ones not granted yet marked", async () => {
        const { kind } = harness([{ repo: "shop", stack: "web", device: "rog", secrets: ["API_TOKEN"], grantedAt: "2026-11-24T00:00:00.000Z" }]);
        expect(await kind.resolve(ASK, context)).toEqual({
            kind: "raise",
            subject: { kind: "deploy", repo: "shop", stack: "web", device: "rog", deviceName: "rog-desktop", secrets: ["API_TOKEN", "DB_URL"], ungranted: ["DB_URL"] },
            title: "Let web on rog receive the secret DB_URL",
        });
    });

    it("is met at once when the grant on file covers them, and refuses a computer this sandbox is not paired with", async () => {
        const { kind } = harness([{ repo: "shop", stack: "web", device: "rog", secrets: ["API_TOKEN", "DB_URL"], grantedAt: "2026-11-24T00:00:00.000Z" }]);
        expect(await kind.resolve(ASK, context)).toEqual({ kind: "met", message: `"web" on "rog" may receive API_TOKEN, DB_URL.` });
        expect(await kind.resolve({ ...ASK, device: "omen" }, context)).toEqual({
            kind: "refused",
            code: "invalid_device",
            message: `Nothing was asked: "omen" is not a computer paired with this sandbox: name one by its device card's id, as Devices lists it.`,
        });
    });

    it("grants what the card showed only on a signed-in maintainer's press, and is then met", async () => {
        const { kind, grants } = harness();
        const resolved = await kind.resolve(ASK, context);
        if (resolved.kind !== "raise") {
            throw new Error(`expected a card, got ${resolved.kind}`);
        }
        const need: Need = { id: "need-1", conversationId: "conv-1", subject: resolved.subject, title: resolved.title, status: "open", createdAt: 1, updatedAt: 1 };

        expect(await kind.answer(need, { kind: "approve" }, { email: "agent@example.com" })).toEqual({
            refused: "Only the owner, or someone with Full access, signed in, can let a stack receive secrets.",
        });
        expect(await grants.list()).toEqual([]);
        expect(await kind.check(need)).toBeUndefined();

        expect(await kind.answer(need, { kind: "approve" }, { email: "owner@example.com", maintainer: true })).toEqual({
            status: "met",
            result: `"web" on "rog" may receive API_TOKEN, DB_URL.`,
            use: ["Deploy it again (the Deployments extension's deploy_environment): this sandbox now fills them into its .env."],
        });
        expect(await grants.list()).toEqual([
            { repo: "shop", stack: "web", device: "rog", secrets: ["API_TOKEN", "DB_URL"], grantedBy: "owner@example.com", grantedAt: AT.toISOString() },
        ]);
        expect(await kind.check(need)).toMatchObject({ result: `"web" on "rog" may receive API_TOKEN, DB_URL.` });
        expect(kind.key(need.subject)).toBe("shop:web:rog:API_TOKEN,DB_URL");
    });
});
