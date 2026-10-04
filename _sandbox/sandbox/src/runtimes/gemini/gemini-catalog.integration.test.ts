import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoogleModelAvailability } from "../../agent/providers/google-model-availability.js";
import { testConfig } from "../../testing.js";
import { createGeminiCatalog, selectGeminiModelForRequest } from "./gemini-catalog.js";
import type { GeminiModel } from "./gemini-models.js";

const OPUS_46: GeminiModel = { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6", inputModalities: ["text", "image"] };
const OPUS_55: GeminiModel = { id: "claude-opus-5-5-high", label: "Claude Opus 5.5", inputModalities: ["text", "image"] };
const SONNET_55: GeminiModel = { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5", inputModalities: ["text", "image"] };
const ALL = [OPUS_46, OPUS_55, SONNET_55];
const trees: string[] = [];

const verified = (models: readonly string[], accounts = 31): GoogleModelAvailability => ({ state: "verified", accounts, models });

const fixture = (options: { readonly stored?: readonly GeminiModel[]; readonly advertised?: readonly GeminiModel[] } = {}) => {
    const root = mkdtempSync(join(tmpdir(), "gemini-catalog-"));
    trees.push(root);
    const persistPath = join(root, "models.json");
    if (options.stored !== undefined) {
        writeFileSync(persistPath, JSON.stringify(options.stored));
    }
    let advertised: readonly GeminiModel[] | undefined = options.advertised ?? ALL;
    let availability = verified([OPUS_46.id]);
    const readAvailability = jest.fn(async () => availability);
    const requests = jest.fn(async (url: RequestInfo | URL): Promise<Response> => {
        if (advertised === undefined) {
            return new Response("unavailable", { status: 503 });
        }
        const body = String(url).endsWith("/v1beta/models")
            ? {
                  models: advertised.map((model) => ({
                      name: `models/${model.id}`,
                      displayName: model.label,
                      supportedInputModalities: model.inputModalities,
                  })),
              }
            : { data: advertised.map((model) => ({ id: model.id, owned_by: "antigravity" })) };
        return new Response(JSON.stringify(body));
    });
    const catalog = createGeminiCatalog(
        { ...testConfig, translator: { url: "http://127.0.0.1:8788", token: "local-test-token" } },
        persistPath,
        { googleModelAvailability: readAvailability },
        Object.assign(requests, { preconnect: () => undefined }),
    );
    return {
        catalog,
        requests,
        readAvailability,
        persistPath,
        advertise: (models: readonly GeminiModel[] | undefined) => {
            advertised = models;
        },
        report: (answer: GoogleModelAvailability) => {
            availability = answer;
        },
    };
};

const advanceCatalogClock = (): void => jest.setSystemTime(new Date(Date.now() + 61_000));

afterEach(() => {
    jest.useRealTimers();
    for (const tree of trees.splice(0)) {
        rmSync(tree, { recursive: true, force: true });
    }
});

test("cancelling one selection waiter leaves the shared availability refresh usable for another", async () => {
    const subject = fixture();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const proof = Promise.withResolvers<GoogleModelAvailability>();
    subject.readAvailability.mockImplementationOnce(async () => {
        started.resolve();
        return proof.promise;
    });
    const cancelled = selectGeminiModelForRequest(subject.catalog, OPUS_46.id, controller.signal).catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );
    const stillWaiting = subject.catalog.select(OPUS_46.id);
    await started.promise;
    controller.abort(new Error("one caller cancelled"));
    expect(await cancelled).toBe("one caller cancelled");
    proof.resolve(verified([OPUS_46.id]));
    expect(await stillWaiting).toEqual({ ok: true, model: OPUS_46.id });
    expect(subject.readAvailability).toHaveBeenCalledTimes(1);
    expect(subject.requests).toHaveBeenCalledTimes(2);
});

test("global Claude 5.5 advertisements do not enter the picker or default without account support", async () => {
    const { catalog } = fixture();
    expect(await catalog.models()).toEqual({ models: [OPUS_46], default: OPUS_46.id });
    expect(await catalog.live()).toEqual([OPUS_46]);
    expect(await catalog.select(OPUS_55.id)).toEqual({
        ok: false,
        code: "model-unavailable",
        message:
            "Google does not currently offer claude-opus-5-5-high through this sandbox's enabled account pool. Pick an available model explicitly, or send again if it becomes available.",
    });
    expect(await catalog.select(SONNET_55.id)).toEqual({
        ok: false,
        code: "model-unavailable",
        message:
            "Google does not currently offer claude-sonnet-5-5-high through this sandbox's enabled account pool. Pick an available model explicitly, or send again if it becomes available.",
    });
});

test("admits a newly available exact model and preserves its modalities without a seed change", async () => {
    const subject = fixture();
    expect(await subject.catalog.select()).toEqual({ ok: true, model: OPUS_46.id });
    subject.report(verified(ALL.map((model) => model.id)));
    advanceCatalogClock();
    expect(await subject.catalog.select(OPUS_55.id)).toEqual({ ok: true, model: OPUS_55.id });
    expect(await subject.catalog.select()).toEqual({ ok: true, model: OPUS_55.id });
    expect((await subject.catalog.models()).models.find((model) => model.id === OPUS_55.id)).toEqual(OPUS_55);
});

test("an authoritative exclusion defeats persisted frontier metadata before default ranking", async () => {
    const { catalog } = fixture({ stored: [OPUS_55, SONNET_55] });
    expect(await catalog.models()).toEqual({ models: [OPUS_46], default: OPUS_46.id });
    expect(await catalog.select()).toEqual({ ok: true, model: OPUS_46.id });
});

test("account negatives override a remembered row still inside the shared disappearance grace", async () => {
    const subject = fixture();
    subject.report(verified(ALL.map((model) => model.id)));
    expect(await subject.catalog.select()).toEqual({ ok: true, model: OPUS_55.id });
    subject.advertise([OPUS_46]);
    subject.report(verified([OPUS_46.id]));
    advanceCatalogClock();
    expect(await subject.catalog.models()).toEqual({ models: [OPUS_46], default: OPUS_46.id });
    // The display ladder really retained the rows; they are excluded by the selection boundary, not by expiring grace.
    expect(JSON.parse(readFileSync(subject.persistPath, "utf8"))).toEqual([OPUS_46, OPUS_55, SONNET_55]);
});

test("a grace row still offered by Google is excluded when the translator no longer advertises it", async () => {
    const subject = fixture();
    subject.report(verified(ALL.map((model) => model.id)));
    await subject.catalog.models();
    subject.advertise([OPUS_46]);
    advanceCatalogClock();
    expect(await subject.catalog.models()).toEqual({ models: [OPUS_46], default: OPUS_46.id });
    expect(await subject.catalog.select(OPUS_55.id)).toEqual({
        ok: false,
        code: "model-unavailable",
        message:
            "Google's model translator is not currently advertising claude-opus-5-5-high for this sandbox. Pick an available model explicitly, or send again if it becomes available.",
    });
});

test("verified empty membership stays empty instead of authorizing a persisted or seed model", async () => {
    const subject = fixture({ stored: [OPUS_55] });
    subject.report(verified([]));
    expect(await subject.catalog.models()).toEqual({ models: [], default: "" });
    expect(await subject.catalog.live()).toEqual([]);
    expect(await subject.catalog.select()).toEqual({
        ok: false,
        message:
            "Google's enabled accounts and the model translator currently have no verified chat model in common. Send again in a minute, or choose a different provider explicitly.",
    });
});

test("successful empty advertisement is cached and cannot fall back to the display seed", async () => {
    const subject = fixture({ advertised: [] });
    subject.report(verified([OPUS_46.id]));
    expect(await subject.catalog.models()).toEqual({ models: [], default: "" });
    expect(await subject.catalog.models()).toEqual({ models: [], default: "" });
    expect(await subject.catalog.live()).toEqual([]);
    expect(subject.requests).toHaveBeenCalledTimes(2);
});

test("similar high and tiered IDs are not inferred to be routing aliases", async () => {
    const high: GeminiModel = { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash High", inputModalities: ["text", "image"] };
    const subject = fixture({ advertised: [high] });
    subject.report(verified(["gemini-3.7-flash-tiered"]));
    expect(await subject.catalog.models()).toEqual({ models: [], default: "" });
    expect(await subject.catalog.select(high.id)).toEqual({
        ok: false,
        code: "model-unavailable",
        message:
            "Google does not currently offer gemini-3.7-flash-high through this sandbox's enabled account pool. Pick an available model explicitly, or send again if it becomes available.",
    });
});

test("partial verification preserves a proved negative but does not authorize a model from successful accounts alone", async () => {
    const subject = fixture();
    subject.report({ state: "incomplete", accounts: 2, verified: 1, models: [OPUS_46.id] });
    expect(await subject.catalog.models()).toEqual({ models: [], default: "" });
    expect(await subject.catalog.select(OPUS_55.id)).toEqual({
        ok: false,
        code: "model-unavailable",
        message:
            "Google does not currently offer claude-opus-5-5-high through this sandbox's enabled account pool. Pick an available model explicitly, or send again if it becomes available.",
    });
    expect(await subject.catalog.select(OPUS_46.id)).toEqual({
        ok: false,
        message:
            "Google model availability could not be verified for every enabled account. Send again in a minute; your selected model has not been changed.",
    });
});

test.each<GoogleModelAvailability>([{ state: "unknown" }, { state: "incomplete", accounts: 2, verified: 0, models: [] }])(
    "a metadata outage is not a retirement claim or permission to use persisted rows: %j",
    async (availability) => {
        const subject = fixture({ stored: [OPUS_55] });
        subject.report(availability);
        expect(await subject.catalog.models()).toEqual({ models: [], default: "" });
        expect(await subject.catalog.select(OPUS_55.id)).toEqual({
            ok: false,
            message:
                "Google model availability could not be verified for every enabled account. Send again in a minute; your selected model has not been changed.",
        });
    },
);

test("a translator outage preserves display metadata without trusting it as a current advertisement", async () => {
    const subject = fixture();
    subject.report(verified(ALL.map((model) => model.id)));
    await subject.catalog.models();
    subject.advertise(undefined);
    advanceCatalogClock();
    expect(await subject.catalog.models()).toEqual({ models: [], default: "" });
    expect(await subject.catalog.select(OPUS_55.id)).toEqual({
        ok: false,
        message: "The model translator's Google catalog could not be verified. Send again in a minute; your selected model has not been changed.",
    });
    expect(JSON.parse(readFileSync(subject.persistPath, "utf8"))).toEqual(ALL);
});

test("no enabled accounts cannot authorize the seed or be misreported as model retirement", async () => {
    const subject = fixture();
    subject.report(verified([], 0));
    expect(await subject.catalog.models()).toEqual({ models: [], default: "" });
    expect(await subject.catalog.select(OPUS_55.id)).toEqual({
        ok: false,
        message:
            "No Google account is enabled in the model translator's rotation, so nothing can run on it. Check the Google account status in Sandbox ▸ Agent.",
    });
});

test("concurrent picker, helper and runtime reads share one catalog snapshot", async () => {
    const subject = fixture();
    const [catalog, selection, live] = await Promise.all([subject.catalog.models(), subject.catalog.select(OPUS_46.id), subject.catalog.live()]);
    expect(catalog).toEqual({ models: [OPUS_46], default: OPUS_46.id });
    expect(selection).toEqual({ ok: true, model: OPUS_46.id });
    expect(live).toEqual([OPUS_46]);
    expect(subject.readAvailability).toHaveBeenCalledTimes(1);
    expect(subject.requests).toHaveBeenCalledTimes(2);
});
