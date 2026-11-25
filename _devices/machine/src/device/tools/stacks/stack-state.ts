import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, stat, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { parseJsonWith } from "@intentic/base/json";
import { homeDir } from "@intentic/local-agent";
import type { StackImagePins, StackRegistryLogin } from "@intentic/sandbox-contract/schemas/device-stacks";
import { z } from "zod";
import { STACK_STATE_DIR } from "./stack-folder.js";

/* WHAT A MANAGED DEPLOY WRITES BESIDE THE REPOSITORY'S FILES (2026-11-25): the `.env` the daemon rendered, the stack's own
   docker config holding its registry logins, and the image pins a rollback lays over the compose file. The `.env` sits
   where compose reads it, at the top of the stack's folder; the rest goes in `.intentic-stack/`, which no copy from a
   repository writes (stack-folder.ts). The values here are secrets: nothing in this module puts one in a message, and
   every file holding one is 0600 in a 0700 folder. The machine's own docker config is never touched: a stack's logins
   reach compose as DOCKER_CONFIG for that stack's commands alone. */

const ENV_FILE = ".env";
const PINS_FILE = "pins.yaml";
const DOCKER_DIR = "docker";
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

export const envDigestOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// `path` as a folder the agent can write into: made when missing, its mode set; anything else under its name (a link a
// container's bind mount left, a file) stops the deploy, since writing through it could put a secret anywhere.
const ownFolder = async (path: string): Promise<void> => {
    const found = await lstat(path).catch(undefinedIfMissing);
    if (found === undefined) {
        await mkdir(path, { mode: SECRET_DIR_MODE });
    } else if (!found.isDirectory()) {
        throw new Error(
            `${path} is not a folder this agent made (a ${found.isSymbolicLink() ? "link" : "file"} is there), and a deploy writes its secrets nowhere else: move it aside on this device and deploy again.`,
        );
    }
    await chmod(path, SECRET_DIR_MODE);
};

// The stack's state folder, made when `make` asks; undefined when it is not there and nothing is to be written into it.
const stateDir = async (dir: string, make: boolean): Promise<string | undefined> => {
    const path = join(dir, STACK_STATE_DIR);
    if (!make && (await lstat(path).catch(undefinedIfMissing)) === undefined) {
        return undefined;
    }
    await ownFolder(path);
    return path;
};

// ---- the `.env` --------------------------------------------------------------------------------------------------

// Before anything is written: a `.env` that is not the one the last managed deploy wrote (none recorded, or another
// digest) was placed or edited by a person, and is theirs. It is refused rather than overwritten, and the refusal says
// where, never what is in it.
export const refuseHandPlacedEnv = async (name: string, dir: string, recorded: string | undefined): Promise<void> => {
    const path = join(dir, ENV_FILE);
    const found = await lstat(path).catch(undefinedIfMissing);
    if (found === undefined) {
        return;
    }
    const digest = found.isFile() ? envDigestOf(await readFile(path, "utf8")) : undefined;
    if (digest !== undefined && digest === recorded) {
        return;
    }
    const how = recorded === undefined ? "no deploy wrote it" : "it changed since the last deploy wrote it";
    throw new Error(
        `Refused to deploy "${name}": ${path} was placed or edited by hand (${how}), and a deploy that brings its own .env never overwrites one a person put there. ` +
            "A person on this device must move it away, keeping what it holds wherever the stack's secrets now live; the next deploy then writes its own.",
    );
};

// The rendered `.env`, renamed into place (a link left under its name is replaced, never written through), 0600.
export const writeEnv = async (dir: string, text: string): Promise<string> => {
    await writeFileAtomic(join(dir, ENV_FILE), text, SECRET_FILE_MODE);
    return envDigestOf(text);
};

// ---- registry logins ---------------------------------------------------------------------------------------------

// The person's own docker config folder, which a stack's DOCKER_CONFIG would otherwise hide.
export const userDockerDir = (): string => process.env["DOCKER_CONFIG"] ?? join(homeDir(), ".docker");

const UserConfigSchema = z.object({ currentContext: z.string().optional() });

// The context the person's docker talks to (Docker Desktop's `desktop-linux`), when it is not the default.
const currentContextOf = async (userDir: string): Promise<string | undefined> => {
    const text = await readFile(join(userDir, "config.json"), "utf8").catch(undefinedIfMissing);
    const context = text === undefined ? undefined : parseJsonWith(text, UserConfigSchema)?.currentContext;
    return context === undefined || context === "" || context === "default" ? undefined : context;
};

// `<config>/<name>` leading to the person's own `<userDir>/<name>` while that is a folder: `docker compose` may be
// installed as a per-user plugin (`cli-plugins`), and a Docker Desktop context's endpoint lives in `contexts`, both of
// which a DOCKER_CONFIG elsewhere would hide. A link of ours there is made again each deploy; anything else is left.
const linkFromUser = async (config: string, userDir: string, name: string): Promise<void> => {
    const link = join(config, name);
    const there = await lstat(link).catch(undefinedIfMissing);
    if (there !== undefined && !there.isSymbolicLink()) {
        return;
    }
    if (there !== undefined) {
        await unlink(link);
    }
    // allow(silent-catch): a folder that cannot be read is one docker could not read either
    const target = await stat(join(userDir, name)).catch(() => undefined);
    if (target?.isDirectory() === true) {
        // a junction on Windows, which needs no administrator; the type is ignored elsewhere
        await symlink(join(userDir, name), link, "junction");
    }
};

