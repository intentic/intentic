import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeModel, type FakeModel, type ScriptedStep } from "@intentic/fake-model";
import { type ResponsesRequest, userMessages } from "@intentic/fake-model/responses";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { e2eTier } from "@intentic/testing/e2e";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AgentRequest } from "../agent/run/agent.js";
import { onPath } from "../platform/boot/on-path.js";
import { createGrokAgent, createGrokRunner } from "../runtimes/grok/grok-agent.js";
import { createOpenCodeService, OPENCODE_GEMINI_PROVIDER, type OpenCodeService } from "../runtimes/grok/opencode.js";

// Real `opencode serve` and the real adapter against a scripted model, closing a gap two other suites leave (spawn
// untested, or events canned). Uses Gemini since it looks like an ordinary OpenAI-compatible provider to fake-model.

const tier = e2eTier("opencode wire conformance", { enabledBy: "INTENTIC_E2E_PROVIDERS" });

const MODEL_ID = "conformance-model";
const AUTH_TOKEN = "intentic-opencode-conformance";

// Not the SDK's default (4096); a real sandbox's warm server listens there, tying the result to the host.
const TIER_PORT = 45096;

// A table pairs each prompt's marker with its answer, so a shared server can't read another test's reply.
const SCENARIOS = {
    plain: { marker: "MARKER-PLAIN", step: { text: "the answer is 42" } },
    model: { marker: "MARKER-MODEL", step: { text: "ok" } },
    appendOff: { marker: "MARKER-APPEND-OFF", step: { text: "ok" } },
    appendOn: { marker: "MARKER-APPEND-ON", step: { text: "ok" } },
    // 400, not 429: a 429 costs ~70s of OpenCode's own retry backoff; this scenario targets the error path only.
    refusal: { marker: "MARKER-REFUSAL", step: { failWith: { status: 400, body: { error: { message: "conformance refusal" } } } } },
} as const satisfies Record<string, { marker: string; step: ScriptedStep }>;

const APPEND_SENTINEL = "OPENCODE-APPEND-SENTINEL";

let service: OpenCodeService | undefined;
let model: FakeModel | undefined;
let workspace = "";

interface TurnResult {
    readonly events: readonly AgentEvent[];
    /** Only the requests this scenario's marker provoked; a shared model records every scenario's calls. */
    readonly requests: readonly ResponsesRequest[];
}

const runTurn = async (scenario: { marker: string }, overrides: Partial<AgentRequest> = {}): Promise<TurnResult> => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const agent = createGrokAgent(createGrokRunner(service!), OPENCODE_GEMINI_PROVIDER);
    try {
        for await (const event of agent({
            prompt: `${scenario.marker}: do the thing`,
            cwd: workspace,
            signal: controller.signal,
            model: MODEL_ID,
            ...overrides,
        })) {
            events.push(event);
        }
    } finally {
        controller.abort();
    }
    const mine = model!.requests.filter((request) => JSON.stringify(request).includes(scenario.marker));
    return { events, requests: mine };
};

const errorsIn = (events: readonly AgentEvent[]): readonly string[] =>
    events.filter((event) => event.kind === "error").map((event) => (event as Extract<AgentEvent, { kind: "error" }>).message);

const proseIn = (events: readonly AgentEvent[]): string =>
    events
        .filter((event) => event.kind === "delta")
        .map((event) => (event as Extract<AgentEvent, { kind: "delta" }>).text)
        .join("");

describe.skipIf(!tier.runs)(tier.title, () => {
    beforeAll(async () => {
        if (!(await onPath("opencode"))) {
            throw new Error(
                "the opencode conformance tier was asked for but no opencode binary is on PATH: install the opencode pack (image-packs/opencode.Dockerfile), or unset INTENTIC_E2E_PROVIDERS to stand the tier down deliberately",
            );
        }

        workspace = await mkdtemp(join(tmpdir(), "opencode-wire-"));
        model = await startFakeModel({
            requireKey: AUTH_TOKEN,
            respond: (request) => {
                const asked = `${userMessages(request).join(" ")} ${JSON.stringify(request)}`;
                const hit = Object.values(SCENARIOS).find((scenario) => asked.includes(scenario.marker));
                return hit?.step;
            },
        });
        service = createOpenCodeService(join(workspace, "xdg"), {
            // Gemini wiring pointed at loopback; text-only inputModalities, since these scenarios send no images.
            gemini: { baseUrl: model.baseUrl, token: AUTH_TOKEN, models: async () => [{ id: MODEL_ID, inputModalities: ["text"] }] },
            workspaceRoot: workspace,
            // Off the daemon's own port: the default is already bound by a running sandbox, failing this boot opaquely.
            port: TIER_PORT,
        });
        // Booted here, not in the first test, so a failing server fails as setup, not as whichever scenario ran first.
        await service.client();
    }, 120_000);

    // Stops the server this tier started; otherwise every run leaks an opencode serve until the box is loaded enough to
    // flake unrelated tests.
    afterAll(async () => {
        await service?.stop();
        await model?.close();
    });

    // The whole span this runtime had no coverage of: the server boots, the provider registers, the prompt reaches the
    // model, and the reply returns as normalized frames.
    test("a plain turn boots the server, reaches the model, and streams prose back", async () => {
        const { events, requests } = await runTurn(SCENARIOS.plain);

        expect(requests.length, "the prompt must have reached the scripted model").toBeGreaterThan(0);
        expect(userMessages(requests[0]!).join("\n")).toContain(SCENARIOS.plain.marker);
        expect(errorsIn(events)).toEqual([]);
        expect(proseIn(events)).toContain("the answer is 42");
        expect(events.at(-1)?.kind).toBe("done");
    });

    // OpenCode resolves providerID/modelID against config fixed at spawn; a mismatch fails outright rather than falling
    // back.
    test("the selected model reaches the backend", async () => {
        const { requests } = await runTurn(SCENARIOS.model);
        expect(requests[0]?.model).toBe(MODEL_ID);
    });

    // OpenCode has no seam to replace its base prompt, so this runtime only appends via systemAppend; both on/off
    // halves are checked so presence alone doesn't prove the setting worked.
    test("an appended system prompt reaches the backend", async () => {
        const off = await runTurn(SCENARIOS.appendOff);
        expect(JSON.stringify(off.requests), "the sentinel must be absent without the setting, or this proves nothing").not.toContain(
            APPEND_SENTINEL,
        );

        const on = await runTurn(SCENARIOS.appendOn, { systemAppend: APPEND_SENTINEL });
        expect(JSON.stringify(on.requests), "the owner's instructions must reach the model").toContain(APPEND_SENTINEL);
    });

    // A silent failure here would burn the two-minute inactivity watchdog, so this runtime's rulebook is refuse-only;
    // the 90s budget is a hang bound, not a timing target.
    test("a model-side refusal ends the turn with an error frame rather than the inactivity watchdog", async () => {
        const { events } = await runTurn(SCENARIOS.refusal);
        expect(errorsIn(events).length, "a refused call must surface as a frame").toBeGreaterThan(0);
        expect(events.at(-1)?.kind).toBe("done");
    }, 90_000);
});
