import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeModel, type FakeModel, type ScriptedStep } from "@intentic/fake-model";
import { type ResponsesRequest, userMessages } from "@intentic/fake-model/responses";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { e2eTier } from "@intentic/testing/e2e";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AgentRequest } from "../agent/agent.js";
import { onPath } from "../platform/on-path.js";
import { createGrokAgent, createGrokRunner } from "./grok-agent.js";
import { createOpenCodeService, OPENCODE_GEMINI_PROVIDER, type OpenCodeService } from "./opencode.js";

/* THE OPENCODE CONFORMANCE TIER: a real `opencode serve`, the real adapter, a scripted model.
 *
 * This runtime had the largest hole of any provider in the repository. `opencode.integration.test.ts` captures
 * the options the server WOULD be spawned with and never spawns it; `grok-agent.test.ts` replays a canned list
 * of OpenCode events. So the entire span between "the daemon decided what to send" and "OpenCode produced an
 * event" was unexercised, on a runtime that serves TWO providers (Grok and Gemini) through one warm server and
 * whose provider configuration is fixed at spawn, therefore impossible to correct later.
 *
 * The Gemini backend is what makes this tier cheap to stand up, and it is not a workaround:
 * `geminiProviderConfig` registers an ordinary OpenAI-compatible provider at a base URL with a bearer, which is
 * exactly what @intentic/fake-model is. The wiring under test is therefore the SHIPPED wiring with the
 * translator's address swapped for a local one, and every layer between, the spawn, the XDG pin, the
 * custom-provider registration, the SSE stream, the event mapping, is the real thing.
 *
 * ONE SERVER FOR THE WHOLE TIER, and the reason is a property of the runtime rather than a saving. OpenCode
 * fixes provider config at SPAWN, so a scenario cannot reconfigure a running server, and the service exposes no
 * stop, the daemon treats it as a per-container singleton. So the model answers BY WHAT IT WAS ASKED
 * (`respond`) instead of by a positional script: each scenario recognizes its own prompt, a retry gets the same
 * answer rather than the next test's, and nothing depends on the order the runner picks. */

const tier = e2eTier("opencode wire conformance", { enabledBy: "INTENTIC_E2E_PROVIDERS" });

const MODEL_ID = "conformance-model";
const AUTH_TOKEN = "intentic-opencode-conformance";

/* Deliberately NOT the SDK's default (4096), which is where a real sandbox's own warm server already listens.
 * Sharing it would make this tier's result depend on whether the machine running it happens to be a sandbox,
 * which is the difference between a test and a coin toss. */
const TIER_PORT = 45096;

/* Each scenario's prompt carries a marker the responder matches on. Spelled as a table so a prompt and the
 * answer it provokes cannot drift apart, which on a shared server would mean a test silently reading another
 * test's reply and passing for the wrong reason. */
const SCENARIOS = {
    plain: { marker: "MARKER-PLAIN", step: { text: "the answer is 42" } },
    model: { marker: "MARKER-MODEL", step: { text: "ok" } },
    appendOff: { marker: "MARKER-APPEND-OFF", step: { text: "ok" } },
    appendOn: { marker: "MARKER-APPEND-ON", step: { text: "ok" } },
    /* A 400 rather than a 429, and the difference is 70 seconds of CI. Measured against the pinned CLI, a
     * refused-with-429 turn is retried inside OpenCode for ~71s before the adapter ever sees a failure, which is
     * worth knowing (it is what a rate-limited Grok turn costs a user before they are told anything) but is a
     * property of the vendor's backoff rather than of the adapter's error path. What this scenario is for is the
     * error path: that a refusal becomes a frame instead of running out the inactivity watchdog. */
    refusal: { marker: "MARKER-REFUSAL", step: { failWith: { status: 400, body: { error: { message: "conformance refusal" } } } } },
} as const satisfies Record<string, { marker: string; step: ScriptedStep }>;

const APPEND_SENTINEL = "OPENCODE-APPEND-SENTINEL";

let service: OpenCodeService | undefined;
let model: FakeModel | undefined;
let workspace = "";

