import { stubGlobal } from "@intentic/testing/bun";
import { enroll } from "./commands.js";

const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
    jest.restoreAllMocks();
});

test("a redeemed pairing answers the id and durable token the sandbox bound it to", async () => {
    stubGlobal("fetch", jest.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { id: "omen", token: "ihost_durable" })));
    expect(await enroll("https://sandbox-abc.example.dev/", "pair-token")).toEqual({ id: "omen", token: "ihost_durable" });
});

// The identity rides the redeem, so the sandbox writes the enrollment with this computer's real id rather than learning
// it at the first connect, which left a freshly paired machine as two cards until then.
test("the redeem carries which computer and which install is enrolling, as JSON beside the pairing header", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { id: "omen", token: "ihost_durable" }));
    stubGlobal("fetch", fetchMock);
    await enroll("https://sandbox-abc.example.dev/", "pair-token", { identity: { machineId: "m-0123456789", environment: "wsl:Ubuntu" } });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({ "content-type": "application/json", "x-intentic-pair": "pair-token" });
    expect(JSON.parse(String(init?.body))).toEqual({ machineId: "m-0123456789", environment: "wsl:Ubuntu" });
});

test("with no identity to say, the redeem still sends a body the sandbox reads as none", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { id: "omen", token: "ihost_durable" }));
    stubGlobal("fetch", fetchMock);
    await enroll("https://sandbox-abc.example.dev/", "pair-token");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe("{}");
});

// The answer was once cast unchecked: a body without a token came back as `token: undefined` and was written into the
// device's config, to fail every later dial as unauthorized.
test("an answer without a token is refused rather than stored", async () => {
    stubGlobal("fetch", jest.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { id: "omen" })));
    await expect(enroll("https://sandbox-abc.example.dev/", "pair-token")).rejects.toThrow("the sandbox's answer is not an enrollment");
});

test("a 401 is the expired pairing, said once and not retried", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(401, { error: "expired" }));
    stubGlobal("fetch", fetchMock);
    await expect(enroll("https://sandbox-abc.example.dev/", "pair-token")).rejects.toThrow("that pairing has expired");
    expect(fetchMock).toHaveBeenCalledTimes(1);
});
