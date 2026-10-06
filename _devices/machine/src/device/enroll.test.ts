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

// The answer was once cast unchecked: a body without a token came back as `token: undefined` and was written into the
// device's config, to fail every later dial as unauthorized.
test("an answer without a token is refused rather than stored", async () => {
    stubGlobal("fetch", jest.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { id: "omen" })));
    await expect(enroll("https://sandbox-abc.example.dev/", "pair-token")).rejects.toThrow(
        "connecting this device failed: the sandbox's answer is not an enrollment",
    );
});

test("a 401 is the expired pairing, said once and not retried", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(jsonResponse(401, { error: "expired" }));
    stubGlobal("fetch", fetchMock);
    await expect(enroll("https://sandbox-abc.example.dev/", "pair-token")).rejects.toThrow("that pairing has expired");
    expect(fetchMock).toHaveBeenCalledTimes(1);
});
