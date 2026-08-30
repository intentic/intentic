import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeModel, type ScriptedStep } from "@intentic/fake-model";
import { hasTool, type ResponsesRequest, systemInstructions, toolOutputs, userMessages } from "@intentic/fake-model/responses";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { e2eTier } from "@intentic/testing/e2e";
import { beforeAll, describe, expect, test } from "vitest";
import type { AgentRequest } from "../agent/agent.js";
import { createCodexAgent } from "./codex-agent.js";
import { writeCodexConfig } from "./codex-config.js";
import { codexBinary } from "./codex-path.js";

/* THE CODEX CONFORMANCE TIER: the real CLI, the real adapter, a scripted model.
 *
 * Every other Codex suite in this package stops at `fakeCodexRunner`, a scripted list of provider events
 * standing in for app-server. That covers the mapping from Codex events onto AgentEvents, and it is worth
 * having, but BOTH sides of that seam are ours. The failures this repository actually shipped were on the other
 * side: `tools.experimental_request_user_input` changing from a boolean to a table (a config-load error that
 * killed a turn before its first token), the two undocumented instruction keys, `supports_websockets`. A fake
 * runner cannot see any of them, because the CLI never runs.
 *
 * So this tier deletes the fake and keeps the CLI. `codex app-server --stdio` really starts, really reads the
 * config.toml and hooks.json the daemon writes, really assembles its prompt, and really posts it, to
 * @intentic/fake-model rather than to OpenAI. What comes back is scripted, so the turn is deterministic and
 * costs nothing; everything between the daemon and the model is the shipped article.
 *
 * WHAT THIS TIER PROVES THAT NOTHING ELSE CAN. The capability catalog says the Codex runtime replaces
 * instructions and offers questions. Those are claims about what reaches the MODEL, so they can only be checked
 * by reading what reached the model, which is what `requests` holds. Until now they rested on comments
 * recording what someone once saw on a wire ("verified against codex-cli 0.147"); each is an assertion here, and
 * a CLI bump that breaks one fails this suite instead of a user's turn.
 *
 * TWO WIRE SURFACES, AND THE MODEL PICKS. This is the thing the tier found on its first run and the reason it
 * is parameterized. The same CLI, the same entry point, speaks differently depending on the MODEL:
 *
 *   gpt-5-codex  sends its base prompt as the top-level `instructions` field, and its tools flat
 *                (`exec_command`, `request_user_input`, …).
 *   gpt-5.6-sol  sends the base prompt as the first DEVELOPER MESSAGE, and its tools inside a namespaced
 *                `additional_tools` item (`functions.exec`, `functions.request_user_input`, …), where the shell
 *                is reached through a JavaScript isolate rather than a schema'd argument.
 *
 * So every scenario below runs against BOTH families, through readers that ask what a turn means rather than
 * where this month's model happens to put it. A suite pinned to one surface passes on half the catalog and
 * fails on the other half for reasons unrelated to the capability under test, which is indistinguishable from
 * the capability being broken.
 *
 * THE TIER DOES NOT STAND DOWN QUIETLY when it is asked for. `e2eTier` exists so a suite with no credentials
 * says so rather than failing, which is right for a tier that needs somebody's Cloudflare token. This one needs
 * no credential at all, only the CLI the image bakes, so "asked for, and the binary is missing" is a BROKEN
 * environment rather than an absent one, and it fails naming the fix. A release gate that skips itself is not a
 * gate. */

const tier = e2eTier("codex wire conformance", { enabledBy: "INTENTIC_E2E_PROVIDERS" });

/* The model families to hold the adapter to, named for the surface each one exercises rather than for itself.
 * Both must be ids the pinned CLI KNOWS: handed one it does not, Codex emits a `warning` notification ("Model
 * metadata for `x` not found") which the adapter surfaces as an error frame, and every "nothing went red"
 * assertion below would fail for a reason that has nothing to do with what is being tested. They move with the
 * pinned CLI, which is why they are named once, here. */
