import { type DeployGrant, StackSpecSchema } from "@intentic/sandbox-contract/schemas/deploys";
import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import { ORPCError } from "@orpc/server";
import { deployNeed } from "./deploy-need.js";

// A managed stack let receive the secrets its manifest reads: the agent asks by repository and stack, the daemon reads
// the manifest for the computer and the names, and only a person signed in with the owner's reach may press it, which
// grants exactly what the card showed. The manifest and the grants file are memory here.

const WEB = StackSpecSchema.parse({ name: "web", device: "rog", env: { A: "{{secret:API_TOKEN}}", B: "{{secret:DB_URL}}" } });

const harness = (held: readonly DeployGrant[] = []) => {
    const grants = [...held];
    const kind = deployNeed({
        stackAtHead: async (ref) => {
            if (ref.stack !== "web") {
                throw new ORPCError("NOT_FOUND", { message: `"${ref.repo}" at its last commit does not declare "${ref.stack}": it declares web.` });
            }
            return WEB;
        },
        grantFor: async (repo, stack, device) => grants.find((grant) => grant.repo === repo && grant.stack === stack && grant.device === device),
        grant: async (grant) => {
            const kept = { ...grant, grantedAt: "2026-11-25T12:00:00.000Z" };
            grants.push(kept);
            return kept;
        },
    });
    return { kind, grants };
};

const context = { conversationId: "conv-1", standing: undefined };
const ASK = { kind: "deploy" as const, repo: "shop", stack: "web" };

describe("deployNeed", () => {
    it("raises a card naming the computer and every name the stack reads, the ones not granted yet marked", async () => {
        const { kind } = harness([{ repo: "shop", stack: "web", device: "rog", secrets: ["API_TOKEN"], grantedAt: "2026-11-24T00:00:00.000Z" }]);
        expect(await kind.resolve(ASK, context)).toEqual({
            kind: "raise",
            subject: { kind: "deploy", repo: "shop", stack: "web", device: "rog", secrets: ["API_TOKEN", "DB_URL"], ungranted: ["DB_URL"] },
            title: "Let web on rog receive the secret DB_URL",
        });
    });

    it("is met at once when the grant on file covers them, and refuses a stack the repository does not declare", async () => {
        const { kind } = harness([{ repo: "shop", stack: "web", device: "rog", secrets: ["API_TOKEN", "DB_URL"], grantedAt: "2026-11-24T00:00:00.000Z" }]);
        expect(await kind.resolve(ASK, context)).toEqual({ kind: "met", message: `"web" on "rog" may receive API_TOKEN, DB_URL.` });
        expect(await kind.resolve({ ...ASK, stack: "api" }, context)).toEqual({
            kind: "refused",
            code: "invalid_stack",
            message: `Nothing was asked: "shop" at its last commit does not declare "api": it declares web.`,
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
        expect(grants).toEqual([]);
        expect(await kind.check(need)).toBeUndefined();

        expect(await kind.answer(need, { kind: "approve" }, { email: "owner@example.com", maintainer: true })).toEqual({
            status: "met",
            result: `"web" on "rog" may receive API_TOKEN, DB_URL.`,
            use: ["Deploy it: `deploys deploy shop web`."],
        });
        expect(grants).toEqual([
            { repo: "shop", stack: "web", device: "rog", secrets: ["API_TOKEN", "DB_URL"], grantedBy: "owner@example.com", grantedAt: "2026-11-25T12:00:00.000Z" },
        ]);
        expect(await kind.check(need)).toMatchObject({ result: `"web" on "rog" may receive API_TOKEN, DB_URL.` });
        expect(kind.key(need.subject)).toBe("shop:web:rog");
    });
});
