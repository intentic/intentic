import type { Mock } from "bun:test";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Services } from "../../composition.js";
import { unstubbed } from "@intentic/testing";
import type { Identity, Social } from "../../conversations/registry/agents-store.js";
import { conversationAfter } from "../../conversations/registry/agents-store.testing.js";
import { privacySliceFake } from "../../privacy/privacy-slice.testing.js";
import { assertAgentExecutionContext, type AgentExecutionContext, withAgentExecution } from "../../workload/agent-execution.js";
import { rootExecutionService } from "../../workload/agent-execution.testing.js";
import { type RoleAsk, readRoleAnswer, UnusableAnswerError } from "../../engines/role-answer.js";

const ask = jest.fn<() => Promise<{ value: string }>>();
// Whether a model is set for session titles; false means this pass must ask before spending anything.
const modelSet = jest.fn<() => boolean>(() => true);
const executions: AgentExecutionContext[] = [];
const requests: RoleAsk<string>[] = [];
const pages: Parameters<Services["transcripts"]["page"]>[] = [];
jest.mock("./role-model.js", () => ({
    askRoleModel: async (_services: Services, execution: AgentExecutionContext, _role: string, request: RoleAsk<string>) => {
        assertAgentExecutionContext(execution);
        executions.push(execution);
        requests.push(request);
        return { value: readRoleAnswer(request.answer, (await ask()).value) };
    },
    roleModelIsSet: async () => modelSet(),
}));
const { cleanSessionTitle, nameAgentTitle: nameAgentTitleInExecution, splitTitleAction, splitTitleTopic } = await import("./title-namer.js");

const nameAgentTitle = (services: Services, conversationId: string, prompt: string): Promise<void> =>
    withAgentExecution(services.agentExecution, { localCwd: WORKSPACE_ROOT }, (execution) =>
        nameAgentTitleInExecution(services, execution, conversationId, prompt),
    );

// Same instinct as cleanCommitSubject: an answer's wrapper is stripped rather than refusing a good name over stray
// formatting.

