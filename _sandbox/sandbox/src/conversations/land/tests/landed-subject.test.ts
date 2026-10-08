import type { LandedMessageDraft } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { isolatedAgent } from "../../../testing.js";
import { AgentDomainRefusedError, assertAgentExecutionContext, createAgentExecutionService, type AgentExecutionContext, type AgentExecutionService } from "../../../workload/agent-execution.js";
import { rootExecutionService } from "../../../workload/agent-execution.testing.js";

const ask = jest.fn<() => Promise<{ value: { subject: string; note: string; breaking: string } }>>();
// Whether a model is set for commit messages; checked before the report opens, not caught by the walk.
const modelSet = jest.fn<() => boolean>(() => true);
const executions: AgentExecutionContext[] = [];
jest.mock("../../../agent/models/role-model.js", () => ({
    askRoleModel: (_services: Services, execution: AgentExecutionContext) => {
        assertAgentExecutionContext(execution);
        executions.push(execution);
        return ask();
    },
    roleModelIsSet: async () => modelSet(),
}));
jest.mock("../../../git/changes/contract-shrink.js", () => ({ claimedContractShrink: async () => [] }));
const { describeLanding, messageAnswer } = await import("../landed-subject.js");

// Order the user is told in while a landing's sentence writes: the report may only end once there's something to show;
// ending it first would show 'ready' over an empty box.

// Events announced, in order.
const steps: string[] = [];

// Reduces the report's edges to words: opened (no outcome yet), and each outcome as it lands.
const noteDraft = (draft: LandedMessageDraft | undefined): void => {
    if (draft === undefined) {
        steps.push(`withdrawn`);
        return;
    }
    if (draft.outcome !== undefined) {
        steps.push(`ended ${draft.outcome}`);
        return;
    }
    if (steps.length === 0) {
        steps.push(`opened`);
    }
};

const servicesWith = (said?: string, execution: AgentExecutionService = rootExecutionService(), origins: Record<string, string[]> = { "a.ts": ["c1"] }): Services =>
    unstubbed<Services>("services", {
        agentExecution: execution,
        workspace: unstubbed<Services["workspace"]>("workspace", { root: "/work" }),
        agents: unstubbed<Services["agents"]>("agents", {
            entry: () => isolatedAgent([{ repo: "root", base: "a".repeat(40) }]),
            setLandedMessageDraft: (_id, draft) => noteDraft(draft),
            setLandedSubject: async (_id, draft) =>
                void steps.push(`wrote ${draft.subject}${draft.testNote === undefined ? `` : ` | ${draft.testNote}`}`),
        }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", {
            lastSaid: async () => said,
        }),
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { mainDir: () => "/work" }),
        agentOrigins: unstubbed<Services["agentOrigins"]>("agentOrigins", { forRepo: async () => origins }),
        git: unstubbed<Services["git"]>("git", {
            collectRepoDiff: async () => ({ repo: "root", subjects: [], summary: "a.ts | 2 +-", blocks: [] }),
        }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => ({ changelogRepos: [] }) as never }),
        perf: unstubbed<Services["perf"]>("perf", { track: async (_op, _fields, run) => run() }),
        logger: unstubbed<Services["logger"]>("logger", { debug: () => undefined }),
    });

beforeEach(() => {
    ask.mockReset();
    executions.length = 0;
    modelSet.mockReturnValue(true);
    steps.length = 0;
});

// Checked before the report opens: an owner-disabled job must stay silent, not open a chip that then ends failed.
test("writes nothing and opens no report when no model is set for commit messages", async () => {
    modelSet.mockReturnValue(false);

    await describeLanding(servicesWith(), "c1");

    expect(steps).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
});

test("opens the report at the land, writes the sentence, and only then says the draft ended", async () => {
    ask.mockResolvedValue({ value: { subject: "fix: cascading markers", note: "", breaking: "" } });
    await describeLanding(servicesWith(), "c1");
    expect(steps).toEqual([`opened`, `wrote fix: cascading markers`, `ended written`]);
});

test("the Test-Note the conversation ended its last word on rides with the drafted message", async () => {
    ask.mockResolvedValue({ value: { subject: "refactor: rows", note: "", breaking: "" } });
    await describeLanding(servicesWith("Kept the looser assertion.\nTest-Note: rows became a table"), "c1");
    expect(steps).toEqual([`opened`, `wrote refactor: rows | rows became a table`, `ended written`]);
});

// Every road out of the model call ends the report, `failed` with nothing written; only the job being unset opens no
// report at all (above).
test.each([
    ["every account the job named being gone", "every model set for this job names an account this sandbox no longer has"],
    ["a rung that wrote a tool call", "gemini-3.5-flash: wrote a tool call instead of a commit subject"],
])("%s ends the report as failed, with nothing written", async (_case, message) => {
    ask.mockRejectedValue(new Error(message));
    await expect(describeLanding(servicesWith(), "c1")).rejects.toThrow(message);
    expect(steps).toEqual([`opened`, `ended failed`]);
});

