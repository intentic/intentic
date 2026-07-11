import type { EngineEvent } from "@intentic/engine";
import { afterEach, expect, test } from "vitest";
import { loadConfig } from "../env.config.js";
import { createOutput, createRedactor } from "./output.js";

const sink = () => {
    const chunks: string[] = [];
    return { chunks, write: (chunk: string) => chunks.push(chunk) };
};

const pruneDeleted: EngineEvent = { kind: "prune", state: "deleted", id: "old", type: "forgejo" };
const nodeStart: EngineEvent = { kind: "node", phase: "apply", state: "start", id: "host", type: "host" };

afterEach(() => {
    delete process.env["INTENTIC_OUTPUT"];
});

test("intenticOutput reads INTENTIC_OUTPUT and defaults to text", () => {
    process.env["INTENTIC_OUTPUT"] = "json";
    expect(loadConfig().intenticOutput).toBe("json");
    process.env["INTENTIC_OUTPUT"] = "ndjson";
    expect(loadConfig().intenticOutput).toBe("ndjson");
    process.env["INTENTIC_OUTPUT"] = "garbage";
    expect(loadConfig().intenticOutput).toBe("text");
    delete process.env["INTENTIC_OUTPUT"];
    expect(loadConfig().intenticOutput).toBe("text");
});

test("text mode renders prune/orphan and apply progress events as human strings; plan/iteration stay silent", () => {
    const s = sink();
    const out = createOutput(s, "text");
    out.onEvent(pruneDeleted);
    out.onEvent(nodeStart);
    out.onEvent({ kind: "node", phase: "apply", state: "done", id: "host", type: "host", action: "create", reason: "not observed" });
    out.onEvent({ kind: "readiness", state: "waiting", id: "wiki", url: "https://wiki.example.com" });
    out.onEvent({ kind: "readiness", state: "ready", id: "wiki", url: "https://wiki.example.com" });
    out.onEvent({ kind: "node", phase: "plan", state: "start", id: "host", type: "host" }); // plan prints its own table
    out.onEvent({ kind: "iteration", n: 1, converged: true }); // stream-only
    out.log("provider says hi");
    out.text("converged in 1 iteration(s)");
    out.result({ converged: true }); // text already printed; result is a no-op
    expect(s.chunks).toEqual([
        `prune: deleted "old" (type "forgejo")\n`,
        `applying "host" (type "host")\n`,
        `applied "host" (type "host") — create (not observed)\n`,
        `waiting for "wiki" at https://wiki.example.com\n`,
        `"wiki" ready\n`,
        "provider says hi\n",
        "converged in 1 iteration(s)\n",
    ]);
});

test("ndjson mode emits one timestamped JSON object per event, log, and a terminal result", () => {
    const s = sink();
    const out = createOutput(s, "ndjson");
    out.onEvent(nodeStart);
    out.log("provider says hi");
    out.text("ignored in ndjson");
    out.result({ converged: true, iterations: 1 });
    const parsed = s.chunks.map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
    // Every line carries `t` (epoch ms) so persisted run logs can reconstruct a run's timing.
    for (const line of parsed) {
        expect(typeof line["t"]).toBe("number");
    }
    expect(parsed.map(({ t: _t, ...rest }) => rest)).toEqual([
        { kind: "node", phase: "apply", state: "start", id: "host", type: "host" },
        { kind: "log", message: "provider says hi" },
        { kind: "result", converged: true, iterations: 1 },
    ]);
});

test("json mode is silent during the run and emits one document at the end", () => {
    const s = sink();
    const out = createOutput(s, "json");
    out.onEvent(nodeStart);
    out.log("provider says hi");
    out.text("ignored in json");
    out.result({ converged: true, iterations: 1 });
    expect(s.chunks).toHaveLength(1);
    expect(JSON.parse(s.chunks[0] ?? "")).toEqual({ converged: true, iterations: 1 });
});

test("a redactor masks registered secret values out of every write, ignoring short ones", () => {
    const s = sink();
    const redactor = createRedactor();
    const out = createOutput(redactor.wrap(s), "text");
    redactor.add(["s3cr3t-token", "22", undefined]);
    out.log("auth with s3cr3t-token on port 22");
    expect(s.chunks.join("")).toContain("auth with \u00abredacted\u00bb on port 22");
});
