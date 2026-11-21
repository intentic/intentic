import { ORPCError } from "@orpc/server";
import type { ElevatedOutcome } from "../../admin/elevated.js";
import { answerOf, createRemotedService, outcomeFields, readServiceLine, type RemotedServiceSeams, serviceArgs } from "./remoted-service.js";

/* remoted's Windows service for the lock screen and administrator prompts, as the agent reads and changes it: what remoted
   is run with, how its one JSON line is read, when an installed service is older than the agent's remoted, and what one
   UAC prompt's ending comes to. Nothing runs: remoted's lines are the ones its `service` verbs print. */

const CLIENT = "C:\\Users\\radar\\.intentic\\machine\\bin\\intentic-remoted.exe";
const INSTALLED = JSON.stringify({
    supported: true,
    installed: true,
    state: "running",
    version: "1.430.0",
    binary: "C:\\ProgramData\\Intentic\\Remoted\\bin\\intentic-remoted.exe",
    clients: [CLIENT],
    helper: { session: 1, desktop: "Winlogon" },
});
const NOT_INSTALLED = JSON.stringify({ supported: true, installed: false });
const LINK = { sandboxUrl: "https://sandbox-abc.example.dev", log: () => undefined };

describe("what remoted is run with", () => {
    test("install names the agent's remoted as the client the service serves; status and uninstall take nothing", () => {
        expect(serviceArgs("install", CLIENT)).toEqual(["service", "install", "--client", CLIENT]);
        expect(serviceArgs("status", CLIENT)).toEqual(["service", "status"]);
        expect(serviceArgs("uninstall", CLIENT)).toEqual(["service", "uninstall"]);
        // An elevated run writes its answer to a file, since its stdout does not come back.
        expect(serviceArgs("install", CLIENT, "R")).toEqual(["service", "install", "--client", CLIENT, "--result", "R"]);
        expect(serviceArgs("uninstall", CLIENT, "R")).toEqual(["service", "uninstall", "--result", "R"]);
        expect(serviceArgs("status", CLIENT, "R")).toEqual(["service", "status"]);
    });
});

describe("remoted's status line", () => {
    test("is the last line of stdout, whatever came before it", () => {
        expect(readServiceLine(`opening the service manager\r\n${NOT_INSTALLED}\r\n`)).toEqual({ supported: true, installed: false });
        expect(readServiceLine(`${INSTALLED}\n`)).toEqual({
            supported: true,
            installed: true,
            state: "running",
            version: "1.430.0",
            helper: { session: 1, desktop: "Winlogon" },
        });
        expect(readServiceLine(JSON.stringify({ supported: false, reason: "not Windows" }))).toEqual({ supported: false, reason: "not Windows" });
        expect(readServiceLine(JSON.stringify({ error: "needs an administrator" }))).toEqual({ error: "needs an administrator" });
    });

    test("is nothing when the last line is not one remoted prints", () => {
        expect(readServiceLine("")).toBeUndefined();
        expect(readServiceLine(`${INSTALLED}\nerror: unrecognized subcommand 'service'`)).toBeUndefined();
        expect(readServiceLine(JSON.stringify({ supported: true, installed: true }))).toBeUndefined();
    });
});

describe("an installed service against the agent's remoted", () => {
    const line = { supported: true, installed: true, state: "running", version: "1.430.0", helper: null } as const;

    test("is out of date at another version, and current at the same one", () => {
        expect(answerOf(line, "1.431.0")).toEqual({
            supported: true,
            installed: true,
            state: "running",
            version: "1.430.0",
            agentVersion: "1.431.0",
            outOfDate: true,
            helper: null,
        });
        expect(answerOf(line, "1.430.0").outOfDate).toBe(false);
    });

    test("is never called out of date when the agent's version is not known, nor when nothing is installed", () => {
        expect(answerOf(line, undefined)).toEqual({ supported: true, installed: true, state: "running", version: "1.430.0", outOfDate: false, helper: null });
        expect(answerOf({ supported: true, installed: false }, "1.431.0")).toEqual({ supported: true, installed: false, outOfDate: false, agentVersion: "1.431.0" });
        expect(answerOf({ supported: false, reason: "not Windows" }, undefined)).toEqual({ supported: false, reason: "not Windows", installed: false, outOfDate: false });
    });
});

