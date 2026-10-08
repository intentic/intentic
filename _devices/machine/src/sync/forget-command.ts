import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";
import type { Log } from "@intentic/local-agent";
import { buildCommand, type CommandContext } from "@stricli/core";
import { z } from "zod";
import { agentInDistro } from "../environments/crossing.js";
import { heldDistros } from "../environments/machine.js";
import { WINDOWS_SIDE } from "../wsl.js";
import { readState } from "./config.js";
import { ensureMutagen } from "./mutagen.js";
import { answer } from "./project/project-commands.js";
import { retireSandbox, type Retired, sandboxesNamed } from "./retire.js";

// `intentic-machine sync forget <slug|sandboxId>` (2026-10-05): retire every pairing of one sandbox NOW, with the same
// retirement the watcher gives a sandbox gone past the trash window (retire.ts): its sessions, forwards, ssh entry, host
// key, hash caches and git bridge go; its folders and their restore points stay. What `ic sandbox remove` calls, best
// effort, so a sandbox removed on this machine leaves no pairing behind in any environment of it. On a Windows PC's
// Windows side it also asks each supervised WSL distro's agent to do the same (`--here` there, so the question goes no
// further), since each environment keeps its own `sync.json`. Naming nothing paired is not a failure: there is nothing
// to forget, and the caller is a removal that has already happened.
//
// With `--json`, one object on stdout: `{ ok: true, retired: [{ sandboxId, pairings, folders }], environments?: [{
// environment, ok, retired?, error? }] }`, or `{ ok: false, error }` with exit code 1.

const exec = promisify(execFile);

// A distro's agent retiring its pairings: a Mutagen call or two and a few file writes, plus a cold distro's boot.
const DISTRO_TIMEOUT_MS = 120_000;

export interface EnvironmentForgot {
    readonly environment: string;
    readonly ok: boolean;
    readonly retired?: readonly Retired[];
    readonly error?: string;
}

export interface Forgot {
    readonly ok: true;
    readonly retired: readonly Retired[];
    readonly environments?: readonly EnvironmentForgot[];
}

// The one JSON object a distro's agent printed last, read leniently: an agent older than the verb exits non-zero and says
// so in words, which is that environment's answer.
const RetiredSchema = z.object({ sandboxId: z.string(), pairings: z.array(z.string()), folders: z.array(z.string()) });
const DistroAnswerSchema = z.union([
    z.object({ ok: z.literal(true), retired: z.array(RetiredSchema).catch([]) }),
    z.object({ ok: z.literal(false), error: z.string() }),
]);

const lastObject = (stdout: string): unknown => {
    const line = stdout
        .split(/\r?\n/)
        .map((text) => text.trim())
        .findLast((text) => text.startsWith("{"));
    try {
        return line === undefined ? undefined : JSON.parse(line);
    } catch {
        // allow(silent-catch): an answer that is not JSON is said in its own words (distroAnswer)
        return undefined;
    }
};

export const distroAnswer = (environment: string, status: number, stdout: string, stderr: string): EnvironmentForgot => {
    const parsed = DistroAnswerSchema.safeParse(lastObject(stdout));
    if (parsed.success) {
        return parsed.data.ok ? { environment, ok: true, retired: parsed.data.retired } : { environment, ok: false, error: parsed.data.error };
    }
    const said = `${stderr}${stdout}`.trim().split(/\r?\n/)[0] ?? "";
    return { environment, ok: false, error: said === "" ? `its agent exited with ${status}` : said };
};