interface TurnResult {
    readonly events: readonly AgentEvent[];
    /** Only the requests this scenario's marker provoked: a shared model records every scenario's. */
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
                "the opencode conformance tier was asked for but no opencode binary is on PATH: install the opencode pack (packs/opencode.Dockerfile), or unset INTENTIC_E2E_PROVIDERS to stand the tier down deliberately",
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
            /* The shipped Gemini wiring, pointed at loopback: an OpenAI-compatible provider at a base URL with
             * a bearer. `inputModalities` carries "text" alone because these scenarios send no pictures, and a
             * row claiming image input would have OpenCode looking for parts nothing produces. */
            gemini: { baseUrl: model.baseUrl, token: AUTH_TOKEN, models: async () => [{ id: MODEL_ID, inputModalities: ["text"] }] },
            workspaceRoot: workspace,
            /* OFF THE DAEMON'S OWN PORT. The default is fixed, so a sandbox that is already running its warm
             * server, which is every sandbox this suite is likely to be run in, would have this boot fail as an
             * opaque `ServeError` from inside the SDK. This tier needs a server of its own because provider
             * config is fixed at spawn and cannot be pointed at a scripted model afterwards. */
            port: TIER_PORT,
        });
        // Boot once here rather than inside the first test, so a server that cannot start fails as setup with
        // its own error instead of as whichever scenario happened to run first.
        await service.client();
    }, 120_000);

    /* STOP THE SERVER THIS TIER STARTED. Without it every run leaks an `opencode serve`, and on a machine where
     * the suite is run repeatedly they accumulate until the box is loaded enough that timing-sensitive tests
     * elsewhere start failing — which reads as a flaky suite rather than as a leak. */
    afterAll(async () => {
        await service?.stop();
        await model?.close();
    });

    /* THE WHOLE SPAN THIS RUNTIME HAD NO COVERAGE OF, in one assertion: the server really booted, the custom
     * provider really registered, the prompt really reached the model, and the reply really came back through
     * the SSE stream as normalized frames. Any link in that chain breaking is what a user experiences as "Grok
     * says nothing", and until now nothing in this repository could tell the difference. */
    test("a plain turn boots the server, reaches the model, and streams prose back", async () => {
        const { events, requests } = await runTurn(SCENARIOS.plain);

        expect(requests.length, "the prompt must have reached the scripted model").toBeGreaterThan(0);
        expect(userMessages(requests[0]!).join("\n")).toContain(SCENARIOS.plain.marker);
        expect(errorsIn(events)).toEqual([]);
        expect(proseIn(events)).toContain("the answer is 42");
        expect(events.at(-1)?.kind).toBe("done");
    });

    /* THE MODEL THE TURN NAMED IS THE MODEL THE BACKEND WAS ASKED FOR. OpenCode resolves a
     * `providerID`/`modelID` pair against config fixed at spawn, so a mismatch does not fall back, it fails,
     * and the adapter's own header records that a model discovered after the spawn cannot be routed at all. */
    test("the selected model reaches the backend", async () => {
        const { requests } = await runTurn(SCENARIOS.model);
        expect(requests[0]?.model).toBe(MODEL_ID);
    });

    /* `instructions: "append"` MADE CHECKABLE, and the reason this runtime's row says append rather than
     * replace: OpenCode exposes no seam for replacing its base prompt, so the owner's text rides `system` on the
     * message and is ADDED. A release that started dropping the field would leave the settings page promising
     * something the runtime no longer does, silently.
     *
     * `systemAppend` rather than `systemPrompt` is the adapter's own contract, not a workaround: for a runtime
     * that can only add, `turnPromptPlacement` folds the owner's custom prompt into the append slot upstream
     * (system-prompt.ts, covered by its own unit tests) precisely so an adapter never has to decide. This tier
     * asserts the half only the wire can show, that what the adapter was handed arrives at the model.
     *
     * Both halves are run, because "the sentinel is present" proves nothing without knowing it is absent when
     * the setting is off. */
    test("an appended system prompt reaches the backend", async () => {
        const off = await runTurn(SCENARIOS.appendOff);
        expect(JSON.stringify(off.requests), "the sentinel must be absent without the setting, or this proves nothing").not.toContain(
            APPEND_SENTINEL,
        );

        const on = await runTurn(SCENARIOS.appendOn, { systemAppend: APPEND_SENTINEL });
        expect(JSON.stringify(on.requests), "the owner's instructions must reach the model").toContain(APPEND_SENTINEL);
    });

    /* A REFUSED MODEL CALL BECOMES A FRAME, NOT A HANG. This runtime aborts a turn after two minutes without an
     * event, which is why its rulebook is `refuse-only`; a failure producing no event at all would cost the full
     * watchdog before the user learned anything. Scripted at the HTTP layer, where a real refusal arrives.
     *
     * The budget is a HANG BOUND rather than an expectation: the pass takes seconds, and anything approaching
     * this number means the watchdog answered instead of the error path, which is the regression. */
    test("a model-side refusal ends the turn with an error frame rather than the inactivity watchdog", async () => {
        const { events } = await runTurn(SCENARIOS.refusal);
        expect(errorsIn(events).length, "a refused call must surface as a frame").toBeGreaterThan(0);
        expect(events.at(-1)?.kind).toBe("done");
    }, 90_000);
});
