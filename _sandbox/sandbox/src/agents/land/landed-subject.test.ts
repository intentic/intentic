import type { LandedMessageDraft } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../../composition.js";
import { describeLanding } from "./landed-subject.js";

const ask = vi.fn<() => Promise<{ value: { subject: string; note: string; breaking: string } }>>();
// Whether a model is set for commit messages; checked before the report opens, not caught by the walk.
const modelSet = vi.fn<() => boolean>(() => true);
vi.mock("../../agent/models/role-model.js", () => ({ askRoleModel: () => ask(), roleModelIsSet: async () => modelSet() }));
vi.mock("../../git/changes/contract-shrink.js", () => ({ claimedContractShrink: async () => [] }));

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

const servicesWith = (): Services =>
    unstubbed<Services>("services", {
        agents: unstubbed<Services["agents"]>("agents", {
            entry: () => ({ id: "c1", repos: [{ repo: "root", base: "a".repeat(40) }] }) as ReturnType<Services["agents"]["entry"]>,
            setLandedMessageDraft: (_id, draft) => noteDraft(draft),
            setLandedSubject: async (_id, draft) => void steps.push(`wrote ${draft.subject}`),
        }),
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { mainDir: () => "/work" }),
        agentOrigins: unstubbed<Services["agentOrigins"]>("agentOrigins", { forRepo: async () => ({ "a.ts": ["c1"] }) }),
        git: unstubbed<Services["git"]>("git", {
            collectRepoDiff: async () => ({ repo: "root", subjects: [], summary: "a.ts | 2 +-", blocks: [] }),
        }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => ({ changelogRepos: [] }) as never }),
        perf: unstubbed<Services["perf"]>("perf", { track: async (_op, _fields, run) => run() }),
        logger: unstubbed<Services["logger"]>("logger", { debug: () => undefined }),
    });

beforeEach(() => {
    ask.mockReset();
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
