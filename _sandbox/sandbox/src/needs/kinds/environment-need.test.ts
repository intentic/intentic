import type { Need } from "@intentic/sandbox-contract";
import { environmentNeed } from "./environment-need.js";

// A tool in the image: filed as a draft at once, approved one tool at a time, and met only once the running container
// is the one built from that approval.

const harness = () => {
    const calls: string[] = [];
    const state = { applied: "", problem: undefined as string | undefined };
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
        appliedHash: () => state.applied,
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
        expect(await kind.check(approved)).toBeUndefined();
        state.applied = "overlay-hash-1";
        expect(await kind.check(approved)).toEqual({
            result: "ffmpeg is in the sandbox image now: this container was rebuilt with it.",
            use: ["Use ffmpeg directly; nothing needs installing again."],
        });
    });

    it("drops the draft when declined", async () => {
        const { kind, calls } = harness();
        await kind.declined?.(needOf({ kind: "environment", tool: "ffmpeg", steps: "RUN true" }));
        expect(calls).toEqual(["reject ffmpeg"]);
    });
});
