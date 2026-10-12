import { createHmac } from "node:crypto";
import { brokerSessionsFrom } from "../capabilities/broker/broker-session.js";
import { sessionTokensFrom } from "../privacy/gateway/session-token.js";
import { signedPayloads } from "./signed-payload.js";
import { z } from "zod";

// The codec both address signers share. The privacy gateway's tokens must stay byte for byte what the code before it
// signed, or every address a runtime already holds stops verifying; the broker's must never pass as one of them.

const KEY = Buffer.alloc(32, 7);
const readKey = async (): Promise<Buffer> => KEY;

// The signature the code before the codec computed, written out here rather than called, so a change to the codec
// cannot move the expectation with it: HMAC-SHA256 over the bare payload, base64url, the first 32 characters.
const oldSignature = (payload: string, prefix = ""): string =>
    createHmac("sha256", KEY).update(`${prefix}${payload}`).digest("base64url").slice(0, 32);

const payloadOf = (wire: unknown): string => Buffer.from(JSON.stringify(wire)).toString("base64url");

describe("the privacy gateway's tokens", () => {
    test("are signed exactly as before the codec, so addresses already issued keep verifying", async () => {
        const tokens = sessionTokensFrom(readKey);
        const wire = { p: "claude", u: "https://api.anthropic.com", c: "c-1", k: true };
        const issued = `${payloadOf(wire)}.${oldSignature(payloadOf(wire))}`;
        expect(await tokens.sign({ provider: "claude", upstream: "https://api.anthropic.com", conversationId: "c-1", clearing: true })).toBe(issued);
        expect(await tokens.verify(issued)).toEqual({ provider: "claude", upstream: "https://api.anthropic.com", conversationId: "c-1", clearing: true });
    });
});

describe("the broker's addresses", () => {
    const wire = { i: "github", r: 0, u: "https://api.github.com/" };

    test("sign under the broker: domain", async () => {
        const token = await brokerSessionsFrom(readKey).sign({ capability: "github", route: 0, upstream: "https://api.github.com/" });
        expect(token).toBe(`${payloadOf(wire)}.${oldSignature(payloadOf(wire), "broker:")}`);
    });

    test("do not take a token signed without the domain over the same payload and key", async () => {
        const undomained = await signedPayloads(readKey, z.unknown()).sign(wire);
        expect(undomained).toBe(`${payloadOf(wire)}.${oldSignature(payloadOf(wire))}`);
        expect(await brokerSessionsFrom(readKey).verify(undomained)).toBeUndefined();
    });

    test("refuse an empty payload, even one signed under the key", async () => {
        const sessions = brokerSessionsFrom(readKey);
        expect(await sessions.verify(`.${oldSignature("", "broker:")}`)).toBeUndefined();
        expect(await sessions.verify(".")).toBeUndefined();
    });

    test("derive a tag under its own tag: domain", async () => {
        const sessions = brokerSessionsFrom(readKey);
        expect(await sessions.tag("x")).toBe(createHmac("sha256", KEY).update("tag:x").digest("base64url").slice(0, 12));
    });
});

describe("signedPayloads", () => {
    const schema = z.object({ n: z.number() });

    test("reads its key once, and asks again after a read that failed", async () => {
        let reads = 0;
        const codec = signedPayloads(
            async () => {
                reads += 1;
                if (reads === 1) {
                    throw new Error("not yet");
                }
                return KEY;
            },
            schema,
            { domain: "d:" },
        );
        await expect(codec.sign({ n: 1 })).rejects.toThrow("not yet");
        const token = await codec.sign({ n: 1 });
        expect(await codec.verify(token)).toEqual({ n: 1 });
        expect(reads).toBe(2);
    });

    test("refuses a payload the schema does not accept, a changed signature, and extra segments", async () => {
        const codec = signedPayloads(readKey, schema);
        const textualNumber = `${payloadOf({ n: "one" })}.${oldSignature(payloadOf({ n: "one" }))}`;
        expect(await codec.verify(textualNumber)).toBeUndefined();
        const token = await codec.sign({ n: 2 });
        expect(await codec.verify(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeUndefined();
        expect(await codec.verify(`${token}.x`)).toBeUndefined();
        expect(await codec.verify(token)).toEqual({ n: 2 });
    });
});
