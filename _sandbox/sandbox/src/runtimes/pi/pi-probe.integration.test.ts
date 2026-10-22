import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probePiAgent } from "./pi-probe.js";

let dir: string;
let command: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-probe-"));
    const script = join(dir, "pi.mjs");
    writeFileSync(
        script,
        `
        import { readFileSync } from "node:fs";
        const args = process.argv.slice(2);
        for (const flag of ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline"]) {
            if (!args.includes(flag)) throw new Error("missing flag " + flag);
        }
        if (args[args.indexOf("--mode") + 1] !== "rpc") throw new Error("expected RPC");
        const requests = readFileSync(0, "utf8").trim().split("\\n").map(JSON.parse);
        if (requests.length !== 1 || requests[0].type !== "get_available_models") throw new Error("unexpected request");
        if (process.env.PROBE_MODE === "fail") { console.error("invalid Pi settings"); process.exit(2); }
        if (process.env.PROBE_MODE === "noise") { console.log("another CLI entirely"); process.exit(0); }
        const models = process.env.PROBE_MODE === "ready" ? [{provider: "anthropic", id: "claude-test"}] : [];
        console.log("startup noise");
        console.log(JSON.stringify({type:"response", id: process.env.PROBE_MODE === "wrong-id" ? "other" : requests[0].id, success: true, data:{models}}));
    `,
    );
    command = `${process.execPath} ${script}`;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a missing Pi CLI reports the rebuild needed to install it, without throwing a spawn error", async () => {
    expect(await probePiAgent({ command: join(dir, "missing-pi") }, dir)).toEqual({
        state: "pending",
        detail: "Pi is not installed yet. Rebuild the sandbox from Sandbox > Environment, then sign in to Pi.",
    });
});

test("a Pi with no configured model reports sign-in pending over RPC", async () => {
    expect(await probePiAgent({ command }, dir)).toEqual({
        state: "pending",
        detail: "Pi needs a model provider. Open Sign in, run /login (for Claude, /login anthropic), then choose a model with /model.",
    });
});

test("configured models and the card's environment make Pi active without a prompt or a saved session", async () => {
    expect(await probePiAgent({ command, env: "PROBE_MODE=ready" }, dir)).toEqual({ state: "active", detail: "Pi RPC · 1 model" });
});

test("a non-Pi command or a response to another request does not pass the RPC check", async () => {
    for (const mode of ["noise", "wrong-id"]) {
        await expect(probePiAgent({ command, env: `PROBE_MODE=${mode}` }, dir)).rejects.toThrow("Pi did not answer get_available_models over RPC");
    }
});

test("Pi's startup failure is surfaced, and a blank command is refused", async () => {
    await expect(probePiAgent({ command, env: "PROBE_MODE=fail" }, dir)).rejects.toThrow("Pi RPC probe failed: invalid Pi settings");
    await expect(probePiAgent({ command: " " }, dir)).rejects.toThrow("Pi command is empty");
});
