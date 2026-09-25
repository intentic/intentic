import { type AgentEvent, type PermissionMode, PI } from "@intentic/sandbox-contract";
import type { AgentRequest } from "../../agent/providers/agent-request.js";
import { withFileNote } from "../../agent/prompt/attachment-note.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { conversationTainted } from "../../guard/turn-taint.js";
import { memoryFleet } from "../../testing.js";
import { EXECUTE_PROMPT, PLAN_PREAMBLE } from "./plan-mode.js";
import { textPlanTurn, vendorTurn } from "./vendor-turn.js";

// Where a turn here parks its plan card: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

const request = (
    over: { readonly conversationId?: string; readonly attachments?: readonly string[]; readonly permissionMode?: PermissionMode } = {},
): Pick<AgentRequest, "spec" | "policy" | "hooks" | "signal"> => ({
    spec: {
        prompt: "tidy the parser",
        cwd: "/w",
        sessionId: "s-0",
        ...(over.conversationId === undefined ? {} : { conversationId: over.conversationId }),
        ...(over.attachments === undefined ? {} : { attachments: over.attachments }),
    },
    // `rulebook: "none"` marks the turn tainted for its whole life, so the gate's release is visible from outside.
    policy: { rulebook: "none", ...(over.permissionMode === undefined ? {} : { permissionMode: over.permissionMode }) },
    hooks: { cards },
    signal: new AbortController().signal,
});

// Drains a turn, approving each plan card once its frame has gone out.
const drain = async (turn: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
    const frames: AgentEvent[] = [];
    for await (const frame of turn) {
        frames.push(frame);
        if (frame.kind === "plan") {
            setTimeout(() => cards.resolve({ kind: "plan", requestId: frame.requestId, approve: true }), 0);
        }
    }
    return frames;
};

test("a handle that fails to open is the turn's one error, then done, with nothing served", async () => {
    const served: string[] = [];
    const frames = await drain(
        vendorTurn(request(), {
            open: () => {
                throw new Error("agent binary not found");
            },
            unopened: "the agent failed to start",
            async *serve() {
                served.push("serve");
                yield { kind: "delta", text: "served" };
            },
            failure: () => "unused",
        }),
    );

    expect(frames).toEqual([{ kind: "error", message: "agent binary not found" }, { kind: "done" }]);
    expect(served).toEqual([]);
});

test("a failure to open that carries no message is said in the runtime's own words", async () => {
    // What a spawn library that rejects with a bare exit status hands back: no Error, so no message of its own.
    const bare: unknown = "exit 127";
    const frames = await drain(
        vendorTurn(request(), {
            open: async () => {
                throw bare;
            },
            unopened: "the agent failed to start",
            async *serve() {},
            failure: () => "unused",
        }),
    );

    expect(frames).toEqual([{ kind: "error", message: "the agent failed to start" }, { kind: "done" }]);
});

test("an opened handle serves the turn under a gate that lives exactly as long as the turn", async () => {
    const order: string[] = [];
    const frames = await drain(
        vendorTurn(request({ conversationId: "vendor-turn-1" }), {
            open: () => "handle",
            unopened: "unused",
            async *serve(handle) {
                order.push(`serve ${handle} tainted=${String(conversationTainted("vendor-turn-1"))}`);
                yield { kind: "delta", text: "done it" };
            },
            failure: () => "unused",
            close: (handle) => order.push(`close ${handle}`),
        }),
    );

    expect(frames).toEqual([{ kind: "delta", text: "done it" }, { kind: "done" }]);
    expect(order).toEqual(["serve handle tainted=true", "close handle"]);
    expect(conversationTainted("vendor-turn-1")).toBe(false);
});

test("a turn that throws surfaces the runtime's sentence for it, closes, and still ends in done", async () => {
    const closed: string[] = [];
    const frames = await drain(
        vendorTurn(request(), {
            open: () => ({ stderr: "segfault" }),
            unopened: "unused",
            async *serve() {
                yield { kind: "thinking", text: "starting" };
                throw new Error("connection reset");
            },
            failure: (error, handle) => `${(error as Error).message}: ${handle.stderr}`,
            close: (handle) => closed.push(handle.stderr),
        }),
    );

    expect(frames).toEqual([{ kind: "thinking", text: "starting" }, { kind: "error", message: "connection reset: segfault" }, { kind: "done" }]);
    expect(closed).toEqual(["segfault"]);
});

// A runtime that records each phase it is asked to run, planning "1. tidy" whenever it is planning.
const recorded = () => {
    const phases: { text: string; images: number; sessionId: string | undefined; planning: boolean }[] = [];
    const phase = async function* (text: string, images: readonly unknown[], sessionId: string | undefined, planning: boolean) {
        phases.push({ text, images: images.length, sessionId, planning });
        yield { kind: "delta", text: "ran" } satisfies AgentEvent;
        return { sessionId: "s-1", planText: planning ? "1. tidy" : undefined, errored: false };
    };
    return { phases, phase };
};

test("a direct run names every attachment it did not send natively, on the turn's own session", async () => {
    const runtime = recorded();
    await drain(textPlanTurn(PI, request({ attachments: ["/w/notes.md", "/w/shot.png"] }), false, runtime.phase));

    expect(runtime.phases).toEqual([
        { text: withFileNote("tidy the parser", ["/w/notes.md", "/w/shot.png"]), images: 0, sessionId: "s-0", planning: false },
    ]);
});

test("planning names every attachment and sends none, then the approved plan executes on the planned session", async () => {
    const runtime = recorded();
    const frames = await drain(
        textPlanTurn(PI, request({ attachments: ["/w/notes.md", "/w/shot.png"], permissionMode: "plan" }), false, runtime.phase),
    );

    expect(runtime.phases).toEqual([
        { text: PLAN_PREAMBLE + withFileNote("tidy the parser", ["/w/notes.md", "/w/shot.png"]), images: 0, sessionId: "s-0", planning: true },
        { text: EXECUTE_PROMPT, images: 0, sessionId: "s-1", planning: false },
    ]);
    expect(frames.filter((frame) => frame.kind === "plan")).toEqual([{ kind: "plan", requestId: expect.any(String), text: "1. tidy" }]);
});
