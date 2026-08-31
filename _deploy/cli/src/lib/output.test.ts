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
    const applied: EngineEvent = { kind: "node", phase: "apply", state: "done", id: "host", type: "host", action: "create", reason: "not observed" };
    out.onEvent(applied);
    const waiting: EngineEvent = { kind: "readiness", state: "waiting", id: "wiki", url: "https://wiki.example.com" };
    out.onEvent(waiting);
    const ready: EngineEvent = { kind: "readiness", state: "ready", id: "wiki", url: "https://wiki.example.com" };
    out.onEvent(ready);
    out.onEvent({ kind: "node", phase: "plan", state: "start", id: "host", type: "host" }); // plan prints its own table
    out.onEvent({ kind: "iteration", n: 1, converged: true }); // stream-only
    const logLine = "provider says hi";
    const summaryLine = "converged in 1 iteration(s)";
    out.log(logLine);
    out.text(summaryLine);
    out.result({ converged: true }); // text already printed; result is a no-op

    const rendered = s.chunks.join("");
    expect(rendered).toContain(`"${pruneDeleted.id}"`);
    expect(rendered).toContain(`"${pruneDeleted.type}"`);
    expect(rendered).toContain(`"${nodeStart.id}"`);
    expect(rendered).toContain(applied.action!);
    expect(rendered).toContain(applied.reason!);
    expect(rendered).toContain(`"${waiting.id}"`);
    expect(rendered).toContain(waiting.url);
    expect(rendered).toContain(`"${ready.id}"`);
    expect(rendered).toContain(logLine);
    expect(rendered).toContain(summaryLine);
    expect(s.chunks).toHaveLength(7);
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
    const secret = "s3cr3t-token";
    const port = "22";
    redactor.add([secret, port, undefined]);
    out.log(`auth with ${secret} on port ${port}`);
    redactor.flush();
    const rendered = s.chunks.join("");
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain("\u00abredacted\u00bb");
    expect(rendered).toContain(`port ${port}`);
});

/* The chunk boundaries below are not the caller's to choose: providers stream a remote command's output, so
 * the split lands wherever the kernel's read sizes put it. A redactor that masks per chunk therefore leaks or
 * doesn't depending on timing \u2014 these assert on the STREAM. */

test("a secret split across two writes is still masked", () => {
    const s = sink();
    const redactor = createRedactor();
    const wrapped = redactor.wrap(s);
    const secret = "s3cr3t-token";
    const port = "22";
    redactor.add([secret]);
    wrapped.write(`auth with ${secret.slice(0, 10)}`);
    // Nothing containing the first half may have reached the sink yet \u2014 that half is a possible secret prefix.
    expect(s.chunks.join("")).not.toContain(secret.slice(0, 6));
    wrapped.write(`${secret.slice(10)} on port ${port}\n`);
    redactor.flush();
    const rendered = s.chunks.join("");
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain("\u00abredacted\u00bb");
    expect(rendered).toContain(`port ${port}`);
});

test("a multi-line secret split mid-value is masked across the boundary", () => {
    const s = sink();
    const redactor = createRedactor();
    const wrapped = redactor.wrap(s);
    const key = "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----";
    redactor.add([key]);
    for (const chunk of [`installing\n${key.slice(0, 25)}`, key.slice(25), "\ndone\n"]) {
        wrapped.write(chunk);
    }
    redactor.flush();
    const rendered = s.chunks.join("");
    expect(rendered).not.toContain(key);
    expect(rendered).toContain("\u00abredacted\u00bb");
    expect(rendered.startsWith("installing\n")).toBe(true);
    expect(rendered.endsWith("\ndone\n")).toBe(true);
});

test("ordinary output is not delayed \u2014 only a tail that could still become a secret waits", () => {
    const s = sink();
    const redactor = createRedactor();
    const wrapped = redactor.wrap(s);
    redactor.add(["s3cr3t-token"]);
    wrapped.write("applying host-a\n");
    // No suffix of this is a prefix of the secret, so it flows straight through rather than waiting for a
    // later write \u2014 a long apply's progress lines must not stall behind the redactor.
    const line = "applying host-a\n";
    expect(s.chunks.join("")).toBe(line);
});

test("flush writes back a held tail that never turned out to be a secret", () => {
    const s = sink();
    const redactor = createRedactor();
    const wrapped = redactor.wrap(s);
    redactor.add(["s3cr3t-token"]);
    // Ends mid-way through a possible secret, and the command then ends. Without flush this line is lost.
    wrapped.write("the prefix is s3cr3t");
    redactor.flush();
    expect(s.chunks.join("")).toBe("the prefix is s3cr3t");
});
