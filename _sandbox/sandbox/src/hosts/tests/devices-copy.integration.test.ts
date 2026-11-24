import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import { packageRoot } from "@intentic/constants/node";
import { type CopyFile, type CopyFileResult, type CopyKind, FILE_COPY_CHUNK_BYTES } from "@intentic/sandbox-contract/schemas/device-files";
import type { DeviceFacts } from "@intentic/sandbox-contract/schemas/hosts";
import { unstubbed } from "@intentic/testing";
import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import type { DoorServices } from "../device-door.routes.js";
import { createDeviceFileRoutes } from "../device-files.routes.js";
import type { HostClient } from "../host-peer.js";
import { turnProof } from "../../seams/workload-stamp.js";

// THE `devices copy` COMMAND (bin/devices) through the real door (device-files.routes.ts), to a computer kept in memory:
// a file or a folder goes onto it and comes back off it byte for byte, the computer is asked before a byte is sent, a
// destination that is taken is refused here before it is asked at all, and a copy cut short never lands as a file.

const CLI = join(packageRoot(import.meta.url), "bin", "devices");

interface Served {
    readonly bytes: Buffer;
    readonly kind: CopyKind;
    readonly executable: boolean;
    // A hash other than the bytes' own, for a copy that must come up short.
    readonly claims?: string;
}

interface Computer {
    readonly calls: CopyFile[];
    // What landed on it, by path.
    readonly files: Map<string, Buffer>;
    serves: Served | undefined;
    refuses: CopyFile["op"] | undefined;
}

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

// The computer's side of the contract, without a disk: a folder that exists is a path ending in a separator.
const computerClient = (computer: Computer): Pick<HostClient, "copyFile"> => {
    const puts = new Map<string, { readonly path: string; readonly pieces: Buffer[] }>();
    const answer = (op: CopyFile): CopyFileResult => {
        const served = computer.serves ?? { bytes: Buffer.alloc(0), kind: "file", executable: false };
        switch (op.op) {
            case "put-open": {
                const path = op.path.endsWith("\\") ? `${op.path}${op.name}` : op.path;
                if (op.probe !== true) {
                    puts.set(op.copy, { path, pieces: [] });
                }
                return { path };
            }
            case "put-chunk":
                puts.get(op.copy)?.pieces.push(Buffer.from(op.data, "base64"));
                return {};
            case "put-commit": {
                const put = puts.get(op.copy);
                computer.files.set(put?.path ?? "", Buffer.concat(put?.pieces ?? []));
                return { path: put?.path ?? "" };
            }
            case "get-open":
                return { path: op.path, kind: served.kind, size: served.bytes.byteLength, name: "x", executable: served.executable };
            case "get-chunk": {
                const piece = served.bytes.subarray(op.offset, op.offset + FILE_COPY_CHUNK_BYTES);
                const last = op.offset + piece.byteLength >= served.bytes.byteLength;
                return last ? { data: piece.toString("base64"), sha256: served.claims ?? sha(served.bytes) } : { data: piece.toString("base64") };
            }
            case "close":
                return {};
        }
    };
    return {
        copyFile: async (op: CopyFile): Promise<CopyFileResult> => {
            computer.calls.push(op);
            if (computer.refuses === op.op) {
                throw new ORPCError("FORBIDDEN", { message: `Refused: "Create and change files" is switched off for this device.` });
            }
            return answer(op);
        },
    };
};

interface Daemon {
    readonly computer: Computer;
    readonly port: number;
    readonly close: () => void;
}

const daemon = async (): Promise<Daemon> => {
    const computer: Computer = { calls: [], files: new Map(), serves: undefined, refuses: undefined };
    const client = computerClient(computer);
    const services = unstubbed<DoorServices>("services", {
        conversations: unstubbed<Services["conversations"]>("conversations", {}),
        runGrants: unstubbed<Services["runGrants"]>("runGrants", { allows: () => false }),
        turnMounts: unstubbed<Services["turnMounts"]>("turnMounts", { reaches: (conversation, target) => conversation === "conv-a" && target.kind === "device" && target.id === "rog" }),
        hostHub: unstubbed<Services["hostHub"]>("hostHub", {
            client: (id) => (id === "rog" ? unstubbed<HostClient>("client", client) : undefined),
            online: () => true,
            state: () => unstubbed<ReturnType<Services["hostHub"]["state"]>>("state", { facts: unstubbed<DeviceFacts>("facts", { features: ["file-copy"] }) }),
        }),
    });
    const app = new Hono<AppEnv>();
    const routes = createDeviceFileRoutes(services);
    app.post("/devices/:name/files", routes.put);
    app.get("/devices/:name/files", routes.get);
    const server = createAdaptorServer({ fetch: app.fetch });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = z.object({ port: z.number() }).parse(server.address());
    return { computer, port, close: () => server.close() };
};

let work = "";
let running: Daemon | undefined;
beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "devices-copy-"));
    await writeFile(join(work, ".token"), "token\n");
    running = await daemon();
});
afterEach(async () => {
    running?.close();
    await rm(work, { recursive: true, force: true });
});

const computer = (): Computer => running?.computer ?? { calls: [], files: new Map(), serves: undefined, refuses: undefined };

