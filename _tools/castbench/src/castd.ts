import { sleep } from "@intentic/base/async";
import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_MEDIA_PATH } from "@intentic/sandbox-contract/browser-wire";
import type { PipelineServer } from "./legacy.js";
import { processTree } from "./proc.js";
import type { Stage } from "./stage.js";

// castd's column: a castd for the stage's display, reached on its Unix socket through the relay exactly as netd will
// reach it (an HTTP/1.1 upgrade relayed byte for byte, /system/browser-media/<session>?token=…), and spoken to in
// browser-wire's media protocol by the viewer page, which acks every decoded frame the way the editor will.
//
// castd is either started here, from `command` with the stage's facts filled in, so its CPU is metered by its pid; or
// already running on `socket`, metered only when `pid` names it.

export interface CastdOptions {
    // A command line, run with `sh -c`, with {display}, {socket}, {session}, {keyfile}, {width}, {height} and {region}
    // (x,y,w,h of the viewport on the screen) filled in. With {keyfile} and no `keyFile`, a fresh key is made for it.
    readonly command?: string | undefined;
    readonly socket?: string | undefined;
    readonly pid?: number | undefined;
    // What the socket's `token` query carries; empty sends none. Without one, a token is minted from `keyFile`.
    readonly token?: string | undefined;
    // castd's --key-file, the HMAC key its tokens are signed with.
    readonly keyFile?: string | undefined;
    readonly session: string;
}

// A media socket's token as castd checks it (castd's src/token.rs): base64url of the JSON payload, a dot, and base64url
// of its HMAC-SHA256 under castd's key, both unpadded. What the daemon will mint for the editor.
export const mintMediaToken = (key: Uint8Array, session: string, expiresAt: number, readOnly: boolean): string => {
    const payload = Buffer.from(JSON.stringify({ s: session, exp: expiresAt, ro: readOnly }), "utf8");
    return `${payload.toString("base64url")}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
};

// The command's placeholders, filled from the stage.
export const fillCommand = (
    template: string,
    facts: {
        readonly display: string;
        readonly socket: string;
        readonly session: string;
        readonly keyFile: string;
        readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    },
): string =>
    template
        .replaceAll("{display}", facts.display)
        .replaceAll("{socket}", facts.socket)
        .replaceAll("{session}", facts.session)
        .replaceAll("{keyfile}", facts.keyFile)
        .replaceAll("{width}", String(facts.region.width))
        .replaceAll("{height}", String(facts.region.height))
        .replaceAll("{region}", `${facts.region.x},${facts.region.y},${facts.region.width},${facts.region.height}`);

// The address the viewer opens, through a relay on `port`.
export const mediaUrl = (port: number, session: string, token: string | undefined): string =>
    `ws://127.0.0.1:${port}${BROWSER_MEDIA_PATH}/${encodeURIComponent(session)}${token === undefined || token === "" ? "" : `?token=${encodeURIComponent(token)}`}`;


// A token lasts the matrix: an hour is past any run, and castd checks it only at each upgrade.
const TOKEN_LIFETIME_MS = 3_600_000;

export const startCastd = async (options: CastdOptions, stage: Stage): Promise<PipelineServer> => {
    let child: ChildProcess | undefined;
    let scratch: string | undefined;
    let socket = options.socket;
    let keyFile = options.keyFile;
    if (options.command !== undefined) {
        scratch = mkdtempSync(join(tmpdir(), "castbench-castd-"));
        socket ??= join(scratch, `${options.session}.sock`);
        if (keyFile === undefined && options.command.includes("{keyfile}")) {
            keyFile = join(scratch, "key");
            writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
        }
        const line = fillCommand(options.command, { display: stage.display.name, socket, session: options.session, keyFile: keyFile ?? "", region: stage.region });
        child = spawn("sh", ["-c", `exec ${line}`], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, DISPLAY: stage.display.name } });
    }
    if (socket === undefined) {
        throw new Error("the castd pipeline needs --castd-command or --castd-socket");
    }
    const deadline = Date.now() + 15_000;
    while (!existsSync(socket)) {
        if (child?.exitCode !== null && child?.exitCode !== undefined) {
            throw new Error(`castd exited (${child.exitCode}) before it opened ${socket}`);
        }
        if (Date.now() > deadline) {
            child?.kill("SIGKILL");
            throw new Error(`castd did not open ${socket} within 15 s`);
        }
        await sleep(50);
    }
    const metered = child?.pid ?? options.pid;
    const path = socket;
    const token =
        options.token ?? (keyFile === undefined ? undefined : mintMediaToken(readFileSync(keyFile), options.session, Date.now() + TOKEN_LIFETIME_MS, false));
    return {
        target: { path },
        url: (port) => mediaUrl(port, options.session, token),
        protocol: "media",
        encoderPids: () => (metered === undefined ? [] : processTree(metered).map((stat) => stat.pid)),
        // castd makes a keyframe without restarting anything, so there is nothing to count.
        starts: () => null,
        close: async () => {
            child?.kill("SIGTERM");
            await sleep(200);
            child?.kill("SIGKILL");
            if (scratch !== undefined) {
                rmSync(scratch, { recursive: true, force: true });
            }
        },
    };
};