test("the failed report names its reason", async () => {
    const reports: (LandedMessageDraft | undefined)[] = [];
    const services = servicesWith();
    (services.agents.setLandedMessageDraft as unknown) = (_id: string, draft: LandedMessageDraft | undefined): void => void reports.push(draft);
    ask.mockRejectedValue(new Error("gemini-3-flash: usage limit; gpt-5.6: usage limit"));

    await expect(describeLanding(services, "c1")).rejects.toThrow();

    expect(reports.at(-1)?.outcome).toBe(`failed`);
    expect(reports.at(-1)?.reason).toContain(`usage limit`);
    expect(reports.at(-1)?.finishedAt).toEqual(expect.any(Number));
});

test.each([false, true])("owns and releases independent landing execution when the model fails=%s", async (fails) => {
    const service = rootExecutionService();
    const admit = jest.spyOn(service, "admit");
    const close = jest.spyOn(service, "close");
    const acquire = jest.spyOn(service, "acquire");
    const failure = new Error("landing model unavailable");
    if (fails) { ask.mockRejectedValue(failure); }
    else { ask.mockResolvedValue({ value: { subject: "fix: rows", note: "", breaking: "" } }); }

    const describing = describeLanding(servicesWith(undefined, service), "c1");
    if (fails) { await expect(describing).rejects.toBe(failure); }
    else { await describing; }

    expect(executions).toHaveLength(1);
    expect(executions[0]?.cwd).toBe("/work");
    expect(() => assertAgentExecutionContext(executions[0]!)).toThrow(AgentDomainRefusedError);
    const admission = acquire.mock.calls[0]![0];
    expect(admit).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith(admission, { localCwd: "/work" });
    expect(close).toHaveBeenCalledWith(admission);
    expect(() => service.acquire(admission, { localCwd: "/work" })).toThrow(AgentDomainRefusedError);
});

test("an unplaced unprivileged landing refuses and never asks a root model", async () => {
    const readProtectedPolicy = async () => ({ agentDomain: "unprivileged" as const });
    const service = createAgentExecutionService(readProtectedPolicy, () => undefined);
    const close = jest.spyOn(service, "close");
    await expect(describeLanding(servicesWith(undefined, service), "c1")).rejects.toBeInstanceOf(AgentDomainRefusedError);
    expect(steps).toEqual(["opened", "ended failed"]);
    expect(ask).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
});

test("landing domain refusal is not replaced by the draft failure report", async () => {
    const refusal = new AgentDomainRefusedError("landing context was released");
    ask.mockRejectedValue(refusal);
    await expect(describeLanding(servicesWith(), "c1")).rejects.toBe(refusal);
    expect(steps).toEqual(["opened", "ended failed"]);
    expect(() => assertAgentExecutionContext(executions[0]!)).toThrow(AgentDomainRefusedError);
});

test("an unset landing role or an absorbed claim never admits an independent helper", async () => {
    const service = rootExecutionService();
    const admit = jest.spyOn(service, "admit");
    const services = servicesWith(undefined, service);
    modelSet.mockReturnValue(false);
    await describeLanding(services, "c1");
    expect(steps).toEqual([]);
    modelSet.mockReturnValue(true);
    await describeLanding(servicesWith(undefined, service, {}), "c1");
    expect(steps).toEqual(["opened", "withdrawn"]);
    expect(admit).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
});

// What a model's reply is judged by before it may head a commit: refused here, the ask moves to the next model.
describe("a drafted subject", () => {
    const judged = (reply: string, recent: readonly string[] = []): string | undefined => {
        const answer = messageAnswer(false, recent);
        return answer.unusable(answer.read(reply));
    };

    // Both were real subjects of commits in this workspace.
    test.each([
        "Reviewing key changes in the truncated diff to craft an accurate commit message.",
        "Reviewing key diffs to identify the unifying change theme.",
        "Now drafting a subject from what changed",
        "Let me look at what changed",
        "feat(web): summarize the diff above as a commit message",
    ])("that narrates the drafting is refused: %s", (reply) => {
        expect(judged(reply)).toBe("narrated its own work instead of writing a commit subject");
    });

    test("that copies a subject the prompt showed as vocabulary is refused", () => {
        const recent = ["feat(sandbox): add job-fates resolveTurnJobs and stopJob for handed background jobs"];
        expect(judged("feat(sandbox): add job-fates resolveTurnJobs and stopJob for handed background jobs", recent)).toBe(
            "copied a recent commit's subject instead of describing this change",
        );
    });

    test.each(["feat(sandbox): add landCheck on Services", "fix: stop rereading the diff cache", "Update the changelog"])(
        "that describes a change is taken: %s",
        (reply) => {
            expect(judged(reply, ["fix: something else"])).toBeUndefined();
        },
    );
});