test("takes the name and nothing but the name", () => {
    expect(cleanSessionTitle("Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("```\nSandbox freezes · fix\n```")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle(`"Sandbox freezes · fix"`)).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Title: Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Session name: Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("- Sandbox freezes · fix")).toBe("Sandbox freezes · fix");
    // The first non-empty line is the name; a trailing explanation has nowhere to go.
    expect(cleanSessionTitle("Sandbox freezes · fix\n\nThis names the work because…")).toBe("Sandbox freezes · fix");
});

test("drops a trailing period but keeps one inside a reference", () => {
    expect(cleanSessionTitle("Sandbox freezes · fix.")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("conversation.ts titles · rewrite")).toBe("conversation.ts titles · rewrite");
});

test("keeps quotes that are part of the name", () => {
    expect(cleanSessionTitle(`"Resume with Claude" prompt · remove`)).toBe(`"Resume with Claude" prompt · remove`);
});

// The separator is what splitTitleAction cuts on, so it is normalised even when the model already got the name right.

test("normalises whatever separator the model reached for", () => {
    expect(cleanSessionTitle("Sandbox freezes - fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Sandbox freezes — fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Sandbox freezes | fix")).toBe("Sandbox freezes · fix");
    expect(cleanSessionTitle("Sandbox freezes•fix")).toBe("Sandbox freezes · fix");
});

test("leaves a hyphenated noun alone", () => {
    // A bare hyphen inside a compound noun must survive; splitting it here would misname the session.
    expect(cleanSessionTitle("Resume-with-Claude prompt · remove")).toBe("Resume-with-Claude prompt · remove");
    expect(cleanSessionTitle("Auth refresh-loop")).toBe("Auth refresh-loop");
});

// What the session is actually called: the action word is stored beside the title, never displayed in it.

test("splits the action word off the displayed name", () => {
    expect(splitTitleAction("Sandbox freezes · fix")).toEqual({ title: "Sandbox freezes", action: "fix" });
    expect(splitTitleAction("Deployments Komodo · Audit")).toEqual({ title: "Deployments Komodo", action: "audit" });
    // Nothing to split: a name the model wrote without a tag stands whole, and so does a tag with no subject.
    expect(splitTitleAction("Auth refresh-loop")).toEqual({ title: "Auth refresh-loop" });
    expect(splitTitleAction("· fix")).toEqual({ title: "· fix" });
    // Only the last segment is the action; a name with its own separators keeps everything before it.
    expect(splitTitleAction("Auth · session · refresh")).toEqual({ title: "Auth · session", action: "refresh" });
});

// The board's label over the title: cut off the front of the name, never displayed in it.

test("splits the topic off the front of the name", () => {
    expect(splitTitleTopic("Devices view | Fix redirect to sign-in · fix")).toEqual({ rest: "Fix redirect to sign-in · fix", topic: "Devices view" });
    expect(splitTitleTopic("Boot. | Fix flaky boot timing test · fix")).toEqual({ rest: "Fix flaky boot timing test · fix", topic: "Boot" });
    // Only the first bar is the topic's; a name with no topic stands whole.
    expect(splitTitleTopic("Sandbox API | Find leaky | slow patterns · audit")).toEqual({ rest: "Find leaky | slow patterns · audit", topic: "Sandbox API" });
    expect(splitTitleTopic("Sandbox freezes · fix")).toEqual({ rest: "Sandbox freezes · fix", topic: undefined });
});

test("drops a topic too long to be a label and keeps the name after it", () => {
    expect(splitTitleTopic("The whole devices view and its sync | Fix sync status · fix")).toEqual({ rest: "Fix sync status · fix", topic: undefined });
});

test("returns empty for a reply with nothing in it", () => {
    expect(cleanSessionTitle("")).toBe("");
    expect(cleanSessionTitle("```\n```")).toBe("");
});

// Fake registry: only entry() and setTitle matter; the mocked role model's reply, or that it was never asked, is what
// each test checks.

// Old titles a broken guard once let through; still checked here so cards already wearing one can heal.
const STOLEN_TITLES = [
    "You've hit your session limit · resets 11:50pm (UTC)",
    "Failed to authenticate. API Error: 401 OAuth access token has been revoked",
    "[tool_call: glob for pattern '**']",
    "Claude Haiku",
    "claude-haiku-4-5",
    "I am Claude",
];

// `turns` is how many turns the conversation finished before the one this pass runs at; 0 is its opening turn.
const servicesWith = (title: Social["title"], setTitle: Mock<Services["agents"]["setTitle"]>, turns = 0, identity: Identity = {}, opening?: string): Services =>
    unstubbed<Services>("services", {
        privacyShield: privacySliceFake().privacyShield,
        agentExecution: rootExecutionService(),
        agents: unstubbed<Services["agents"]>("agents", { entry: () => conversationAfter(turns, { identity, social: { title, reactions: [] } }), setTitle }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", {
            page: async (...args) => {
                pages.push(args);
                return { rows: opening === undefined ? [] : [{ role: "user", text: opening }], from: 0, more: false };
            },
        }),
    });

beforeEach(() => {
    ask.mockReset();
    executions.length = 0;
    requests.length = 0;
    pages.length = 0;
    modelSet.mockReturnValue(true);
});

test("asks nothing when no model is set for session titles", async () => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    modelSet.mockReturnValue(false);

    await nameAgentTitle(servicesWith({ text: "Fix the auth tests", source: "derived" }, setTitle), "c1", "fix the auth tests");

    expect(ask).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
});

test.each(["derived", "model", "plan", "user"] as const)("a home with a %s title never asks the naming model", async (source) => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    modelSet.mockClear();
    await nameAgentTitle(servicesWith({ text: "Presence", source }, setTitle, 0, { home: true }), "home-ada", "Are you there?");
    expect(modelSet).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
});

test("names a still-derived conversation from the prompt that just opened its turn", async () => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ value: "Fleet board | Fleet board broadcast · wire" });
    await nameAgentTitle(
        servicesWith({ text: "We should look at the fleet board and figure out why it…", source: "derived" }, setTitle),
        "c1",
        "we should look at the fleet board and figure out why it stops updating",
    );
    expect(setTitle).toHaveBeenCalledWith("c1", "Fleet board broadcast", "model", "wire", "Fleet board");
});

test("leaves a conversation that already answers to a better name alone", async () => {
    // titleSource `plan` outranks a model name, skipping the call rather than paying for promoteTitle to reject it.
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    await nameAgentTitle(servicesWith({ text: "Session titles · rethink", source: "plan" }, setTitle), "c1", "rethink session titles");
    expect(ask).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
});

// A parent's description of its child opens as a `model` name (children.ts). Renaming it is how six children of one
// parent all came to read "testaudit picks"; the card still gets the work word it is tinted by.
test("keeps the words of a name an agent chose as the conversation opened, and gives it only its action", async () => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ value: "testaudit picks · audit" });
    await nameAgentTitle(servicesWith({ text: "Test audit reviewer, batch 24", source: "model" }, setTitle), "sub-1", "Review the test audit, batch 24");
    expect(setTitle).toHaveBeenCalledWith("sub-1", "Test audit reviewer, batch 24", "model", "audit", undefined);
});

test("asks nothing about a model name past the opening turn, nor about one that already has its action", async () => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    await nameAgentTitle(servicesWith({ text: "Test audit reviewer, batch 24", source: "model" }, setTitle, 1), "sub-1", "and the next batch");
    await nameAgentTitle(servicesWith({ text: "Test audit reviewer", source: "model", action: "audit" }, setTitle), "sub-1", "review it");
    expect(ask).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
});

