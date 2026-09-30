import { buildCommand, buildRouteMap, type CommandContext, type FlagParametersForType } from "@stricli/core";
import { runLogPath } from "../config.js";
import { type MachineConfig, readMachineConfig, updateMachineConfig } from "../environments/machine.js";
import { ensureResident } from "../resident.js";
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

type FixFlags = {
    readonly code?: string;
    readonly auto?: boolean;
    readonly yes?: boolean;
    readonly accept?: string;
    readonly json?: boolean;
    readonly source?: string;
};

// A positive whole number, as ic's `--tail` takes it; anything else is refused here rather than by ic's usage text.
const lineCount = (value: string): string => {
    if (!/^\d+$/.test(value) || Number(value) === 0) {
        throw new Error(`"${value}" is not a number of lines.`);
    }
    return value;
};

/* THE KEEPER'S SWITCH (sandbox-rounds/keeper.ts), kept in this environment's machine.json: on is the resting state,
   stored as the key's absence, and only an explicit off is written down, as the `updates` switches are. It is this
   environment's own rather than the PC's, since the keeper acts on the sandboxes this environment's ic keeps. */

type KeeperWord = "on" | "off" | "status";

const keeperWord = (value: string): KeeperWord => {
    if (value === "on" || value === "off" || value === "status") {
        return value;
    }
    throw new Error(`"${value}" is not on, off or status.`);
};

// The config with the keeper switched as asked, every other key as it was. Pure, so what is written is asserted.
export const withKeeper = (config: MachineConfig, on: boolean): MachineConfig => {
    const { sandboxKeeper: _was, ...rest } = config;
    return on ? rest : { ...rest, sandboxKeeper: false };
};

export const keeperStatus = (on: boolean): string =>
    on
        ? `Keeper: on. When a sandbox on this machine stops answering (and half a minute after this agent starts, and every five minutes), this agent runs \`ic sandbox fix --auto\`: it starts Docker Desktop, starts a sandbox nobody stopped on purpose, restarts one whose registration gave up and tidies a full disk. A fix that needs your yes is only reported; \`intentic-machine sandbox fix <slug>\` asks you for it. What it did is in ${runLogPath}. Turn it off with \`intentic-machine sandbox keeper off\`.`
        : "Keeper: off. Nothing brings this machine's sandboxes back by itself; `intentic-machine sandbox fix` does when you run it. Turn it back on with `intentic-machine sandbox keeper on`.";

const keeper = buildCommand<Record<never, never>, [KeeperWord | undefined]>({
    docs: { brief: "Whether this agent brings this machine's sandboxes back by itself (`ic sandbox fix --auto`): on, off, or status" },
    parameters: {
        positional: {
            kind: "tuple",
            parameters: [{ brief: "on, off or status (status unless given)", parse: keeperWord, optional: true, placeholder: "on|off|status" }],
        },
    },
    async func(this: CommandContext, _flags: Record<never, never>, word: KeeperWord | undefined) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        if (word === "on" || word === "off") {
            await updateMachineConfig((config) => withKeeper(config, word === "on"));
            // The keeper is one reason the agent stays resident on a machine with nothing linked: on starts it for the
            // sandboxes here, off lets it go when they were all it had (resident.ts, keptSandboxes).
            await ensureResident(out);
        }
        out(keeperStatus((await readMachineConfig()).sandboxKeeper !== false));
    },
});

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
        fix: verbCommand<FixFlags>(
            "fix",
            "Check every layer a sandbox needs on this machine, fix what is safe and ask before anything else (every sandbox unless one is named)",
            {
                code: { kind: "parsed", parse: String, optional: true, brief: "The fix code from the browser's recovery panel, so that page follows this run" },
                auto: { kind: "boolean", optional: true, brief: "Apply only the fixes that need no yes and report the rest, as the keeper does" },
                yes: { kind: "boolean", optional: true, brief: "Say yes to every fix that asks" },
                accept: { kind: "parsed", parse: String, optional: true, brief: "Say yes to these checks' fixes only, by id, comma-separated" },
                json,
                source: { kind: "parsed", parse: String, optional: true, brief: "Who the report names as asking: agent, command or app" },
            },
        ),
        keeper,
    },
    docs: { brief: "Look at and repair the sandboxes on this machine without a browser: ic's own verbs, passed through" },
});
