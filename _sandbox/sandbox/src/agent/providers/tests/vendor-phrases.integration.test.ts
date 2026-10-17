import { createReadStream, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { claudeBinaryNames } from "../../../engines/engine-descriptors.js";
import { CODEX_CLI_PHRASES as CODEX_NOTICES } from "../../../runtimes/codex/codex-models.js";
import { HOOK_TRUST_FLAG } from "../../../runtimes/codex/codex-hooks.js";
import { UNKNOWN_COMMAND_PREFIX } from "../agent-commands.js";
import { CLAUDE_CLI_PHRASES, CODEX_CLI_PHRASES } from "../../../engines/failure-sentences.js";

// Every phrase a classifier here matches that a CLI prints in its own words is still in the CLI this tree installs. A
// release that rewords one fails this suite, where a fixture-built test would keep passing and production would read the
// new sentence as nothing. Server-side API text is not here: no binary holds it. Matched case-insensitively, as the
// classifiers match.

// The Claude CLI the Agent SDK ships beside itself, resolved the way the daemon resolves the image's copy (claude-sdk.ts).
const claudeBinary = (): string | undefined => {
    const fromSdk = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
    for (const name of claudeBinaryNames()) {
        try {
            return fromSdk.resolve(name);
        } catch {
            // allow(silent-catch): a variant this install does not carry does not resolve, and the next one is tried.
        }
    }
    return undefined;
};

// Codex's native binary behind its node wrapper, as the wrapper finds it (bin/codex.js): the platform package beside the
// SDK's pinned @openai/codex, else the deployed copy at /usr/local/bin/codex.
const CODEX_TARGETS = new Map<string, readonly [pkg: string, triple: string]>([
    ["linux-x64", ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"]],
    ["linux-arm64", ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"]],
]);

const codexNative = (codexPackage: string): string | undefined => {
    const target = CODEX_TARGETS.get(`${platform()}-${arch()}`);
    if (target === undefined) {
        return undefined;
    }
    const [pkg, triple] = target;
    let vendor: string;
    try {
        vendor = join(dirname(createRequire(join(codexPackage, "package.json")).resolve(`${pkg}/package.json`)), "vendor");
    } catch {
        vendor = join(codexPackage, "vendor");
    }
    const binary = join(vendor, triple, "bin", "codex");
    return existsSync(binary) ? binary : undefined;
};

const codexBinary = (): string | undefined => {
    const packages: string[] = [];
    try {
        packages.push(dirname(createRequire(import.meta.resolve("@openai/codex-sdk")).resolve("@openai/codex/package.json")));
    } catch {
        // allow(silent-catch): a tree with the SDK pruned still has the deployed copy to try.
    }
    if (existsSync("/usr/local/bin/codex")) {
        packages.push(dirname(dirname(realpathSync("/usr/local/bin/codex"))));
    }
    return packages.map(codexNative).find((binary) => binary !== undefined);
};

// The phrases of `phrases` the binary does not hold, read once in chunks: both binaries are hundreds of megabytes, so
// neither is held whole, and a chunk keeps the tail of the one before it for a phrase that straddles the two.
const CHUNK_BYTES = 64 * 1024 * 1024;
const missingFrom = async (binary: string, phrases: readonly string[]): Promise<string[]> => {
    const wanted = new Map(phrases.map((phrase) => [phrase, phrase.toLowerCase()]));
    const overlap = Math.max(...[...wanted.values()].map((phrase) => phrase.length)) - 1;
    let carry = "";
    for await (const chunk of createReadStream(binary, { highWaterMark: CHUNK_BYTES })) {
        // SAFETY: a stream opened without an encoding yields Buffers.
        const window = carry + (chunk as Buffer).toString("latin1").toLowerCase();
        for (const [phrase, lower] of wanted) {
            if (window.includes(lower)) {
                wanted.delete(phrase);
            }
        }
        if (wanted.size === 0) {
            break;
        }
        carry = window.slice(-overlap);
    }
    return [...wanted.keys()];
};

const claude = claudeBinary();
const codex = codexBinary();
const claudeCli = requires(claude !== undefined, "the Claude CLI binary the Agent SDK installs");
const codexCli = requires(codex !== undefined, "the Codex CLI's native binary", {
    absentOnCi: "the Codex CLI is an optional platform package and a feature pack of the sandbox image, not part of every install",
});

test.skipIf(!claudeCli.runs)(
    claudeCli.title("every Claude CLI sentence a classifier reads is still in the installed CLI"),
    async () => {
        expect(await missingFrom(claude ?? "", [...CLAUDE_CLI_PHRASES, UNKNOWN_COMMAND_PREFIX])).toEqual([]);
    },
    120_000,
);

test.skipIf(!codexCli.runs)(
    codexCli.title("every Codex CLI sentence a classifier reads is still in the installed CLI"),
    async () => {
        expect(await missingFrom(codex ?? "", [...CODEX_CLI_PHRASES, ...CODEX_NOTICES, HOOK_TRUST_FLAG])).toEqual([]);
    },
    120_000,
);
