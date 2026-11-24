import { buildApplication, buildCommand, buildRouteMap, type CommandContext } from "@stricli/core";
import { captureCli } from "./testing.js";

// Both ways a command reaches the terminal, in one app: through its context, and through the global it is a view of.
const app = buildApplication(
    buildRouteMap({
        routes: {
            both: buildCommand({
                docs: { brief: "writes through the context and through the global, and sets an exit code directly" },
                parameters: { flags: {}, positional: { kind: "tuple", parameters: [] } },
                func(this: CommandContext) {
                    this.process.stdout.write("through the context\n");
                    process.stdout.write("through the global\n");
                    this.process.stderr.write("a reason\n");
                    process.exitCode = 1;
                },
            }),
        },
        docs: { brief: "fixture" },
    }),
    { name: "fixture", determineExitCode: () => 2 },
);

test("captures what a command writes through its context AND through the global process", () => {
    // The harness stands in for the process, not for the context: a message written the other way must not read
    // as silence, which is how a "nothing derivable" answer once passed as a printed one.
    return captureCli(app, ["both"]).then((outcome) => {
        expect(outcome.out).toBe("through the context\nthrough the global\n");
        expect(outcome.err).toBe("a reason\n");
        expect(outcome.exitCode).toBe(1);
    });
});

test("a code outside the contract is clamped to 2, and the real process is left as it was found", async () => {
    const before = process.exitCode;
    const outcome = await captureCli(app, ["no-such-verb"]);
    expect(outcome.exitCode).toBe(2);
    // Unset and 0 are one exit status, and unset is the one bun cannot be put back to.
    expect(process.exitCode ?? 0).toBe(before ?? 0);
});