const MODELS: readonly { readonly id: string; readonly surface: string }[] = [
    { id: "gpt-5.2-codex", surface: "flat tools, top-level instructions" },
    { id: "gpt-5.6-sol", surface: "namespaced tools, developer-message instructions" },
];

const AUTH_TOKEN = "intentic-conformance-bearer";

/* A turn's worth of scaffolding: somewhere to work, and a CODEX_HOME prepared exactly as the daemon prepares it
 * at boot.
 *
 * `writeCodexConfig` rather than a bare mkdir, and the difference is the point of the tier: the real config.toml
 * and the real hooks.json are then in the home the CLI reads, so every turn here also proves Codex ACCEPTS
 * them. A hand-made empty directory would skip the very file whose parse error once killed a turn before its
 * first token. It also has to exist at all, app-server refuses to start against a CODEX_HOME that does not,
 * which is a fast and silent way for a whole tier to prove nothing. */
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

/* ONE REAL CODEX TURN AGAINST A SCRIPTED MODEL, returning both halves a conformance scenario asks about: the
 * normalized frames the daemon produced, and the bodies the CLI put on the wire.
 *
 * The adapter is built with NO runner override, which is the whole point: `createCodexAppServerRunner` resolves
 * the binary, spawns it, and speaks JSON-RPC to it exactly as a user's turn does. */
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

