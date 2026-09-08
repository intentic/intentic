import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeModel, type ScriptedStep } from "@intentic/fake-model";
import { hasTool, type ResponsesRequest, systemInstructions, toolOutputs, userMessages } from "@intentic/fake-model/responses";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { e2eTier } from "@intentic/testing/e2e";
import { beforeAll, describe, expect, test } from "vitest";
import type { AgentRequest } from "../agent/run/agent.js";
import { createCodexAgent } from "../runtimes/codex/codex-agent.js";
import { writeCodexConfig } from "../runtimes/codex/codex-config.js";
import { codexBinary } from "../runtimes/codex/codex-path.js";

// Real Codex CLI and adapter against a scripted model, parameterized across two model families whose wire formats
// differ; a missing binary fails the suite instead of skipping it.

const tier = e2eTier("codex wire conformance", { enabledBy: "INTENTIC_E2E_PROVIDERS" });

// Model ids the pinned CLI knows; an unknown id turns into a warning-turned-error frame unrelated to the test.
const MODELS: readonly { readonly id: string; readonly surface: string }[] = [
    { id: "gpt-5.2-codex", surface: "flat tools, top-level instructions" },
    { id: "gpt-5.6-sol", surface: "namespaced tools, developer-message instructions" },
];

const AUTH_TOKEN = "intentic-conformance-bearer";

// Prepares CODEX_HOME exactly as the daemon does (real config.toml/hooks.json, not a bare dir); app-server refuses a
// home that doesn't exist.
const scratch = async (): Promise<{ cwd: string; codexHome: string }> => {
    const root = await mkdtemp(join(tmpdir(), "codex-wire-"));
    const codexHome = join(root, "home");
    await writeCodexConfig(codexHome, "");
    return { cwd: root, codexHome };
};

interface TurnResult {
    readonly events: readonly AgentEvent[];
    readonly requests: readonly ResponsesRequest[];
    readonly bearers: readonly (string | undefined)[];
    readonly cwd: string;
    readonly codexHome: string;
}

// One real Codex turn against a scripted model; the adapter has no runner override, so it spawns and speaks JSON-RPC
// exactly as a live turn does.
const runTurn = async (modelId: string, script: readonly ScriptedStep[], overrides: Partial<AgentRequest> = {}): Promise<TurnResult> => {
    const { cwd, codexHome } = await scratch();
    const model = await startFakeModel({ script, requireKey: AUTH_TOKEN });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    try {
        const agent = createCodexAgent({ codexHome });
        for await (const event of agent({
            prompt: "do the thing",
            cwd,
            signal: controller.signal,
            codexHome,
            codexEndpoint: { baseUrl: model.baseUrl, authToken: AUTH_TOKEN },
            model: modelId,
            ...overrides,
        })) {
            events.push(event);
        }
        return { events, requests: [...model.requests], bearers: [...model.bearers], cwd, codexHome };
    } finally {
        controller.abort();
        await model.close();
    }
};

type ErrorFrame = Extract<AgentEvent, { kind: "error" }>;

const errorFrames = (events: readonly AgentEvent[]): readonly ErrorFrame[] => events.filter((event): event is ErrorFrame => event.kind === "error");

// Failures excluding codex-advisory frames, which the adapter lets a turn carry on past; conflating the two would hide
// a real failure or fail every scenario.
const errorsIn = (events: readonly AgentEvent[]): readonly string[] =>
    errorFrames(events)
        .filter((event) => event.code !== "codex-advisory")
        .map((event) => event.message);

const proseIn = (events: readonly AgentEvent[]): string =>
    events
        .filter((event) => event.kind === "delta")
        .map((event) => (event as Extract<AgentEvent, { kind: "delta" }>).text)
        .join("");

