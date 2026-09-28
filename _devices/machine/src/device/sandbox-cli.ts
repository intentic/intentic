import { buildCommand, buildRouteMap, type CommandContext, type FlagParametersForType } from "@stricli/core";
import { runIcAttached } from "./tools/sandboxes.js";

// `intentic-machine sandbox <verb> [slug]`: ic's own sandbox verbs, passed through, so a sandbox on this machine can be
// looked at and repaired from the agent's CLI when no browser can reach it (the one it runs in is down, say). Nothing
// is decided here: ic prints what it prints, straight to this terminal, and its exit code is this command's.

// The flags each verb passes on, as stricli parsed them: a boolean is its bare flag, a value follows its flag.
type PassedFlags = Readonly<Record<string, boolean | string | undefined>>;

const kebab = (name: string): string => name.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

// The argv for one verb. Pure, so the spelling of every flag is asserted without an ic.
export const icPassArgs = (verb: string, slug: string | undefined, flags: PassedFlags): string[] => [
    "sandbox",
    verb,
    ...(slug === undefined ? [] : [slug]),
    ...Object.entries(flags).flatMap(([name, value]) => {
        if (value === undefined || value === false) {
            return [];
        }
        return value === true ? [`--${kebab(name)}`] : [`--${kebab(name)}`, value];
    }),
];

const pass = async (verb: string, slug: string | undefined, flags: PassedFlags): Promise<void> => {
    process.exitCode = await runIcAttached(icPassArgs(verb, slug, flags));
};

const SLUG = { brief: "The sandbox (omit when this machine runs exactly one)", parse: String, optional: true, placeholder: "slug" } as const;

// One verb that takes an optional slug and the flags given, all passed through.
const verbCommand = <F extends PassedFlags>(verb: string, brief: string, flags: FlagParametersForType<F>) =>
    buildCommand<F, [string | undefined]>({
        docs: { brief },
        parameters: { flags, positional: { kind: "tuple", parameters: [SLUG] } },
        async func(this: CommandContext, given: F, slug: string | undefined) {
            await pass(verb, slug, given);
        },
    });

const json = { kind: "boolean", optional: true, brief: "Answer in JSON, as programs read it" } as const;
const skipPreflight = {
    kind: "boolean",
    optional: true,
    brief: "Swap without first running the target image's state conversions against read-only copies of its data",
} as const;

// A type rather than an interface: it is read as a record of flags (PassedFlags), which an interface never is.
type JsonFlags = {
    readonly json?: boolean;
};

const list = buildCommand<JsonFlags>({
    docs: { brief: "List the sandboxes on this machine" },
    parameters: { flags: { json } },
    async func(this: CommandContext, given: JsonFlags) {
        await pass("list", undefined, given);
    },
});

type UpdateFlags = {
    readonly channel?: string;
    readonly force?: boolean;
    readonly skipPreflight?: boolean;
};

type RollbackFlags = {
    readonly to?: string;
    readonly skipPreflight?: boolean;
};

type LogsFlags = {
    readonly tail?: string;
};

type BackupFlags = {
    readonly auto?: boolean;
    readonly json?: boolean;
};

// A positive whole number, as ic's `--tail` takes it; anything else is refused here rather than by ic's usage text.
const lineCount = (value: string): string => {
    if (!/^\d+$/.test(value) || Number(value) === 0) {
        throw new Error(`"${value}" is not a number of lines.`);
    }
    return value;
};

export const sandboxRoutes = buildRouteMap({
    routes: {
        list,
        start: verbCommand<Record<never, never>>("start", "Start a sandbox and its tunnel (a parked one included), applying a shape saved for its next restart", {}),
        stop: verbCommand<Record<never, never>>("stop", "Stop a sandbox and its tunnel", {}),
        restart: verbCommand<Record<never, never>>("restart", "Restart a sandbox and its tunnel, applying a shape saved for its next restart", {}),
        update: verbCommand<UpdateFlags>("update", "Update a sandbox onto the newest image of its release channel, keeping its files and history", {
            channel: { kind: "parsed", parse: String, optional: true, brief: "Move onto a release channel and stay there (e.g. stable)" },
            force: { kind: "boolean", optional: true, brief: "Update a sandbox built from a checkout anyway, leaving its local image behind" },
            skipPreflight,
        }),
        rollback: verbCommand<RollbackFlags>("rollback", "Put a sandbox back on the version it ran before, or on an older one kept on this machine", {
            to: { kind: "parsed", parse: String, optional: true, brief: "The version or image to go back to (`versions` lists them)" },
            skipPreflight,
        }),
        versions: verbCommand<JsonFlags>("versions", "The versions a sandbox can go back to on this machine", { json }),
        logs: verbCommand<LogsFlags>("logs", "The tail of a sandbox's own log, both streams", {
            tail: { kind: "parsed", parse: lineCount, optional: true, brief: "How many of the last lines to print (200 unless given)" },
        }),
        doctor: verbCommand<Record<never, never>>("doctor", "Check every link of a sandbox's reachability chain and name what is broken, with its fix", {}),
        watch: verbCommand<JsonFlags>("watch", "Finish or undo an interrupted swap, and judge a new version on probation (every sandbox unless one is named)", {
            json,
        }),
        backup: verbCommand<BackupFlags>("backup", "Back a sandbox up now, encrypted, on this machine", {
            auto: { kind: "boolean", optional: true, brief: "Skip it when one ran recently, the disk is low or a swap is in flight, as the daily backup does" },
            json,
        }),
        backups: verbCommand<JsonFlags>("backups", "The backups this machine holds of a sandbox", { json }),
    },
    docs: { brief: "Look at and repair the sandboxes on this machine without a browser: ic's own verbs, passed through" },
});