const forgetInDistro = async (distro: string, name: string): Promise<EnvironmentForgot> => {
    const { command, args } = agentInDistro(distro, ["sync", "forget", name, "--here", "--json"]);
    return await exec(command, [...args], { timeout: DISTRO_TIMEOUT_MS, windowsHide: true, env: { ...process.env, WSL_UTF8: "1" } }).then(
        (ran) => distroAnswer(`wsl:${distro}`, 0, ran.stdout, ran.stderr),
        // execFile's rejection carries the child's exit code and both streams; a spawn failure carries neither.
        (error: { readonly code?: number | string; readonly stdout?: string; readonly stderr?: string; readonly message?: string }) =>
            distroAnswer(
                `wsl:${distro}`,
                Number.isInteger(error.code) ? Number(error.code) : 1,
                error.stdout ?? "",
                error.stderr ?? errorMessage(error),
            ),
    );
};

export const forgetSandbox = async (
    name: string,
    log: Log,
    { here = false, mutagen: resolve = ensureMutagen }: { readonly here?: boolean; readonly mutagen?: () => Promise<string | undefined> } = {},
): Promise<Forgot> => {
    const ids = sandboxesNamed((await readState()).pairings, name);
    // Mutagen only where something here is to be forgotten: resolving it downloads it when absent. One that cannot be had
    // is no reason to keep the pairing; the watcher's orphan sweep ends its sessions once Mutagen answers.
    const mutagen = ids.length === 0 ? undefined : await resolve().catch(() => undefined);
    const retired: Retired[] = [];
    for (const sandboxId of ids) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one sandbox at a time; each rewrites the one state file
        const done = await retireSandbox(sandboxId, log, "forgotten by `intentic-machine sync forget`", { mutagen });
        if (done !== undefined) {
            retired.push(done);
        }
    }
    if (!WINDOWS_SIDE || here) {
        return { ok: true, retired };
    }
    const environments = await Promise.all((await heldDistros()).map(async (distro) => await forgetInDistro(distro, name)));
    return { ok: true, retired, ...(environments.length === 0 ? {} : { environments }) };
};

// What a person reads.
export const forgotInWords = (name: string, forgot: Forgot): string => {
    const lines = [
        forgot.retired.length === 0
            ? `Nothing paired in this environment is called ${name}.`
            : forgot.retired
                  .map(
                      (entry) =>
                          `Forgot ${entry.sandboxId} (${entry.pairings.join(", ")})${entry.folders.length === 0 ? "" : `; kept ${entry.folders.join(", ")} and its restore points`}.`,
                  )
                  .join("\n"),
        ...(forgot.environments ?? []).map((entry) =>
            entry.ok
                ? `${entry.environment}: ${(entry.retired ?? []).length === 0 ? "nothing paired there by that name" : `forgot ${(entry.retired ?? []).map((held) => held.sandboxId).join(", ")}`}.`
                : `${entry.environment}: not asked (${entry.error ?? "no answer"}).`,
        ),
    ];
    return lines.join("\n");
};

interface ForgetFlags {
    readonly json: boolean;
    readonly here: boolean;
}

export const forget = buildCommand<ForgetFlags, [string]>({
    docs: {
        brief: "Retire every pairing of one sandbox now (by its slug or sandbox id), in every environment of this PC: its sessions, forwards, ssh entry and caches go; its folders and restore points stay",
    },
    parameters: {
        flags: {
            json: { kind: "boolean", brief: "Print one JSON object, `ok` first" },
            here: {
                kind: "boolean",
                brief: "Only this environment, not the WSL distros a Windows side keeps (what the Windows side asks each distro)",
            },
        },
        positional: {
            kind: "tuple",
            parameters: [{ brief: "The sandbox's slug (as ic names it) or its sandbox id", parse: String, placeholder: "sandbox" }],
        },
    },
    async func(this: CommandContext, flags: ForgetFlags, name: string) {
        // The retirement's own lines go to stderr under --json, so stdout stays the one object.
        const log: Log = (message) => void (flags.json ? this.process.stderr : this.process.stdout).write(`${message}\n`);
        await answer(
            this,
            flags.json,
            async () => await forgetSandbox(name, log, { here: flags.here }),
            (result) => forgotInWords(name, result),
        );
    },
});
