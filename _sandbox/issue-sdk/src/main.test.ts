import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { breadcrumb, captureException, init, openReportDialog, report } from "./main.js";

// The module-level entry a host page calls: one client per page, and nothing it exposes may reject into the host's own
// error handling.

afterEach(() => {
    unstubAllGlobals();
    jest.restoreAllMocks();
});

const asleep = (): void => {
    stubGlobal(
        "fetch",
        jest.fn(async () => {
            throw new TypeError("Failed to fetch");
        }),
    );
};

const awake = (): void => {
    stubGlobal(
        "fetch",
        jest.fn(async (input: RequestInfo | URL) =>
            String(input).endsWith("/config")
                ? new Response(
                      JSON.stringify({
                          automationId: "bugs",
                          title: "Report a problem",
                          prompt: "What went wrong?",
                          thanks: "Thanks",
                          askEmail: false,
                          accent: "#e47100",
                          captureCrashes: false,
                          antiBot: "off",
                      }),
                      { status: 200 },
                  )
                : new Response(JSON.stringify({ ok: true, id: "4f3a1b2c" }), { status: 200 }),
        ),
    );
};

const OPTIONS = { automationId: "bugs", base: "https://sandbox.example" };

// One test, in order: the module keeps a single client for the page, so the failed start and the retry are one story.
test("a sandbox asleep at page load fails the start without breaking the page, and a later init starts it", async () => {
    asleep();
    await expect(init(OPTIONS)).rejects.toThrow("Failed to fetch");
    await expect(captureException(new Error("boom"))).resolves.toBeUndefined();
    await expect(report({ description: "it broke" })).resolves.toBeUndefined();
    await expect(breadcrumb("nav", "/checkout")).resolves.toBeUndefined();
    await expect(openReportDialog()).resolves.toBeUndefined();

    awake();
    const client = await init(OPTIONS);
    try {
        expect(await init(OPTIONS)).toBe(client);
        expect(await captureException(new Error("boom"))).toBe("4f3a1b2c");
    } finally {
        client.stop();
    }
});
