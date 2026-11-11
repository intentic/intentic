import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import type { ComposeInputs } from "./compose.js";
import { sandboxNames, type SandboxRun } from "./index.js";

// Pretty JSON, as the golden files hold it.
export const asJson = <T>(value: T): string => `${JSON.stringify(value, undefined, 2)}\n`;

interface Golden {
    readonly onDisk: string;
    readonly expected: string;
}

// A golden file's text and the text it should hold, rewriting the file first when `INTENTIC_WRITE_GOLDEN=1`.
export const golden = (name: string, expected: string): Golden => {
    const path = join(packageRoot(import.meta.url), "golden", name);
    if (process.env["INTENTIC_WRITE_GOLDEN"] === "1") {
        writeFileSync(path, expected);
    }
    return { onDisk: readFileSync(path, "utf8"), expected };
};

// Runs that reach every branch of the run contract, rendered by both its dialects: the `docker run` argv (held
// byte-for-byte to golden/run-argv.json, which was written from the emitter before it became a spec) and the Compose
// file (golden/compose-*.yaml). One list, so a branch added to one dialect is a golden line the other is asked about.
const names = sandboxNames("abc-123");

// Every input but the overlay's directives, which the Compose case takes from its recipe instead.
const FULL = {
    names,
    image: "env:tag",
    baseImage: "base:tag",
    environmentHash: "sha256:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    channel: "stable",
    previousImage: "base:old",
    baseDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    definition: 'name = "seeded"\n# ünïcode\n',
    env: [
        ["OWNER_EMAIL", "a@b.c"],
        ["CONNECT_TOKEN", "ict_secret$value"],
        ["HOST_SSH_KEY", "-----BEGIN KEY-----\nline\n-----END KEY-----"],
        ["SANDBOX_SWAP", "2g"],
    ],
    hostRuntime: ["--device=/dev/net/tun", "--cap-add=NET_ADMIN"],
    unsupported: ["--gpus=all"],
    cpus: "4",
    memory: "12g",
    mounts: ["shared-auth:/agent-auth", "/home/a/.intentic/keys/at-rest-abc-123.key:/run/secrets/intentic-at-rest-key:ro"],
    sandboxId: "2c8eb2c5b3a5",
    dns: ["1.1.1.1"],
} satisfies SandboxRun;

export const RUN_CASES = {
    bare: { names, image: "img:1", baseImage: "img:1" },
    hosted: {
        names,
        image: "img:2",
        baseImage: "img:2",
        init: false,
        alias: false,
        ports: ["10.0.0.2:5173:5173"],
        labels: ["intentic.type=workspace", "intentic.slug=abc-123"],
        dns: ["1.1.1.1", "1.0.0.1"],
    },
    full: { ...FULL, runtime: ["--privileged", "--gpus=all"] },
    noPublish: { names, image: "img:3", baseImage: "img:3", sandboxId: "2c8eb2c5b3a5", localPublish: false, runtime: ["--gpus=all"] },
} satisfies Record<string, SandboxRun>;

// An approved recipe as the daemon writes one: its header, a step whose shell Compose must not read, a heredoc whose `#`
// is the script's own, and a runtime directive.
export const RECIPE = {
    hash: `sha256:${"0123456789abcdef".repeat(4)}`,
    content: [
        "# Composed by the intentic sandbox daemon: do not edit by hand.",
        "",
        "FROM ghcr.io/intentic/sandbox:stable",
        "# ---- docker ----",
        "# intentic:runtime --privileged",
        'RUN ln -sf "/opt/x-$(node -p \'process.arch\')" /usr/local/bin/x',
        "RUN <<EOF cat > /usr/local/bin/hello",
        "#!/bin/sh",
        "",
        "echo hi",
        "EOF",
        "",
    ].join("\n"),
};

// What only Compose needs, per case rendered to golden/compose-<case>.yaml. `full` is a moved sandbox (`ic sandbox
// compose`): existing storage, the key beside the file, the side stamps; `fresh` is the setup page's new sandbox.
export const COMPOSE_CASES = {
    bare: { run: RUN_CASES.bare, inputs: {} },
    full: {
        run: FULL,
        inputs: { recipe: RECIPE, atRestKey: "./at-rest.key", host: { platform: "linux", label: "z440", env: "native" } },
    },
    fresh: {
        run: { names, image: "ghcr.io/intentic/sandbox:stable", baseImage: "ghcr.io/intentic/sandbox:stable", dns: ["1.1.1.1", "1.0.0.1"] },
        inputs: {
            existingStorage: false,
            unmeasured: true,
            envFile: [{ name: "CONNECT_TOKEN", missing: "run the .env bootstrap first" }, { name: "OWNER_EMAIL" }],
        },
    },
} satisfies Record<string, { readonly run: SandboxRun; readonly inputs: ComposeInputs }>;