describe("what one prompt came to", () => {
    const now = { installed: true, outOfDate: false };
    const gone = { installed: false, outOfDate: false };

    test("a yes that did what it was asked says nothing more; one that did not says so", () => {
        expect(outcomeFields("install", { kind: "done" }, now)).toEqual({});
        expect(outcomeFields("uninstall", { kind: "done" }, gone)).toEqual({});
        expect(outcomeFields("install", { kind: "done" }, gone)).toEqual({ error: "Setting up the lock-screen service finished, but the service is not there." });
        expect(outcomeFields("install", { kind: "done" }, { installed: true, outOfDate: true })).toEqual({
            error: "Setting up the lock-screen service finished, but the service is still at its older version.",
        });
        expect(outcomeFields("uninstall", { kind: "done" }, now)).toEqual({ error: "Removing the lock-screen service finished, but the service is still there." });
    });

    test("a no is declined; a prompt never shown, one nobody answered and a failure are errors", () => {
        expect(outcomeFields("install", { kind: "declined" }, gone)).toEqual({ declined: true });
        expect(outcomeFields("install", { kind: "unstarted", why: "powershell.exe could not be started: ENOENT" }, gone)).toEqual({
            error: "Windows' administrator prompt could not be shown (powershell.exe could not be started: ENOENT).",
        });
        expect(outcomeFields("install", { kind: "failed", exitCode: null, said: "", timedOut: true }, gone)).toEqual({
            error: "Nobody answered Windows' administrator prompt within 10 minutes, so this stopped waiting.",
        });
        expect(outcomeFields("uninstall", { kind: "failed", exitCode: 1, said: "", timedOut: false }, now)).toEqual({
            error: "Removing the lock-screen service failed as administrator (intentic-remoted exited 1).",
        });
    });
});

interface Recorded {
    readonly ran: string[][];
    readonly elevated: string[][];
    readonly audited: { tool: string; ok: boolean; detail: string }[];
}

// A Windows agent whose remoted says `status` lines from `statuses` in turn and is version 1.431.0, whose prompt ends
// as `prompt` says, whose unelevated uninstall exits `quietExit` (3: no helper to ask), and whose elevated run wrote
// `answer` to its result file.
const windows = (
    statuses: string[],
    prompt: () => Promise<ElevatedOutcome> = async () => ({ kind: "done" }),
    { quietExit = 3, answer }: { quietExit?: number; answer?: string } = {},
) => {
    const recorded: Recorded = { ran: [], elevated: [], audited: [] };
    const seams: RemotedServiceSeams = {
        platform: "win32",
        beforeSignIn: () => false,
        binary: async () => CLIENT,
        run: async (_binary, args) => {
            recorded.ran.push([...args]);
            if (args[0] === "version") {
                return { exitCode: 0, stdout: "1.431.0\n" };
            }
            return args[1] === "uninstall" ? { exitCode: quietExit, stdout: "" } : { exitCode: 0, stdout: statuses.shift() ?? "" };
        },
        elevated: async (_binary, args) => {
            recorded.elevated.push([...args]);
            return await prompt();
        },
        resultFile: () => "RESULT",
        readResult: async () => answer,
        audit: async (entry) => void recorded.audited.push(entry),
    };
    return { recorded, seams };
};

const refusal = async (promise: Promise<unknown>): Promise<{ readonly code: string; readonly message: string }> => {
    try {
        await promise;
    } catch (error) {
        if (error instanceof ORPCError) {
            return { code: error.code, message: error.message };
        }
        throw error;
    }
    throw new Error("expected a refusal");
};

