import { clipText } from "@intentic/base/process";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { z } from "zod";
import { assertScope } from "../../policy.js";
import { icOutOfDate } from "../ic-binary.js";
import { ADDRESSABLE_SLUG, runIc } from "../sandboxes.js";

// `inspect_sandbox`: another sandbox's conversations, transcripts and diagnostics, read through `ic sandbox inspect` and
// that sandbox's own `agents` and `diagnostics` commands, in place of an agent's own `docker exec` through run_command
// (one once read another sandbox's /history as root that way). Like every sandbox tool here (sandboxes.ts) it is a
// caller of ic, which owns the list of reads (_sandbox/ic/src/sandbox/inspect.rs); the same list is checked here too, so
// a model reads the refusal before anything runs. `--on` reads a linked sandbox instead and `--out` writes a file, so
// both are refused wherever they stand. The names and numbers are exported for the MCP tool's schema.

export const InspectCommandSchema = z.enum(["agents", "diagnostics"]);
export type InspectCommand = z.infer<typeof InspectCommandSchema>;

export const INSPECT_READS = {
    agents: ["ls", "show", "find", "bundle"],
    diagnostics: ["errors", "slow", "turns", "resources", "restarts", "timeline", "failures"],
} as const satisfies Record<InspectCommand, readonly string[]>;

// A read is a verb, a handle and a few flags; past these it is not a read anyone typed.
export const MAX_INSPECT_ARGS = 24;
export const MAX_INSPECT_ARG_LENGTH = 500;

const either = (words: readonly string[]): string => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`);

// Said under every refusal, in ic's own words.
const ALLOWED = `Allowed: agents ${either(INSPECT_READS.agents)}; diagnostics ${either(INSPECT_READS.diagnostics)}; or either one's --help.`;

const refusedFlag = (arg: string): "--on" | "--out" | undefined =>
    (["--on", "--out"] as const).find((flag) => arg === flag || arg.startsWith(`${flag}=`));

const isCommand = (command: string): command is InspectCommand => InspectCommandSchema.safeParse(command).success;

// The argv `ic sandbox inspect` runs for one read, or the sentence refusing it. `--` goes before the command's words:
// ic would otherwise take a leading `--help` for its own, and everything after it is the command's. Pure.
export const icInspectArgs = (slug: string, command: string, args: readonly string[]): string[] => {
    if (!ADDRESSABLE_SLUG.test(slug)) {
        throw new Error(`"${slug}" is not a sandbox slug; list_sandboxes names them.`);
    }
    if (!isCommand(command)) {
        throw new Error(`inspect_sandbox runs agents or diagnostics, not "${command}". ${ALLOWED}`);
    }
    if (args.length > MAX_INSPECT_ARGS) {
        throw new Error(`A read takes at most ${MAX_INSPECT_ARGS} arguments; this one has ${args.length}.`);
    }
    if (args.some((arg) => arg.length > MAX_INSPECT_ARG_LENGTH)) {
        throw new Error(`Each argument is at most ${MAX_INSPECT_ARG_LENGTH} characters; narrow the search instead.`);
    }
    const flag = args.map(refusedFlag).find((found) => found !== undefined);
    if (flag === "--on") {
        throw new Error(
            `inspect_sandbox reads only the named sandbox's own records, so it does not take --on (that reads a linked sandbox). ${ALLOWED}`,
        );
    }
    if (flag === "--out") {
        throw new Error(`inspect_sandbox answers with what it reads and writes no file, so it does not take --out. ${ALLOWED}`);
    }
    const [verb] = args;
    if (verb === undefined || verb === "") {
        throw new Error(`inspect_sandbox needs to know what ${command} should read: its first argument is the verb. ${ALLOWED}`);
    }
    if (verb === "--help" || verb === "-h") {
        if (args.length > 1) {
            throw new Error(`${command} --help takes nothing after it. ${ALLOWED}`);
        }
    } else if (!INSPECT_READS[command].some((read) => read === verb)) {
        throw new Error(`inspect_sandbox does not run ${command} ${verb}: it only reads. ${ALLOWED}`);
    }
    return ["sandbox", "inspect", slug, command, "--", ...args];
};

// ic bounds the read itself at 60 seconds; this covers docker's start and ic's own checks before it.
const DEADLINE_MS = 90_000;

// What a read answers with at most, as run_command's does: a transcript or a bundle can run to megabytes, and the answer
// crosses the same WebSocket as everything else this machine is doing.
const MAX_INSPECT_OUTPUT = 100_000;

// An ic from before `inspect` refuses the verb in clap's words: "error: unrecognized subcommand 'inspect'". Pure.
export const icLacksInspect = (output: string): boolean => /unrecognized subcommand '?inspect'?/.test(output);

// One read, gated like the logs: either switch opens it. No `find` first, like the doctor: ic refuses a slug it does not
// have, and says when the sandbox is stopped or asleep. Both streams arrive as one text, as every ic answer here does; a
// read that failed is the command's own words, as an error.
export const inspectSandbox = async (slug: string, command: InspectCommand, args: readonly string[], scopes: DeviceScopes): Promise<string> => {
    if (scopes.shell !== "on") {
        assertScope(scopes, "sandboxes");
    }
    const run = await runIc(icInspectArgs(slug, command, args), () => {}, {}, { deadlineMs: DEADLINE_MS });
    if (run.code !== 0 && icLacksInspect(run.output)) {
        const stale = icOutOfDate();
        throw new Error(
            `The ic on this device is older than inspect_sandbox, so it has no \`ic sandbox inspect\`. Updating ic brings it: this agent fetches its own release's ic before a sandbox action, and re-running a sandbox's install command on this device installs a current one.${stale === undefined ? "" : `\n\n${stale}`}`,
        );
    }
    const { text, dropped } = clipText(run.output, MAX_INSPECT_OUTPUT);
    const cut =
        dropped === 0
            ? ""
            : `\n\nToo long to return whole: ${dropped} characters from the middle are left out, where it says so. Narrow the read (--last, --limit, --grep, --since) for the rest.`;
    if (run.code !== 0) {
        throw new Error(`${command} ${args[0] ?? ""} in "${slug}" ended with exit code ${run.code}.\n\n${text}${cut}`);
    }
    return text === "" ? `${command} in "${slug}" printed nothing.` : `${text}${cut}`;
};