const devices = (...args: string[]): Promise<{ code: number; out: string }> =>
    new Promise((done) => {
        const child = spawn(process.execPath, [CLI, ...args], {
            cwd: work,
            env: {
                PATH: process.env["PATH"] ?? "",
                HOME: process.env["HOME"] ?? "",
                SANDBOX_PORT: String(running?.port ?? 0),
                INTENTIC_AGENT_TOKEN_PATH: join(work, ".token"),
                INTENTIC_TURN_OWNER: "conv-a",
                INTENTIC_TURN_PROOF: turnProof("conv-a"),
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (chunk) => {
            out += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
            out += String(chunk);
        });
        child.on("exit", (code) => done({ code: code ?? -1, out }));
    });

// More than two chunks of bytes no text tool would carry.
const binary = randomBytes(FILE_COPY_CHUNK_BYTES * 2 + 99);

test("a file goes onto the computer whole, asked first, executable when it is here", async () => {
    await writeFile(join(work, "tool.bin"), binary);
    await chmod(join(work, "tool.bin"), 0o755);
    const { code, out } = await devices("copy", "tool.bin", "rog:C:\\Users\\me\\");
    expect([code, out]).toEqual([0, expect.stringContaining("File on rog: C:\\Users\\me\\tool.bin")]);
    expect(computer().files.get("C:\\Users\\me\\tool.bin")?.equals(binary)).toBe(true);
    const opens = computer().calls.filter((call) => call.op === "put-open");
    expect(opens.map((call) => call.probe === true)).toEqual([true, false]);
    expect(opens[1]).toMatchObject({ name: "tool.bin", kind: "file", executable: true, overwrite: false });
});

test("a folder goes onto the computer as one tar of its files", async () => {
    await mkdir(join(work, "dist", "assets"), { recursive: true });
    await writeFile(join(work, "dist", "index.html"), "<h1>hi</h1>");
    await writeFile(join(work, "dist", "assets", "app.bin"), binary);
    const { code, out } = await devices("cp", "dist", "rog:C:\\app", "--overwrite");
    expect([code, out]).toEqual([0, expect.stringContaining("Folder on rog: C:\\app")]);
    await writeFile(join(work, "landed.tar"), computer().files.get("C:\\app") ?? Buffer.alloc(0));
    const listed = spawnSync("tar", ["-tf", join(work, "landed.tar")], { encoding: "utf8" }).stdout;
    expect(listed).toContain("./assets/app.bin");
    expect(listed).toContain("./index.html");
    expect(computer().calls.find((call) => call.op === "put-open")).toMatchObject({ kind: "tar", overwrite: true });
});

test("a file comes off the computer into a folder here, under its own name, executable as it was there", async () => {
    computer().serves = { bytes: binary, kind: "file", executable: true };
    await mkdir(join(work, "out"));
    const { code, out } = await devices("copy", "rog:C:\\dumps\\core.bin", "out");
    expect([code, out]).toEqual([0, expect.stringContaining(`File here: ${join(work, "out", "core.bin")}`)]);
    expect((await readFile(join(work, "out", "core.bin"))).equals(binary)).toBe(true);
    expect((await stat(join(work, "out", "core.bin"))).mode & 0o100).toBe(0o100);
    expect(computer().calls.at(-1)?.op).toBe("close");
});

test("a folder comes off the computer unpacked", async () => {
    await mkdir(join(work, "site"));
    await writeFile(join(work, "site", "page.txt"), "from the computer");
    spawnSync("tar", ["-cf", join(work, "site.tar"), "-C", join(work, "site"), "."]);
    computer().serves = { bytes: await readFile(join(work, "site.tar")), kind: "tar", executable: false };
    const { code } = await devices("copy", "rog:C:\\site", "copied");
    expect(code).toBe(0);
    expect(await readFile(join(work, "copied", "page.txt"), "utf8")).toBe("from the computer");
});

test("a switch that is off on the computer is read before a byte is sent", async () => {
    computer().refuses = "put-open";
    await writeFile(join(work, "tool.bin"), binary);
    const { code, out } = await devices("copy", "tool.bin", "rog:C:\\Users\\me\\tool.bin");
    expect([code, out]).toEqual([1, expect.stringContaining(`"Create and change files" is switched off`)]);
    expect(computer().calls.map((call) => call.op)).toEqual(["put-open"]);
});

test("a destination here that is taken is refused without --overwrite, before the computer is asked", async () => {
    computer().serves = { bytes: binary, kind: "file", executable: false };
    await writeFile(join(work, "core.bin"), "mine");
    const { code, out } = await devices("copy", "rog:C:\\dumps\\core.bin", "core.bin");
    expect([code, out]).toEqual([1, expect.stringContaining("already exists: copy again with --overwrite")]);
    expect(computer().calls).toEqual([]);
    expect((await devices("copy", "rog:C:\\dumps\\core.bin", "core.bin", "--overwrite")).code).toBe(0);
    expect((await readFile(join(work, "core.bin"))).equals(binary)).toBe(true);
});

test("a copy that does not match the computer's hash comes up short, and nothing lands", async () => {
    computer().serves = { bytes: binary, kind: "file", executable: false, claims: "0".repeat(64) };
    const { code, out } = await devices("copy", "rog:C:\\dumps\\core.bin", "core.bin");
    expect([code, out]).toEqual([1, expect.stringContaining("was cut after")]);
    await expect(stat(join(work, "core.bin"))).rejects.toThrow();
});

test("a copy needs exactly one side on a computer", async () => {
    expect((await devices("copy", "a.txt", "b.txt")).out).toContain("exactly one side on a computer");
    expect((await devices("copy", "rog:C:\\a", "rog:C:\\b")).code).toBe(2);
});