/* THE FRAMES A HEALTHY TURN MUST NOT CARRY, which is not the same as "every error-kind frame".
 *
 * Codex publishes advisories on the same channel as failures, and the adapter tags those `codex-advisory` and
 * deliberately lets the turn carry on (a plan turn that hit one still has a plan to propose). Counting them as
 * failures here would make every scenario below fail for something the product treats as normal; NOT
 * distinguishing them would let a real failure hide behind the exemption. Hence the code, and hence the
 * separate assertion that the advisory classifier still recognizes what this CLI actually says. */
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
    /* Asked for and unable to run is a failure, not a skip: this tier's whole purpose is to be the thing that
     * cannot be absent when a release is cut. The sentence names the pack, because that is the fix. */
    beforeAll(async () => {
        const binary = await codexBinary();
        if (binary === undefined) {
            throw new Error(
                "the codex conformance tier was asked for but no codex binary resolves: install the codex pack (packs/codex.Dockerfile), or unset INTENTIC_E2E_PROVIDERS to stand the tier down deliberately",
            );
        }
    });

    describe.each(MODELS)("$id ($surface)", ({ id: MODEL }) => {
        /* THE SHAPE OF AN ORDINARY TURN, end to end through the real CLI. Everything below depends on this path
         * working at all, so it is asserted first and asserted whole: the prompt arrived, the prose came back,
         * and the turn ended exactly once with nothing red on it. */
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

        /* THE BEARER THE ADAPTER PROMISES. `env_key = "CODEX_API_KEY"` is a claim that the turn's own token,
         * and only it, authenticates the model call. The fake model refuses any other bearer, so a turn that
         * reached the model at all has already proved it; asserting the recorded bearers states WHICH one, and
         * catches a second credential leaking in beside the right one. */
        test("the turn's own bearer, and nothing else, authenticates the model call", async () => {
            const { bearers, events } = await runTurn(MODEL, [{ text: "ok" }]);
            expect(bearers.length).toBeGreaterThan(0);
            expect(new Set(bearers)).toEqual(new Set([AUTH_TOKEN]));
            expect(errorsIn(events)).toEqual([]);
        });

        /* A SHELL COMMAND, ACTUALLY RUN: the `execution: ["shell"]` claim in the Codex capability row. The
         * model is scripted to ask for a command whose output nothing else in this test could produce, and that
         * output is then read back off the wire.
         *
         * The command also writes a file, because "the CLI reported an exit code" and "the CLI ran a command"
         * are different facts and only the second one is the capability. */
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

        /* `instructions: "replace"` MADE CHECKABLE, and the single most valuable assertion in this file. The
         * Codex row claims the owner's system prompt REPLACES Codex's own base prompt, which rests entirely on
         * the undocumented `model_instructions_file` key.
         *
         * Both halves are asserted, because "our text is present" would also pass if Codex had merely appended
         * it, which is a different capability and a different row. The absence half searches the WHOLE request
         * rather than the prompt slot, so a base prompt that merely moved somewhere else still fails. */
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

        /* THE APPEND HALF, a different key (`developer_instructions`) with different semantics: Codex keeps its
         * base prompt and the addition rides at the head of the first developer message. The delegation note
         * reaches every Codex turn this way, so a silent break here is a turn that no longer knows it can
         * delegate. */
        test("systemAppend adds an instruction while Codex keeps its own base prompt", async () => {
            const APPENDED = "CONFORMANCE-APPEND-SENTINEL";
            const { requests } = await runTurn(MODEL, [{ text: "ok" }], { systemAppend: APPENDED });
            const request = requests[0]!;
            expect(systemInstructions(request), "an append must leave the base prompt in place").toMatch(/You are (a coding agent|Codex)/);
            expect(JSON.stringify(request), "the appended text must reach the model").toContain(APPENDED);
        });

        /* THE QUESTION TOOL, DECIDED ON EVERY TURN, and the reason the adapter writes the key out even when it
         * is false: Codex registers this tool when the table is ABSENT, so saying nothing means asking. An
         * unattended turn that could still ask is a deadlock, it parks on an answer nobody will ever give.
         *
         * This is also the assertion that catches the boolean-to-table change. In the old shape the CLI refuses
         * its own config and never reaches the model at all, so `requests` is empty and this fails on the first
         * expect rather than somewhere confusing later, which is why the count is asserted before the tools. */
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

        /* THE MODEL THE USER PICKED IS THE MODEL THAT IS SPENT. The adapter interface's own header records why
         * this needs a test: an omitted model lets the SDK's built-in default leak through, and the same lesson
         * was learned twice, months apart, on two different runtimes, because nothing asserted it. */
        test("the selected model reaches the wire", async () => {
            const { requests } = await runTurn(MODEL, [{ text: "ok" }]);
            expect(requests[0]?.model).toBe(MODEL);
        });

        /* A TURN THAT RESUMES ITS OWN THREAD. `holdsSession` and the resume path are covered against a fake
         * store elsewhere; what only the real CLI can show is that the thread id the daemon captured is one
         * app-server will actually resume, and that the second turn arrives carrying the first one's messages. */
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
                // Spread rather than assigned, because `exactOptionalPropertyTypes` makes an explicit
                // `sessionId: undefined` a different thing from an absent one — and here it would silently
                // start a SECOND fresh thread, so the test would pass while proving nothing about resume.
                for await (const _ of agent({ ...base, prompt: "what was the word?", ...(sessionId === undefined ? {} : { sessionId }) })) {
                    // Drained: the assertion is about the resumed request's contents.
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

        /* A REFUSED MODEL CALL BECOMES A FRAME, NOT A THROW. The daemon's contract is that a turn always ends
         * with `done` and reports failure as an error frame; a runtime that threw past the loop instead would
         * skip the caller's cleanup. Scripted at the HTTP layer, which is where a real rate limit arrives.
         *
         * The STATUS is what the frame must carry, not the body's prose: Codex retries a 429 itself and reports
         * its own exhaustion ("exceeded retry limit, last status: 429"), swallowing the upstream sentence. That
         * is worth pinning rather than papering over, because it is what a user sees, and a release that starts
         * reporting these as something else changes what the fleet board shows. */
        test("a model-side refusal surfaces as an error frame naming the status, and the turn still ends", async () => {
            const { events } = await runTurn(MODEL, [
                { failWith: { status: 429, body: { error: { message: "conformance rate limit", type: "rate_limit_error" } } } },
            ]);
            const errors = errorsIn(events);
            expect(errors.length).toBeGreaterThan(0);
            expect(errors.join("\n")).toContain("429");
            expect(events.at(-1)?.kind).toBe("done");
        });

        /* WHAT THE ADAPTER WRITES INTO A TURN'S CODEX_HOME, checked as a file rather than as an intention. The
         * instruction file is content-addressed so concurrent turns cannot overwrite each other's prompt; that
         * is a property of the PATH, so this is the only place it is observable. */
        test("a custom prompt is written into the turn's CODEX_HOME under a content-addressed name", async () => {
            const OWN_PROMPT = "content addressed conformance prompt";
            const { codexHome } = await runTurn(MODEL, [{ text: "ok" }], { systemPrompt: OWN_PROMPT });
            const digest = createHash("sha256").update(OWN_PROMPT).digest("hex");
            expect(await readFile(join(codexHome, "instructions", `${digest}.md`), "utf8")).toBe(OWN_PROMPT);
        });

        /* THE TURN'S ENVIRONMENT REACHES THE PROCESS. A connected capability's credential rides `cliEnv`, and
         * the Cursor runtime shipped a bug where exactly this did not reach the runtime. The command prints the
         * variable back, so the proof is the VALUE arriving in the model's tool output rather than the
         * adapter's intention. */
        test("cliEnv reaches the spawned app-server's shell", async () => {
            const { requests } = await runTurn(MODEL, [{ shell: `/bin/echo "seen:$CONFORMANCE_TOKEN"` }, { text: "done" }], {
                prompt: "print the token",
                cliEnv: { CONFORMANCE_TOKEN: "env-projection-works" },
            });
            const outputs = requests.flatMap((request) => [...toolOutputs(request).values()]);
            expect(outputs.join("\n")).toContain("seen:env-projection-works");
        });

        /* CODEX_HOME IS PINNED TO THE TURN'S OWN, which is what keeps one conversation's sessions and
         * instructions out of another's. Proved from inside the running process rather than from the adapter's
         * env object: the command prints the variable the app-server actually inherited. */
        test("CODEX_HOME inside the running app-server is the turn's own home", async () => {
            const { requests, codexHome } = await runTurn(MODEL, [{ shell: `/bin/echo "home:$CODEX_HOME"` }, { text: "done" }]);
            const outputs = requests.flatMap((request) => [...toolOutputs(request).values()]);
            expect(outputs.join("\n")).toContain(`home:${codexHome}`);
        });
    });

    /* THE ADVISORY CLASSIFIER, HELD AGAINST WHAT THE PINNED CLI ACTUALLY SAYS.
     *
     * `CODEX_ADVISORY` is a regular expression matched against a vendor's prose, which is the most perishable
     * kind of coupling this repository has: OpenAI rewording one sentence turns a benign notice into an
     * uncoded error frame, and the adapter's own header spells out what that costs, a red line under a turn
     * that answered fine, a turn.error in the activity log, a reddened card on the fleet board, and, in plan
     * mode, an abandoned plan.
     *
     * Nothing could detect that from inside the repository, because both the regex and the fake that feeds it
     * are ours. Provoking the real sentence is the only way, and an unknown model id is the cheapest way to
     * provoke it: the CLI answers with its fallback-metadata notice and carries on. The turn is asserted to
     * still SUCCEED, because the advisory being non-fatal is the actual contract. */
    test("an unknown model id produces a tagged advisory, not a failure, and the turn still answers", async () => {
        const { events } = await runTurn("gpt-4-conformance-unknown", [{ text: "answered anyway" }]);

        const advisories = errorFrames(events).filter((event) => event.code === "codex-advisory");
        expect(advisories.length, "the CLI's fallback-metadata notice must still be recognized as an advisory").toBeGreaterThan(0);
        expect(advisories[0]!.message).toMatch(/fallback metadata/i);

        // Non-fatal is the whole point of the classification: the turn answers and ends clean.
        expect(errorsIn(events), "an advisory must not be accompanied by a real failure").toEqual([]);
        expect(proseIn(events)).toContain("answered anyway");
        expect(events.at(-1)?.kind).toBe("done");
    });
});
