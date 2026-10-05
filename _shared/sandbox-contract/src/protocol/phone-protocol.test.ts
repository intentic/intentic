import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { OkSchema } from "../schemas/shared.js";
import { PhoneFactsSchema, PhoneScopesSchema } from "../schemas/phone.js";
import { PHONE_ERROR, PhoneHelloSchema, PhoneRequestSchema, PhoneResponseSchema } from "./phone-protocol.js";
import { parsePhonePairingCode, phoneConnectUrl, phoneEnrollUrl, phonePairingCode, phonePairingLink } from "./phone-links.js";

// The phone door's wire as examples, spelled once here: golden/phone-wire.json is this file's `wire` as JSON, and both
// far ends test against it — the daemon's JSON-RPC link (_sandbox/sandbox/src/phones/json-rpc-link.test.ts) sends
// exactly each `request` for its `call` and resolves each `response` to `resolves`, and the Android app's tests
// (_devices/android) parse every request and answer in the same shapes. A change here the committed file does not carry
// fails, naming the file; `INTENTIC_WRITE_GOLDEN=1` rewrites it.

const GOLDEN = join(packageRoot(import.meta.url), "golden", "phone-wire.json");

const facts = PhoneFactsSchema.parse({
    device: "Google Pixel 8",
    android: "16",
    sdk: 36,
    build: "direct",
    paused: false,
    access: { accessibility: true, notifications: false, screenCapture: "accessibility" },
    folders: [{ name: "Download", writable: true }],
    apps: [{ package: "com.android.chrome", label: "Chrome", mode: "act" }],
    battery: { level: 81, charging: false },
    wake: { fcm: "fcm-token-example" },
    features: ["touch", "notifications"],
});

const scopes = { ...PhoneScopesSchema.parse({}), platform: "android" };

const toolsList = {
    tools: [
        {
            name: "screenshot",
            description: "What the phone's screen shows now, as an image with a frame id.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true },
        },
    ],
};

const callResult = { content: [{ type: "text", text: 'Tapped [e4] "Send".' }] };

const wire = {
    hello: PhoneHelloSchema.parse({ type: "hello", token: "iph_example-enrollment-token", version: "1.0.0" }),
    exchanges: [
        {
            name: "describe",
            call: { path: ["describe"] },
            request: { jsonrpc: "2.0", id: 0, method: "describe" },
            response: { jsonrpc: "2.0", id: 0, result: facts },
            resolves: facts,
        },
        {
            name: "setScopes",
            call: { path: ["setScopes"], input: scopes },
            request: { jsonrpc: "2.0", id: 1, method: "setScopes", params: scopes },
            response: { jsonrpc: "2.0", id: 1, result: OkSchema.parse({ ok: true }) },
            resolves: { ok: true },
        },
        {
            name: "ping",
            call: { path: ["ping"] },
            request: { jsonrpc: "2.0", id: 2, method: "ping" },
            response: { jsonrpc: "2.0", id: 2, result: { ok: true } },
            resolves: { ok: true },
        },
        {
            name: "mcp tools/list",
            call: { path: ["mcp"], input: { jsonrpc: "2.0", id: "phones-tools", method: "tools/list", params: {} } },
            request: { jsonrpc: "2.0", id: 3, method: "mcp", params: { jsonrpc: "2.0", id: "phones-tools", method: "tools/list", params: {} } },
            response: { jsonrpc: "2.0", id: 3, result: { jsonrpc: "2.0", id: "phones-tools", result: toolsList } },
            resolves: { jsonrpc: "2.0", id: "phones-tools", result: toolsList },
        },
        {
            name: "mcp tools/call",
            call: {
                path: ["mcp"],
                input: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ui_act", arguments: { ref: "e4", action: "tap" } } },
            },
            request: {
                jsonrpc: "2.0",
                id: 4,
                method: "mcp",
                params: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ui_act", arguments: { ref: "e4", action: "tap" } } },
            },
            response: { jsonrpc: "2.0", id: 4, result: { jsonrpc: "2.0", id: 9, result: callResult } },
            resolves: { jsonrpc: "2.0", id: 9, result: callResult },
        },
        {
            name: "refused",
            call: { path: ["describe"] },
            request: { jsonrpc: "2.0", id: 5, method: "describe" },
            response: { jsonrpc: "2.0", id: 5, error: { code: PHONE_ERROR.refused, message: "The person paused the agent on this phone." } },
            rejects: "The person paused the agent on this phone.",
        },
    ],
};

test("every example frame is one the protocol's schemas accept", () => {
    for (const exchange of wire.exchanges) {
        expect(PhoneRequestSchema.safeParse(exchange.request).success).toBe(true);
        expect(PhoneResponseSchema.safeParse(exchange.response).success).toBe(true);
        expect(exchange.request.id).toBe(exchange.response.id);
    }
});

test("golden/phone-wire.json is the protocol's example, as the app reads it", () => {
    const expected = `${JSON.stringify(wire, undefined, 2)}\n`;
    if (process.env["INTENTIC_WRITE_GOLDEN"] === "1") {
        writeFileSync(GOLDEN, expected);
    }
    expect(readFileSync(GOLDEN, "utf8")).toBe(expected);
});

test("a pairing round-trips as a code and as the link the QR carries", () => {
    const pairing = { url: "https://sandbox-abc.sbx.intentic.dev", token: "one-time" };
    expect(parsePhonePairingCode(phonePairingCode(pairing))).toEqual(pairing);
    expect(parsePhonePairingCode(phonePairingLink(pairing))).toEqual(pairing);
    expect(phonePairingLink(pairing).startsWith("https://intentic.dev/phone/pair#ixp1_")).toBe(true);
    expect(parsePhonePairingCode(phonePairingLink(pairing).replace("/pair#", "/pair/#"))).toEqual(pairing);
});

test("a code that is not ours, or carries no usable url or token, is refused rather than attempted", () => {
    expect(parsePhonePairingCode("ixb1_abc")).toBeUndefined();
    expect(parsePhonePairingCode("ixp1_not-base64!")).toBeUndefined();
    expect(parsePhonePairingCode(phonePairingCode({ url: "ftp://x", token: "t" }))).toBeUndefined();
    expect(parsePhonePairingCode(phonePairingCode({ url: "https://x", token: "" }))).toBeUndefined();
});

test("the phone dials and enrolls at the sandbox's own address", () => {
    expect(phoneConnectUrl("https://sandbox-abc.sbx.intentic.dev/")).toBe("wss://sandbox-abc.sbx.intentic.dev/system/phones/connect");
    expect(phoneEnrollUrl("https://sandbox-abc.sbx.intentic.dev")).toBe("https://sandbox-abc.sbx.intentic.dev/system/phones/enroll");
});
