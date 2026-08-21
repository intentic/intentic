import { existsSync } from "node:fs";
import { run, type StricliProcess } from "@stricli/core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeRecallFixture } from "@intentic/iq-recall/testing";
import { app } from "../../app.js";
import { runHookMatch } from "./sessions.routes.js";

const SESSION_A = "aaaaaaaa-0000-4000-8000-000000000001";

let root: string;
let projectsDir: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
    const fixture = await makeRecallFixture();
    ({ root, projectsDir, cleanup } = fixture);
    process.env["WORKSPACE_ROOT"] = root;
    process.env["IQ_CLAUDE_DIR"] = fixture.claudeDir;
});
afterAll(async () => {
    delete process.env["WORKSPACE_ROOT"];
    delete process.env["IQ_CLAUDE_DIR"];
    await cleanup();
});

const invoke = async (argv: string[]): Promise<{ out: string; err: string; exitCode: number }> => {
    let out = "";
    let err = "";
    const fake = {
        stdout: { write: (chunk: string) => void (out += chunk) },
        stderr: { write: (chunk: string) => void (err += chunk) },
        env: process.env,
        exitCode: undefined as number | string | null | undefined,
    };
    await run(app, argv, { process: fake as unknown as StricliProcess });
    const code = typeof fake.exitCode === "number" ? fake.exitCode : 0;
    return { out, err, exitCode: code !== 0 && code !== 1 ? 2 : code };
};

test("sessions ingest reports counts", async () => {
    const { out, exitCode } = await invoke(["sessions", "ingest"]);
    expect(exitCode).toBe(0);
    expect(out).toMatch(/iq sessions: 2 sessions · 3 turns · 5 files across 2 transcripts/);
});

test("sessions list shows recent sessions and filters by query", async () => {
    const all = await invoke(["sessions", "list"]);
    expect(all.exitCode).toBe(0);
    expect(all.out).toContain("Fix JWT refresh rotation");
    expect(all.out).toContain("Unify workspace file icons");
    const filtered = await invoke(["sessions", "list", "jwt"]);
    expect(filtered.out).toContain("Fix JWT refresh rotation");
    expect(filtered.out).not.toContain("Unify workspace file icons");
});

test("sessions files ranks topical files; hits → 0, none → 1", async () => {
    const hit = await invoke(["sessions", "files", "JWT refresh token rotation"]);
    expect(hit.exitCode).toBe(0);
    expect(hit.out).toContain("src/auth/token.ts");
    expect(hit.out).not.toContain("package.json");
    const none = await invoke(["sessions", "files", "zz_never_zz"]);
    expect(none.exitCode).toBe(1);
});

test("sessions files --json emits a parseable array", async () => {
    const { out } = await invoke(["sessions", "files", "JWT refresh token rotation", "--json"]);
    const hits = JSON.parse(out) as { path: string; score: number }[];
    expect(hits.map((hit) => hit.path)).toContain("src/auth/login.ts");
});

test("sessions match surfaces the strong match with a fork suggestion", async () => {
    const { out, exitCode } = await invoke(["sessions", "match", "fix the JWT refresh token rotation in the auth service"]);
    expect(exitCode).toBe(0);
    expect(out).toContain(SESSION_A);
    expect(out).toContain("strong");
    expect(out).toContain(`fork it: iq sessions fork ${SESSION_A}`);
});

test("sessions grab prints asked→answered excerpts with a fork tip; none → 1", async () => {
    const hit = await invoke(["sessions", "grab", "JWT refresh token rotation"]);
    expect(hit.exitCode).toBe(0);
    expect(hit.out).toContain(`${SESSION_A}/0`);
    expect(hit.out).toContain("asked: Fix the JWT refresh token rotation");
    expect(hit.out).toContain("answered: The rotation bug is in token refresh.");
    expect(hit.out).toContain(`iq sessions fork ${SESSION_A} --at 0`);
    const none = await invoke(["sessions", "grab", "zz_never_zz"]);
    expect(none.exitCode).toBe(1);
});

test("sessions grab --json emits a parseable array", async () => {
    const { out } = await invoke(["sessions", "grab", "rotation bug", "--json"]);
    const excerpts = JSON.parse(out) as { sessionId: string; fragment: string }[];
    expect(excerpts[0]?.sessionId).toBe(SESSION_A);
    expect(excerpts[0]?.fragment).toContain("rotation bug");
});

test("hook mode emits additionalContext JSON only on a strong first-prompt match", async () => {
    let out = "";
    const write = (chunk: string): void => void (out += chunk);
    await runHookMatch(
        JSON.stringify({
            session_id: "fresh",
            transcript_path: "/nonexistent.jsonl",
            cwd: root,
            prompt: "fix the JWT refresh token rotation in the auth service",
        }),
        write,
    );
    const output = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput.additionalContext).toContain(`iq sessions fork ${SESSION_A}`);
    // The context carries the matched turns' asked→answered excerpts, not just the fork pointer.
    expect(output.hookSpecificOutput.additionalContext).toContain("asked: Fix the JWT refresh token rotation");
    expect(output.hookSpecificOutput.additionalContext).toContain("answered: The rotation bug is in token refresh.");
});

test("hook mode stays silent on non-first prompts, weak matches, and garbage input", async () => {
    let out = "";
    const write = (chunk: string): void => void (out += chunk);
    // The fixture transcript has two typed prompts, not a session start.
    await runHookMatch(
        JSON.stringify({
            session_id: "x",
            transcript_path: `${projectsDir}/${SESSION_A}.jsonl`,
            cwd: root,
            prompt: "fix the JWT refresh token rotation",
        }),
        write,
    );
    await runHookMatch(
        JSON.stringify({ session_id: "x", transcript_path: "/nonexistent.jsonl", cwd: root, prompt: "provision the kubernetes payments cluster" }),
        write,
    );
    await runHookMatch("not json at all", write);
    expect(out).toBe("");
});

test("the matched session never suggests forking itself", async () => {
    let out = "";
    await runHookMatch(
        JSON.stringify({
            session_id: SESSION_A,
            transcript_path: "/nonexistent.jsonl",
            cwd: root,
            prompt: "fix the JWT refresh token rotation in the auth service",
        }),
        (chunk) => void (out += chunk),
    );
    expect(out).not.toContain(SESSION_A);
});

test("sessions fork --dry-run reports without writing; real fork materializes a resumable transcript", async () => {
    const dry = await invoke(["sessions", "fork", SESSION_A, "--at", "0", "--dry-run"]);
    expect(dry.exitCode).toBe(0);
    expect(dry.out).toContain("would fork");
    expect(dry.out).not.toContain("claude --resume");
    const real = await invoke(["sessions", "fork", SESSION_A, "--at", "0"]);
    expect(real.exitCode).toBe(0);
    const forkedId = /claude --resume (\S+)/.exec(real.out)?.[1];
    expect(forkedId).toBeDefined();
    expect(existsSync(`${projectsDir}/${forkedId}.jsonl`)).toBe(true);
});

test("forking an unknown turn is a one-line usage error", async () => {
    const { exitCode, err } = await invoke(["sessions", "fork", SESSION_A, "--at", "99"]);
    expect(exitCode).toBe(2);
    expect(err).toContain("no turn 99");
});
