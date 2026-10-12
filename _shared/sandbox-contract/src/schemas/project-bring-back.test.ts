import { type ProjectAnswer, ProjectAnswerSchema } from "./project-bring-back.js";

test("reads the agent's change listing as the desktop app relays it", () => {
    const detail: ProjectAnswer = {
        kind: "changes",
        result: { ok: true, pairing: "p1", direction: "to-sandbox", changes: [{ path: "a.ts", kind: "modified", size: 3, conflict: true }], truncated: true },
    };
    expect(ProjectAnswerSchema.parse(detail)).toEqual(detail);
});

test("a restore's skipped entries are held to their shape, and a failure carries the agent's sentence", () => {
    expect(ProjectAnswerSchema.parse({ kind: "restored", result: { ok: true, restored: 2, skipped: [{ path: "x", reason: "changed" }] } })).toMatchObject({ result: { restored: 2 } });
    expect(ProjectAnswerSchema.parse({ kind: "brought-back", result: { ok: false, error: "conflict" } })).toEqual({ kind: "brought-back", result: { ok: false, error: "conflict" } });
    expect(ProjectAnswerSchema.safeParse({ kind: "changes", result: { note: "x" } }).success).toBe(false);
});