describe("the agent's remoteService", () => {
    test("answers supported: false off Windows without running anything", async () => {
        const { recorded, seams } = windows([]);
        const service = createRemotedService({ ...seams, platform: "linux" });
        expect(await service.run("install", LINK)).toMatchObject({ supported: false, installed: false, outOfDate: false });
        expect(recorded).toEqual({ ran: [], elevated: [], audited: [] });
    });

    test("reads the status unelevated, with no prompt and nothing audited", async () => {
        const { recorded, seams } = windows([INSTALLED]);
        expect(await createRemotedService(seams).run("status", LINK)).toEqual({
            supported: true,
            installed: true,
            state: "running",
            version: "1.430.0",
            agentVersion: "1.431.0",
            outOfDate: true,
            helper: { session: 1, desktop: "Winlogon" },
        });
        expect(recorded.ran.toSorted()).toEqual([["service", "status"], ["version"]]);
        expect(recorded.elevated).toEqual([]);
        expect(recorded.audited).toEqual([]);
    });

    test("installs through one prompt with the agent's remoted as client, then reads the status again, and audits it", async () => {
        const { recorded, seams } = windows([JSON.stringify({ ...JSON.parse(INSTALLED), version: "1.431.0" })]);
        const answer = await createRemotedService(seams).run("install", LINK);
        expect(recorded.elevated).toEqual([["service", "install", "--client", CLIENT, "--result", "RESULT"]]);
        expect(answer).toMatchObject({ installed: true, version: "1.431.0", outOfDate: false });
        expect(Object.keys(answer)).not.toContain("error");
        expect(recorded.audited).toEqual([
            { tool: "remoteService", ok: true, detail: "sandbox-abc.example.dev asked to install remoted's Windows service: done, now installed (1.431.0, running)" },
        ]);
    });

    test("a no comes back declined with the status as it stands, and audited as not done", async () => {
        const { recorded, seams } = windows([NOT_INSTALLED], async () => ({ kind: "declined" }));
        expect(await createRemotedService(seams).run("install", LINK)).toEqual({
            supported: true,
            installed: false,
            outOfDate: false,
            agentVersion: "1.431.0",
            declined: true,
        });
        expect(recorded.audited.map((entry) => entry.ok)).toEqual([false]);
    });

    test("one prompt at a time: a second change while the first waits is refused, and the first still ends", async () => {
        let answer: ((outcome: ElevatedOutcome) => void) | undefined;
        let shown: (() => void) | undefined;
        const promptUp = new Promise<void>((up) => void (shown = up));
        const { recorded, seams } = windows([NOT_INSTALLED], async () => {
            shown?.();
            return await new Promise<ElevatedOutcome>((done) => void (answer = done));
        });
        const service = createRemotedService(seams);
        const first = service.run("uninstall", LINK);
        await promptUp;
        const second = await refusal(service.run("install", LINK));
        expect(second.code).toBe("CONFLICT");
        expect(second.message).toContain("to remove the lock-screen service");
        answer?.({ kind: "done" });
        expect(await first).toMatchObject({ installed: false });
        expect(recorded.elevated).toEqual([["service", "uninstall", "--result", "RESULT"]]);
    });

    test("uninstall asks the running service to remove itself first, with no prompt", async () => {
        const { recorded, seams } = windows([NOT_INSTALLED], async () => ({ kind: "done" }), { quietExit: 0 });
        expect(await createRemotedService(seams).run("uninstall", LINK)).toMatchObject({ installed: false });
        expect(recorded.elevated).toEqual([]);
        expect(recorded.ran).toContainEqual(["service", "uninstall"]);
        expect(recorded.audited.map((entry) => entry.ok)).toEqual([true]);
    });

    test("an elevated run's failure carries the reason it wrote to its result file", async () => {
        const { seams } = windows([NOT_INSTALLED], async () => ({ kind: "failed", exitCode: 1, said: "", timedOut: false }), {
            answer: `${JSON.stringify({ error: "creating the service: Access is denied." })}\n`,
        });
        expect(await createRemotedService(seams).run("install", LINK)).toMatchObject({
            error: "Setting up the lock-screen service failed as administrator (intentic-remoted exited 1): creating the service: Access is denied.",
        });
    });

    test("refuses a change with nobody signed in, and says why remoted could not answer a status", async () => {
        const { seams } = windows([JSON.stringify({ error: "the service manager refused: access denied" })]);
        const early = await refusal(createRemotedService({ ...seams, beforeSignIn: () => true }).run("install", LINK));
        expect(early.code).toBe("CONFLICT");
        expect(early.message).toContain("Nobody has signed in on this PC");
        expect(await refusal(createRemotedService(seams).run("status", LINK))).toEqual({
            code: "INTERNAL_SERVER_ERROR",
            message: "intentic-remoted on this computer could not say whether its service is set up: the service manager refused: access denied.",
        });
    });

    test("a remoted that cannot be had is a refusal saying why", async () => {
        const { seams } = windows([]);
        const missing = await refusal(
            createRemotedService({
                ...seams,
                binary: async () => {
                    throw new Error("no intentic-remoted is published for win32 on arm64");
                },
            }).run("status", LINK),
        );
        expect(missing).toEqual({
            code: "PRECONDITION_FAILED",
            message: "Refused: there is no intentic-remoted on this computer to ask: no intentic-remoted is published for win32 on arm64",
        });
    });
});
