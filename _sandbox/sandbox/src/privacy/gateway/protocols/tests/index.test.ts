import { protocolOf, restoreResponse, restoreStream, shieldRequest } from "../index.js";
import { fakeShield, restore } from "./fake-shield.testing.js";
import { runText } from "./stream.testing.js";

// The entry points the gateway's route calls: which wire format a path speaks, and what happens to a body that is not
// one the walkers know.

describe("the gateway protocols", () => {
    test("each harness's paths name their wire format, and nothing else does", () => {
        expect(protocolOf("/v1/messages")).toBe("anthropic");
        expect(protocolOf("/v1/messages/count_tokens")).toBe("anthropic");
        expect(protocolOf("/v1/responses")).toBe("responses");
        expect(protocolOf("/responses")).toBe("responses");
        // Codex compacts and counts through the same body shape; leaving them out would send them unmasked.
        expect(protocolOf("/responses/compact")).toBe("responses");
        expect(protocolOf("/v1/responses/input_tokens")).toBe("responses");
        expect(protocolOf("/v1/chat/completions")).toBe("chat");
        expect(protocolOf("/chat/completions")).toBe("chat");
        // A query string the caller forgot to strip does not change the answer.
        expect(protocolOf("/v1/messages?beta=true")).toBe("anthropic");
        for (const other of ["/v1/models", "/v1/messages/batches", "/v1/completions", "/v1/embeddings", "/", ""]) {
            expect(protocolOf(other)).toBeUndefined();
        }
    });

    test("a value JSON.parse could not have produced is refused, not half-walked", async () => {
        // Failing closed: a body the walkers cannot vouch for must not reach the provider as if it had been masked.
        await expect(shieldRequest("anthropic", { messages: [{ role: "user", content: undefined }] }, fakeShield())).rejects.toThrow(TypeError);
        await expect(shieldRequest("chat", new Map(), fakeShield())).rejects.toThrow(TypeError);
        expect(() => restoreResponse("responses", { output: [new Date(0)] }, restore)).toThrow(TypeError);
    });

    test("a body of an unexpected JSON shape passes through as a fresh copy or as it is", async () => {
        expect(await shieldRequest("anthropic", ["not", "a", "request"], fakeShield())).toEqual(["not", "a", "request"]);
        expect(await shieldRequest("chat", { model: "x" }, fakeShield())).toEqual({ model: "x" });
        expect(restoreResponse("chat", "plain text", restore)).toBe("plain text");
    });

    test("each stream gets its own state", async () => {
        // A transform shared between two responses would carry one's held tail into the other.
        const first = restoreStream("chat", restore);
        const second = restoreStream("chat", restore);
        expect(first).not.toBe(second);
        const output = await runText(first, 'data: {"choices":[{"index":0,"delta":{"content":"Hi ⟦PERSON_1⟧"}}]}\n\n');
        expect(output).toContain("Hi Jan Kowalski");
    });
});
