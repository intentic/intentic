import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { undefinedIfMissing } from "@intentic/base/errors";
import { SECRET_KEY_MAX, SECRET_KEY_RE } from "@intentic/sandbox-contract/schemas/secrets";
import { z } from "zod";
import type { SandboxSecrets } from "./sandbox-secrets.js";

// The secrets the retired deploy engine kept in the workspace's desired-state repo, withdrawn with self-hosting on
// 2026-11-17: the `.env` a person set there, and the `.secrets.json` the engine generated. Nothing reads that repo any
// more, so the first boot without it copies each value into the sandbox's own store, where references now resolve and
// the terminal masks it. A name the store already holds keeps its value, and a `.env` value wins over a generated one of
// the same name, as it did when the repo was read. The repo is only ever read: its files stay the owner's. Once a copy
// has run, the marker on /history keeps a later boot from bringing back a secret the owner deleted since.

const REPO = "desired-state";
const ENV_FILE = ".env";
const GENERATED_FILE = ".secrets.json";

export interface MovedSecrets {
    // Names copied into the store.
    readonly moved: readonly string[];
    // Names the store already held, left as they were.
    readonly kept: readonly string[];
}

// What a deploy generated: {name: value}; a value that is not a string reads as empty, and is skipped like one.
const GeneratedSecretsSchema = z.record(z.string(), z.string().catch(""));

const generatedValues = (text: string, path: string): [string, string][] => {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        // The parse error is not kept: its message quotes the text around the fault, which is secret values.
        throw new Error(`${path} is not valid JSON, so its secrets were not copied`);
    }
    const parsed = GeneratedSecretsSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`${path} is not a JSON object of values, so its secrets were not copied`);
    }
    return Object.entries(parsed.data);
};

// Undefined when there was nothing to copy: the marker is already there, or the repo holds neither file.
export const moveDesiredStateSecrets = async (
    workspaceRoot: string,
    historyRoot: string,
    store: Pick<SandboxSecrets, "all" | "set">,
): Promise<MovedSecrets | undefined> => {
    const marker = join(historyRoot, "desired-state-secrets.moved");
    if (existsSync(marker)) {
        return undefined;
    }
    const envPath = join(workspaceRoot, REPO, ENV_FILE);
    const generatedPath = join(workspaceRoot, REPO, GENERATED_FILE);
    const [envText, generatedText] = await Promise.all([
        readFile(envPath, "utf8").catch(undefinedIfMissing),
        readFile(generatedPath, "utf8").catch(undefinedIfMissing),
    ]);
    if (envText === undefined && generatedText === undefined) {
        return undefined;
    }
    const found = new Map<string, string>();
    for (const [name, value] of [
        ...Object.entries(envText === undefined ? {} : parseEnv(envText)),
        ...(generatedText === undefined ? [] : generatedValues(generatedText, generatedPath)),
    ]) {
        // A name a reference could not carry, or an empty value, is nothing the store would hold.
        if (value !== undefined && value !== "" && SECRET_KEY_RE.test(name) && name.length <= SECRET_KEY_MAX && !found.has(name)) {
            found.set(name, value);
        }
    }
    const held = await store.all();
    const moved: string[] = [];
    const kept: string[] = [];
    for (const [name, value] of found) {
        if (name in held) {
            kept.push(name);
            continue;
        }
        await store.set(name, value);
        moved.push(name);
    }
    // Names only, never a value: what a person reading /history finds is what moved, and when.
    await writeFile(marker, `${JSON.stringify({ at: new Date().toISOString(), moved, kept })}\n`, { mode: 0o600 });
    return { moved, kept };
};