describe.skipIf(!tier.runs)(tier.title, () => {
    // Asked for but unable to run is a failure, not a skip; the thrown message names the fix.
    beforeAll(async () => {
        const binary = await codexBinary();
        if (binary === undefined) {
            throw new Error(
                "the codex conformance tier was asked for but no codex binary resolves: install the codex pack (image-packs/codex.Dockerfile), or unset INTENTIC_E2E_PROVIDERS to stand the tier down deliberately",
            );
        }
    });

    describe.each(MODELS)("$id ($surface)", ({ id: MODEL }) => {
        test("a plain turn reaches the model, streams prose back, and ends once", async () => {
            const { events, requests } = await runTurn(MODEL, [{ text: "the answer is 42" }]);

            expect(requests.length).toBeGreaterThan(0);
            expect(userMessages(requests[0]!).at(-1)).toBe("do the thing");
            expect(errorsIn(events)).toEqual([]);
            expect(events.map((event) => event.kind)).toContain("session");
            expect(events.filter((event) => event.kind === "done")).toHaveLength(1);
            expect(events.at(-1)?.kind).toBe("done");
            expect(proseIn(events)).toContain("the answer is 42");
        });

        // The fake model refuses any bearer but AUTH_TOKEN, so a successful turn already proves this; the assertion
        // pins which one.
        test("the turn's own bearer, and nothing else, authenticates the model call", async () => {
            const { bearers, events } = await runTurn(MODEL, [{ text: "ok" }]);
            expect(bearers.length).toBeGreaterThan(0);
            expect(new Set(bearers)).toEqual(new Set([AUTH_TOKEN]));
            expect(errorsIn(events)).toEqual([]);
        });

        // Writes a file too: an exit code and an actually-run command are different facts, only the second is the
        // capability.
        test("a scripted shell call is really executed, and its output returns to the model", async () => {
            const marker = "CONFORMANCE-MARKER-9F3A";
            const { events, requests, cwd } = await runTurn(
                MODEL,
                [{ shell: `/bin/echo ${marker} > proof.txt && /bin/echo ${marker}` }, { text: "ran it" }],
                { prompt: "run the marker" },
            );

            const outputs = requests.flatMap((request) => [...toolOutputs(request).values()]);
            expect(outputs.join("\n"), "the command's own output must come back to the model").toContain(marker);
            expect(await readFile(join(cwd, "proof.txt"), "utf8"), "the command must have touched the real filesystem").toContain(marker);
            expect(
                events.some((event) => event.kind === "tool_call"),
                "the daemon must render it as a tool card",
            ).toBe(true);
        });

        // Both halves are asserted: presence alone would also pass for an appended prompt, so the stock prompt's
        // absence is checked across the whole request.
        test("a custom system prompt REPLACES Codex's base prompt rather than joining it", async () => {
            const OWN_PROMPT = "You are the conformance persona. Say only what you are told.";

            const plain = await runTurn(MODEL, [{ text: "ok" }]);
            const stock = systemInstructions(plain.requests[0]!);
            expect(stock, "codex normally sends a base prompt of its own").toMatch(/You are (a coding agent|Codex)/);

            const replaced = await runTurn(MODEL, [{ text: "ok" }], { systemPrompt: OWN_PROMPT });
            expect(systemInstructions(replaced.requests[0]!)).toBe(OWN_PROMPT);
            expect(
                JSON.stringify(replaced.requests[0]),
                "the base prompt must be GONE, not merely preceded: an append passes a presence check and is a different capability",
            ).not.toContain(stock.slice(0, 60));
        });

        test("systemAppend adds an instruction while Codex keeps its own base prompt", async () => {
            const APPENDED = "CONFORMANCE-APPEND-SENTINEL";
            const { requests } = await runTurn(MODEL, [{ text: "ok" }], { systemAppend: APPENDED });
            const request = requests[0]!;
            expect(systemInstructions(request), "an append must leave the base prompt in place").toMatch(/You are (a coding agent|Codex)/);
            expect(JSON.stringify(request), "the appended text must reach the model").toContain(APPENDED);
        });

        // Codex registers this tool when the table is absent, so writing it (even false) is what withholds it;
        // asserting requests.length first catches the boolean-to-table regression before the tool check gets confusing.
        test("the question tool is registered for an attended turn and withheld from an unattended one", async () => {
            const attended = await runTurn(MODEL, [{ text: "ok" }]);
            expect(attended.requests.length, "a config Codex refuses never reaches the model at all").toBeGreaterThan(0);
            expect(hasTool(attended.requests[0]!, "request_user_input")).toBe(true);

            const unattended = await runTurn(MODEL, [{ text: "ok" }], { unattended: true });
            expect(unattended.requests.length).toBeGreaterThan(0);
            expect(hasTool(unattended.requests[0]!, "request_user_input"), "an unattended turn must not be offered a way to park on a card").toBe(
                false,
            );
        });

        // An omitted model field lets the SDK's own default leak through unnoticed.
        test("the selected model reaches the wire", async () => {
            const { requests } = await runTurn(MODEL, [{ text: "ok" }]);
            expect(requests[0]?.model).toBe(MODEL);
        });

        // holdsSession and resume are covered against a fake store elsewhere; only the real CLI shows app-server
        // actually resumes the captured thread id.
        test("a resumed turn continues the same thread and carries its history to the model", async () => {
            const { cwd, codexHome } = await scratch();
            const model = await startFakeModel({ script: [{ text: "first answer" }, { text: "second answer" }], requireKey: AUTH_TOKEN });
            const controller = new AbortController();
            try {
                const agent = createCodexAgent({ codexHome });
                const base = {
                    cwd,
                    signal: controller.signal,
                    codexHome,
                    codexEndpoint: { baseUrl: model.baseUrl, authToken: AUTH_TOKEN },
                    model: MODEL,
                };

                let sessionId: string | undefined;
                for await (const event of agent({ ...base, prompt: "remember the word banana" })) {
                    if (event.kind === "session") {
                        sessionId = event.sessionId;
                    }
                }
                expect(sessionId, "a fresh turn must publish the thread it started").toEqual(expect.any(String));

                const before = model.requests.length;
                // Spread: an explicit undefined differs from absent here and would silently start a new thread.
                for await (const _ of agent({ ...base, prompt: "what was the word?", ...(sessionId === undefined ? {} : { sessionId }) })) {
                    // Drained only; the assertion is about the resumed request.
                }
                expect(model.requests.length).toBeGreaterThan(before);
                const users = userMessages(model.requests[before]!);
                expect(users.at(-1)).toBe("what was the word?");
                expect(users.join("\n"), "a resumed thread must carry the earlier turn's message").toContain("remember the word banana");
            } finally {
                controller.abort();
                await model.close();
            }
        });

        // A refusal becomes an error frame, never a throw past the loop. Only the status is pinned: Codex retries a 429
        // itself and reports its own exhaustion, swallowing the upstream message.
        test("a model-side refusal surfaces as an error frame naming the status, and the turn still ends", async () => {
            const { events } = await runTurn(MODEL, [
                { failWith: { status: 429, body: { error: { message: "conformance rate limit", type: "rate_limit_error" } } } },
            ]);
            const errors = errorsIn(events);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.join("\n")).toContain("429");
            expect(events.at(-1)?.kind).toBe("done");
        });

        // Content-addressed by hash so concurrent turns' prompts can't overwrite each other; only observable as a file
        // on this path.
        test("a custom prompt is written into the turn's CODEX_HOME under a content-addressed name", async () => {
            const OWN_PROMPT = "content addressed conformance prompt";
            const { codexHome } = await runTurn(MODEL, [{ text: "ok" }], { systemPrompt: OWN_PROMPT });
            const digest = createHash("sha256").update(OWN_PROMPT).digest("hex");
            expect(await readFile(join(codexHome, "instructions", `${digest}.md`), "utf8")).toBe(OWN_PROMPT);
        });

        // Proved from inside the process (the command prints the value) rather than trusting the adapter's env object.
        test("cliEnv reaches the spawned app-server's shell", async () => {
            const { requests } = await runTurn(MODEL, [{ shell: `/bin/echo "seen:$CONFORMANCE_TOKEN"` }, { text: "done" }], {
                prompt: "print the token",
                cliEnv: { CONFORMANCE_TOKEN: "env-projection-works" },
            });
            const outputs = requests.flatMap((request) => [...toolOutputs(request).values()]);
            expect(outputs.join("\n")).toContain("seen:env-projection-works");
        });

        // Proved from inside the process, not the adapter's env object, so a home mismatch would show up as a real
        // string.
        test("CODEX_HOME inside the running app-server is the turn's own home", async () => {
            const { requests, codexHome } = await runTurn(MODEL, [{ shell: `/bin/echo "home:$CODEX_HOME"` }, { text: "done" }]);
            const outputs = requests.flatMap((request) => [...toolOutputs(request).values()]);
            expect(outputs.join("\n")).toContain(`home:${codexHome}`);
        });
    });

    // Holds the advisory regex against the pinned CLI's actual wording; an unknown model id is the cheapest way to
    // provoke it, and the turn must still succeed since a non-fatal advisory is the contract.
    test("an unknown model id produces a tagged advisory, not a failure, and the turn still answers", async () => {
        const { events } = await runTurn("gpt-4-conformance-unknown", [{ text: "answered anyway" }]);

        const advisories = errorFrames(events).filter((event) => event.code === "codex-advisory");
        expect(advisories.length, "the CLI's fallback-metadata notice must still be recognized as an advisory").toBeGreaterThan(0);
        expect(advisories[0]!.message).toMatch(/fallback metadata/i);

        expect(errorsIn(events), "an advisory must not be accompanied by a real failure").toEqual([]);
        expect(proseIn(events)).toContain("answered anyway");
        expect(events.at(-1)?.kind).toBe("done");
    });
});
