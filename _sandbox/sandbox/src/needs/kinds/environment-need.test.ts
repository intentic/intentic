import type { Need } from "@intentic/sandbox-contract";
import type { ToolStanding } from "../../environment/environment.js";
import type { Answered } from "../need-kinds.js";
import { environmentNeed } from "./environment-need.js";

// A tool in the image: filed as a draft at once, approved one tool at a time, met once the running container was built
// with it, and declined when it was turned down somewhere else. Where the tool stands is environment.ts's answer
// (toolStanding, covered with real files in approvals-lifecycle.integration.test.ts); this pins what the card does
// with each answer.

const harness = () => {
    const calls: string[] = [];
    const state = { standing: "pending" as ToolStanding, problem: undefined as string | undefined };
    const kind = environmentNeed({
        propose: async (tool) => {
            calls.push(`propose ${tool}`);
            return state.problem === undefined ? { file: `${tool}.Dockerfile` } : { problem: state.problem };
        },
        approve: async (tool) => {
            calls.push(`approve ${tool}`);
            return { hash: "overlay-hash-1" };
        },
        reject: async (tool) => {
            calls.push(`reject ${tool}`);
        },
        standing: async () => state.standing,
        composedHash: async () => "overlay-hash-now",
    });
    return { kind, calls, state };
};

const needOf = (subject: Need["subject"]): Need => ({ id: "need-1", conversationId: "conv-1", subject, title: "", status: "open", createdAt: 1, updatedAt: 1 });
const context = { conversationId: "conv-1", standing: undefined };

describe("environment need", () => {
    it("files the steps and raises a card, or refuses with why the steps cannot be proposed", async () => {
        const { kind, state } = harness();
        expect(await kind.resolve({ kind: "environment", tool: "ffmpeg", steps: "RUN apt-get install -y ffmpeg\n" }, context)).toEqual({
            kind: "raise",
            title: "Add ffmpeg to the sandbox image",
            subject: { kind: "environment", tool: "ffmpeg", steps: "RUN apt-get install -y ffmpeg" },
        });
        state.problem = "only RUN and ENV lines may be proposed";
        expect(await kind.resolve({ kind: "environment", tool: "x", steps: "COPY . /" }, context)).toEqual({
            kind: "refused",
            code: "invalid_steps",
            message: "Nothing was proposed: only RUN and ENV lines may be proposed.",
        });
    });

    it("moves an approved tool to working with the overlay it was approved into, and meets it once the container was built from it", async () => {
        const { kind, state } = harness();
        const need = needOf({ kind: "environment", tool: "ffmpeg", steps: "RUN apt-get install -y ffmpeg" });
        const answered = await kind.answer(need, { kind: "approve" }, { email: "owner@acme.dev" });
        expect(answered).toEqual({ status: "working", subject: { kind: "environment", tool: "ffmpeg", steps: "RUN apt-get install -y ffmpeg", approvedHash: "overlay-hash-1" } });
        const approved = needOf("subject" in answered && answered.subject !== undefined ? answered.subject : need.subject);
        state.standing = "approved";
        expect(await kind.check(approved)).toBeUndefined();
        state.standing = "built";
        expect(await kind.check(approved)).toEqual({
            result: "ffmpeg is in the sandbox image now: this container was rebuilt with it.",
            use: ["Use ffmpeg directly; nothing needs installing again."],
        });
    });

    it("waits while the draft is pending, and is declined once the tool was turned down somewhere else", async () => {
        const { kind, state } = harness();
        const need = needOf({ kind: "environment", tool: "ffmpeg", steps: "RUN true" });
        expect(await kind.check(need)).toBeUndefined();
        state.standing = "gone";
        expect(await kind.check(need)).toEqual({ gone: expect.stringContaining("ffmpeg was turned down or taken out on the Environment card") });
    });

    // The card's Approve pressed after the Environment card already answered: it catches up rather than refusing.
    it.each<[string, ToolStanding, Answered]>([
        ["approved elsewhere: working, carrying the overlay composed now", "approved", { status: "working", subject: { kind: "environment", tool: "ffmpeg", steps: "RUN true", approvedHash: "overlay-hash-now" } }],
        ["already built: met", "built", { status: "met", result: "ffmpeg is in the sandbox image now: this container was rebuilt with it.", use: ["Use ffmpeg directly; nothing needs installing again."] }],
        ["turned down elsewhere: declined", "gone", { status: "declined", result: expect.stringContaining("turned down or taken out") }],
    ])("an Approve on a tool %s, without approving a draft that is not there", async (_case, standing, expected) => {
        const { kind, state, calls } = harness();
        state.standing = standing;
        expect(await kind.answer(needOf({ kind: "environment", tool: "ffmpeg", steps: "RUN true" }), { kind: "approve" }, { email: "owner@acme.dev" })).toEqual(expected);
        expect(calls).toEqual([]);
    });

    it("drops the draft when declined", async () => {
        const { kind, calls } = harness();
        await kind.declined?.(needOf({ kind: "environment", tool: "ffmpeg", steps: "RUN true" }));
        expect(calls).toEqual(["reject ffmpeg"]);
    });
});
