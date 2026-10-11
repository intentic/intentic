import { run, type StricliProcess } from "@stricli/core";
import { app } from "./app.js";

// A run on a pipe, as the desktop app and the sandbox daemon run this binary: what lands on each stream, and the code.
const piped = async (argv: readonly string[], ui = "plain"): Promise<{ out: string; err: string; exitCode: unknown }> => {
    const out: string[] = [];
    const err: string[] = [];
    const fake: StricliProcess = {
        stdout: { write: (chunk: string) => void out.push(chunk) },
        stderr: { write: (chunk: string) => void err.push(chunk) },
        env: { INTENTIC_UI: ui, NO_COLOR: "1" },
    };
    await run(app, [...argv], { process: fake });
    return { out: out.join(""), err: err.join(""), exitCode: fake.exitCode };
};

describe("a command that fails", () => {
    it("ends with error: <message> as the first stderr line on a pipe, nothing else, and exit 1", async () => {
        // Off Windows, `environment attach` refuses before it touches anything.
        if (process.platform === "win32") {
            return;
        }
        const { out, err, exitCode } = await piped(["environment", "attach", "Ubuntu"]);
        expect(exitCode).toBe(1);
        expect(out).toBe("");
        expect(err.split("\n")[0]).toMatch(/^error: \S/);
        expect(err).not.toContain("FAILED");
        expect(err).toBe(
            "error: Ubuntu is not kept running from here.\n   problem: only the Windows side of a device keeps its WSL distros running.\n",
        );
    });

    it("draws the stop block on a terminal, headline then problem", async () => {
        if (process.platform === "win32") {
            return;
        }
        const { out, err, exitCode } = await piped(["environment", "attach", "Ubuntu"], "rich");
        expect(exitCode).toBe(1);
        expect(out).toBe("");
        expect(err).toContain("Ubuntu is not kept running from here.");
        expect(err).toContain("problem:");
        expect(err).not.toContain("error:");
    });

    it("keeps stricli's own words for a command line that names nothing", async () => {
        const { err } = await piped(["no-such-command"]);
        expect(err).toContain("No command registered for");
    });
});

describe("version", () => {
    it("is the bare version string, which the release build and upgrade parse", async () => {
        const { out, err } = await piped(["version"]);
        expect(out).toMatch(/^\d+\.\d+\.\d+\n$/);
        expect(err).toBe("");
    });
});
