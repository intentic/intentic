import { z } from "zod";

// WHICH DEVICE TOOLS CARRY A PROGRAM (2026-10-12). A command on somebody's own computer arrives by more doors than
// `run_command`: `app_start` starts a program with arguments, `open` starts whatever its target names (on Linux a
// target with spaces is split into a program and arguments and spawned), `android_shell` hands a line to a phone's
// shell, and the input tools put text where a terminal could run it. The daemon's gate used to know two of those by
// name, the machine's own checks a different few, and `app_start program=powershell args=[…]` slipped past the judge, the
// card and the unattended refusal. This is the one table both ends read: the tool, and how to lift the command line
// out of its arguments. A device tool that carries a program is added here, or the machine's test says it is missing.

/**
 * What a call's program is, which decides how it is read:
 * - `command`: a command line for the machine's own shell, or a program started with arguments; judged as `run_command`.
 * - `phone-command`: a line for an attached phone's shell, judged as the `adb shell` program the machine runs for it.
 * - `app-launch`: an application, URL or document started with nothing to interpret; the ordinary GUI launch, low risk.
 * - `typed`: text put where a terminal could run it (typed, pasted, set into a field).
 */
export type ProgramKind = "command" | "phone-command" | "app-launch" | "typed";

/** The program a tool call carries, as the classifier and the judge read it. */
export interface ProgramReading {
    readonly tool: string;
    readonly kind: ProgramKind;
    /** The command line as a shell would read it. */
    readonly commandLine: string;
}

// The fields of every tool in the table below. One that is the wrong type reads as absent rather than failing the
// parse: such a call never runs, since the device checks its input against its own schema before anything else.
export const ProgramArgumentsSchema = z.looseObject({
    command: z.string().optional().catch(undefined),
    serial: z.string().optional().catch(undefined),
    program: z.string().optional().catch(undefined),
    args: z.array(z.string()).optional().catch(undefined),
    target: z.string().optional().catch(undefined),
    action: z.string().optional().catch(undefined),
    text: z.string().optional().catch(undefined),
    value: z.string().optional().catch(undefined),
});
export type ProgramArguments = z.infer<typeof ProgramArgumentsSchema>;

interface ProgramCarrier {
    readonly tool: string;
    /** In words: where the program is in the arguments. */
    readonly carries: string;
    readonly read: (args: ProgramArguments) => Omit<ProgramReading, "tool"> | undefined;
}

const present = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value);

// A program by the name it is known by (`rm`, `powershell`), not the path or the `.exe` it was started through.
const programName = (program: string): string => (program.split(/[/\\]/).at(-1) ?? program).replace(/\.exe$/i, "");

/**
 * The program and its arguments as the one command line they amount to: the program by its name, each argument quoted
 * only where a shell would need it, so the line reads the way a person would type it.
 */
export const commandLineOf = (program: string, args: readonly string[]): string =>
    [
        programName(program),
        ...args.map((arg) => (arg === "" || /[\s'"|;&<>()$`\\]/.test(arg) ? (arg.includes("'") ? `"${arg}"` : `'${arg}'`) : arg)),
    ].join(" ");

// A phone's serial as adb prints one (a USB serial, `ip:port`, an mDNS name), and nothing else: a serial is spliced into
// the program judged below, where a `#` or a quote in it could make the command after it read as inert.
const ADB_SERIAL = /^[\w.:-]+$/;

// A URL, or `www.`/`mailto:` which the machine opens the same way (desktop-automation's looksLikeUrl).
const URL_TARGET = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)/i;

const typedBy = (tool: string, action: string, field: "text" | "value"): ProgramCarrier => ({
    tool,
    carries: `${field}, when action is ${action}`,
    read: (args) => {
        const typed = args.action === action ? present(args[field]) : undefined;
        return typed === undefined ? undefined : { kind: "typed", commandLine: typed };
    },
});

/** Every device tool that carries a program. */
export const DEVICE_PROGRAM_TOOLS: readonly ProgramCarrier[] = [
    {
        tool: "run_command",
        carries: "command",
        read: ({ command }) => {
            const line = present(command);
            return line === undefined ? undefined : { kind: "command", commandLine: line };
        },
    },
    {
        tool: "android_shell",
        carries: "command, run as `adb [-s serial] shell <command>`",
        read: ({ command, serial }) => {
            const line = present(command);
            if (line === undefined) {
                return undefined;
            }
            return { kind: "phone-command", commandLine: `adb ${serial !== undefined && ADB_SERIAL.test(serial) ? `-s ${serial} ` : ""}shell ${line}` };
        },
    },
    {
        tool: "app_start",
        carries: "program and args",
        read: ({ program, args }) => {
            const started = present(program);
            if (started === undefined) {
                return undefined;
            }
            // With nothing to interpret it is a launch; with arguments it is a command by another door, whatever the
            // program is: `rm -rf ~`, `curl … | sh` and `powershell -c …` read the same here as in run_command.
            return { kind: args === undefined || args.length === 0 ? "app-launch" : "command", commandLine: commandLineOf(started, args ?? []) };
        },
    },
    {
        tool: "open",
        carries: "target",
        read: ({ target }) => {
            const opened = present(target);
            if (opened === undefined) {
                return undefined;
            }
            // A URL or a single word (an application name, a file path) is opened. A target with spaces that is not a URL
            // can be split into a program and arguments and spawned, so it is read as the command it may be.
            return { kind: URL_TARGET.test(opened) || !/\s/.test(opened.trim()) ? "app-launch" : "command", commandLine: opened };
        },
    },
    typedBy("device", "type", "text"),
    typedBy("android_act", "type", "text"),
    typedBy("clipboard", "write", "text"),
    typedBy("ui_act", "set_value", "value"),
];

/** The program a `tools/call` of `tool` carries, or undefined for a tool that carries none or a call with nothing in the place the table looks. */
export const programInCall = (tool: string, args: ProgramArguments): ProgramReading | undefined => {
    const read = DEVICE_PROGRAM_TOOLS.find((carrier) => carrier.tool === tool)?.read(args);
    return read === undefined ? undefined : { tool, ...read };
};