test("a chain that never wrote a usable name leaves the derived title standing", async () => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    ask.mockRejectedValue(new Error("gemini-3.5-flash: wrote a tool call instead of a session title"));

    await expect(
        nameAgentTitle(servicesWith({ text: "Fix the auth tests", source: "derived" }, setTitle), "c1", "fix the auth tests"),
    ).rejects.toThrow(/tool call/);

    expect(setTitle).not.toHaveBeenCalled();
});

test("passes the caller's live execution context unchanged to the title model", async () => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    const services = servicesWith({ text: "Fix the auth tests", source: "derived" }, setTitle);
    const admission = await services.agentExecution.admit();
    const lease = services.agentExecution.acquire(admission, { localCwd: WORKSPACE_ROOT });
    ask.mockResolvedValue({ value: "Auth test flakiness · fix" });
    try {
        await nameAgentTitleInExecution(services, lease.context, "c1", "fix the auth tests");
        expect(executions).toEqual([lease.context]);
        expect(executions[0]).toBe(lease.context);
        assertAgentExecutionContext(lease.context);
        expect(setTitle).toHaveBeenCalledWith("c1", "Auth test flakiness", "model", "fix", undefined);
    } finally {
        lease.release();
        services.agentExecution.close(admission);
    }
});

test.each(STOLEN_TITLES)("a stored title reading %s counts as no name: the pass runs again and heals it", async (stolen) => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ value: "Auth test flakiness · fix" });
    await nameAgentTitle(servicesWith({ text: stolen, source: "model" }, setTitle), "c1", "fix the auth tests");
    expect(setTitle).toHaveBeenCalledWith("c1", "Auth test flakiness", "model", "fix", undefined);
});

test.each(["Intentic", "boot.test.ts", "src/start.ts src/boot.test.ts"])("refuses a bare label %s inside the model answer contract", async (label) => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ value: `${label} · fix` });
    await expect(nameAgentTitle(servicesWith({ text: "Fix the auth tests", source: "derived" }, setTitle), "c1", "fix the auth tests"))
        .rejects.toBeInstanceOf(UnusableAnswerError);
    expect(setTitle).not.toHaveBeenCalled();
});

test.each(["· fix", "Claude Haiku · explain", `${"Specific ".repeat(10)}test · fix`])("refuses an unusable displayed title in %s", async (reply) => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ value: reply });
    await expect(nameAgentTitle(servicesWith({ text: "Fix the auth tests", source: "derived" }, setTitle), "c1", "fix the auth tests"))
        .rejects.toBeInstanceOf(UnusableAnswerError);
    expect(setTitle).not.toHaveBeenCalled();
});

test.each([
    ["Fix flaky boot timing test", "fix"],
    ["Audit Intentic for critical vulnerabilities", "audit"],
    ["Explain boot.test.ts timing assumptions", "explain"],
])("keeps the requested work visible in %s and stores its category separately", async (title, action) => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    ask.mockResolvedValue({ value: `${title} · ${action}` });
    await nameAgentTitle(servicesWith({ text: "Opening request", source: "derived" }, setTitle), "c1", "the opening request");
    expect(setTitle).toHaveBeenCalledWith("c1", title, "model", action, undefined);
});

test.each(["model", "plan"] as const)("repairs a bare %s title from the original request on a later turn", async (source) => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    const opening = "Perform an exploratory security check on Intentic. Find critical vulnerabilities.";
    const services = servicesWith({ text: "Intentic", source, action: "audit" }, setTitle, 4, {}, opening);
    ask.mockResolvedValue({ value: "Audit Intentic for critical vulnerabilities · audit" });
    await nameAgentTitle(services, "c1", "Continue");
    expect(pages).toEqual([[expect.objectContaining({ id: "c1" }), { before: 1 }]]);
    expect(requests[0]?.prompt).toContain(`Opening user message:\n${opening}`);
    expect(requests[0]?.prompt).not.toContain("\nContinue\n");
    expect(setTitle).toHaveBeenCalledWith("c1", "Audit Intentic for critical vulnerabilities", "model", "audit", undefined);
});

test.each(["Intentic", "boot.test.ts", ...STOLEN_TITLES])("preserves an explicit user rename reading %s", async (title) => {
    const setTitle = jest.fn<Services["agents"]["setTitle"]>();
    await nameAgentTitle(servicesWith({ text: title, source: "user" }, setTitle, 2), "c1", "Continue");
    expect(ask).not.toHaveBeenCalled();
    expect(setTitle).not.toHaveBeenCalled();
});