// What docker reads in the stack's config: the logins, and the context the person's own docker talks to.
interface StackDockerConfig {
    auths: Record<string, { auth: string }>;
    currentContext?: string;
}

// The stack's docker config (`{"auths": {host: {auth: base64 user:pass}}}`), the folder compose is handed as
// DOCKER_CONFIG; or, when the deploy declares no registry, none, and any config an earlier deploy left is removed.
export const writeRegistries = async (dir: string, registries: readonly StackRegistryLogin[], userDir: string = userDockerDir()): Promise<string | undefined> => {
    if (registries.length === 0) {
        const state = await stateDir(dir, false);
        if (state !== undefined) {
            // `rm` removes a link where it finds one, never what it leads to
            await rm(join(state, DOCKER_DIR), { recursive: true, force: true });
        }
        return undefined;
    }
    const config = join((await stateDir(dir, true)) ?? "", DOCKER_DIR);
    await ownFolder(config);
    const auths = Object.fromEntries(registries.map((login) => [login.host, { auth: Buffer.from(`${login.username}:${login.password}`, "utf8").toString("base64") }]));
    const written: StackDockerConfig = { auths };
    const context = await currentContextOf(userDir);
    if (context !== undefined) {
        written.currentContext = context;
    }
    await writeFileAtomic(join(config, "config.json"), `${JSON.stringify(written, undefined, 2)}\n`, SECRET_FILE_MODE);
    await linkFromUser(config, userDir, "cli-plugins");
    await linkFromUser(config, userDir, "contexts");
    return config;
};

// The docker config an earlier deploy left for this stack, for the ops run on it later (a board's `pull` reaches the
// same private registry); undefined when it has none, or when its state folder is not one the agent made.
export const stackDockerConfig = async (dir: string): Promise<string | undefined> => {
    const state = await lstat(join(dir, STACK_STATE_DIR)).catch(undefinedIfMissing);
    if (state?.isDirectory() !== true) {
        return undefined;
    }
    const config = join(dir, STACK_STATE_DIR, DOCKER_DIR);
    const file = await lstat(join(config, "config.json")).catch(undefinedIfMissing);
    return file?.isFile() === true ? config : undefined;
};

// ---- image pins --------------------------------------------------------------------------------------------------

// The pins as a compose override. JSON is YAML, so a service name or a reference is never quoted by hand.
export const pinsOverride = (pins: StackImagePins): string =>
    `${JSON.stringify({ services: Object.fromEntries(Object.entries(pins).map(([service, image]) => [service, { image }])) }, undefined, 2)}\n`;

// The pins file handed to compose after the stack's own (`-f`), or, with no pins, none, and a stale one removed.
export const writePins = async (dir: string, pins: StackImagePins | undefined): Promise<string | undefined> => {
    if (pins === undefined || Object.keys(pins).length === 0) {
        const state = await stateDir(dir, false);
        if (state !== undefined) {
            await rm(join(state, PINS_FILE), { force: true });
        }
        return undefined;
    }
    const path = join((await stateDir(dir, true)) ?? "", PINS_FILE);
    await writeFileAtomic(path, pinsOverride(pins));
    return path;
};

// ---- keeping the values out of what is said ------------------------------------------------------------------------

// Shorter than this, a value is too likely to be a word compose says anyway ("true", a port) to hide.
const SHORTEST_HIDDEN = 8;

// Each value a dotenv text holds, quoted and not, and each line on its own (a quoted value may run over several).
const envValues = (text: string): string[] =>
    text.split(/\r?\n/).flatMap((line) => {
        const raw = (/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=(.*)$/.exec(line)?.[1] ?? line).trim();
        const unquoted = /^(["'])(.*)\1$/.exec(raw)?.[2] ?? raw.replace(/^["']|["']$/g, "");
        return [raw, unquoted];
    });

// The secret values a deploy carries, longest first, which `hideSecrets` takes out of anything it answers: compose,
// a hook or an app may print one back, and the answer and its errors are logged on both ends.
export const secretsOf = (args: { readonly env?: string | undefined; readonly registries?: readonly StackRegistryLogin[] | undefined }): string[] => {
    const logins = (args.registries ?? []).flatMap((login) => [login.password, Buffer.from(`${login.username}:${login.password}`, "utf8").toString("base64")]);
    const values = [...envValues(args.env ?? ""), ...logins].filter((value) => value.length >= SHORTEST_HIDDEN);
    return [...new Set(values)].toSorted((a, b) => b.length - a.length);
};

export const hideSecrets = (text: string, secrets: readonly string[]): string => secrets.reduce((hidden, secret) => hidden.replaceAll(secret, "[hidden]"), text);
