import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_PRIVACY_SHIELD } from "@intentic/sandbox-contract/schemas/privacy";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { readPack } from "../../image/packs.js";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { composedOverlay, customPath } from "../overlay.js";
import { rustCachePackFragments, rustCacheWanted } from "./rust-cache-pack.js";

/* The Rust compiler cache rides the overlay wherever it installs Rust, and its wrapper shares one cache, never one server. */

// No base image bakes any pack here, whatever machine runs the suite.
process.env["INTENTIC_PACK_STAMPS_DIR"] = mkdtempSync(join(tmpdir(), "rust-cache-stamps-"));

const RUSTUP = "# Rust, for the desktop app.\nRUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal\nENV PATH=/usr/local/cargo/bin:$PATH";

test("steps that install Rust want the cache; comments, other tools and a recipe's own wrapper do not", () => {
    expect(rustCacheWanted([RUSTUP])).toBe(true);
    expect(rustCacheWanted(["RUN apt-get install -y cargo"])).toBe(true);
    expect(rustCacheWanted(["# so a session can `cargo check` the crate\nRUN apt-get install -y ffmpeg"])).toBe(false);
    expect(rustCacheWanted([])).toBe(false);
    // The sandboxes that already carry their own (shinobi's recipe), whose ENV would win over the pack's anyway.
    expect(rustCacheWanted([RUSTUP, "ENV RUSTC_WRAPPER=/usr/local/bin/rustc-cached"])).toBe(false);
});

test("wanted, the pack's fragment comes back; otherwise nothing", async () => {
    const pack = (await readPack("rust-cache"))!;
    expect(pack.overlayable).toBe(true);
    expect(await rustCachePackFragments([RUSTUP])).toEqual([pack.content]);
    expect(await rustCachePackFragments(["RUN true"])).toEqual([]);
});

const services = (custom: string): Services => {
    const root = mkdtempSync(join(tmpdir(), "rust-cache-"));
    const files = unstubbed<Services["files"]>("files", { read: readWorkspaceFile });
    const stub: Services = unstubbed<Services>("services", {
        config: unstubbed<Services["config"]>("config", {
            sandbox: unstubbed<Services["config"]["sandbox"]>("sandbox", { vm: false, baseImage: "", image: "", baseDigest: "", environmentHash: "" }),
        }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files,
        logger: unstubbed<Services["logger"]>("logger", { warn: () => undefined }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
        environmentSources: unstubbed<Services["environmentSources"]>("environmentSources", {
            workspaceExtensionFragments: async () => [],
            providerPackFragments: async () => [],
        }),
        privacyShield: unstubbed<Services["privacyShield"]>("privacyShield", { policy: async () => ({ ...DEFAULT_PRIVACY_SHIELD }) }),
    });
    mkdirSync(dirname(customPath(stub)), { recursive: true });
    writeFileSync(customPath(stub), custom);
    return stub;
};

test("a custom section that installs Rust composes the pack before it, so its own cargo steps run with the wrapper set", async () => {
    const pack = (await readPack("rust-cache"))!;
    const composed = (await composedOverlay(services(`# ---- rust ----\n${RUSTUP}\n`)))!;
    expect(composed.fragments).toEqual([pack.content]);
    expect(composed.content.indexOf(pack.content)).toBeLessThan(composed.content.indexOf("# ---- rust ----"));
    expect((await composedOverlay(services("# ---- ffmpeg ----\nRUN install ffmpeg\n")))!.fragments).toEqual([]);
});

// The wrapper exactly as the pack writes it: the single-quoted lines of its printf, one per line of the script.
const wrapperScript = async (): Promise<string> => {
    const content = (await readPack("rust-cache"))!.content;
    const printf = content.slice(content.indexOf("printf '%s\\n'") + "printf '%s\\n'".length, content.indexOf("> /usr/local/bin/rustc-cached"));
    const lines = [...printf.matchAll(/'([^']*)'/gu)].map((match) => match[1]);
    const path = join(mkdtempSync(join(tmpdir(), "rustc-cached-")), "rustc-cached");
    writeFileSync(path, `${lines.join("\n")}\n`);
    chmodSync(path, 0o755);
    return path;
};

// A stand-in sccache that says how it was reached: the socket it was told to use and whether fd 9 came with it.
const stubSccache = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "sccache-stub-"));
    writeFileSync(
        join(dir, "sccache"),
        '#!/bin/sh\nfd9=closed\n[ -e /proc/self/fd/9 ] && fd9=open\necho "sccache uds=$SCCACHE_SERVER_UDS fd9=$fd9 args=$*"\n',
    );
    chmodSync(join(dir, "sccache"), 0o755);
    return dir;
};

// The wrapper run as Cargo runs it (`$RUSTC_WRAPPER rustc …`, here `echo plain`), holding fd 9 as a queued build does.
const wrap = (wrapper: string, env: Record<string, string>): string => {
    const slot = openSync(join(mkdtempSync(join(tmpdir(), "slot-")), "slot.0"), "w");
    const run = spawnSync("/bin/sh", [wrapper, "echo", "plain"], {
        env: { PATH: "/usr/bin:/bin", ...env },
        stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", slot],
        encoding: "utf8",
    });
    return run.stdout.trim();
};

test("the wrapper shares one cache on the volume through a server of this mount namespace's own, without the slot", async () => {
    const wrapper = await wrapperScript();
    const stub = stubSccache();
    const cache = join(mkdtempSync(join(tmpdir(), "history-")), "cache", "sccache");
    const namespace = readlinkSync("/proc/self/ns/mnt").replace(/\D/gu, "");
    expect(wrap(wrapper, { PATH: `${stub}:/usr/bin:/bin`, SCCACHE_DIR: cache })).toBe(`sccache uds=/tmp/sccache-${namespace}.sock fd9=closed args=echo plain`);
    expect(existsSync(cache)).toBe(true);
});

test("the wrapper is plain rustc without sccache, without a cache dir, or where the cache's volume is absent", async () => {
    const wrapper = await wrapperScript();
    const stub = { PATH: `${stubSccache()}:/usr/bin:/bin` };
    expect(wrap(wrapper, { SCCACHE_DIR: join(mkdtempSync(join(tmpdir(), "history-")), "sccache") })).toBe("plain");
    expect(wrap(wrapper, { ...stub, SCCACHE_DIR: "" })).toBe("plain");
    // An image build: no /history yet, and a cache made in the layer would only grow the image.
    const unmounted = `/no-volume-${process.pid}/cache/sccache`;
    expect(wrap(wrapper, { ...stub, SCCACHE_DIR: unmounted })).toBe("plain");
    expect(existsSync(unmounted)).toBe(false);
    // A cache path that cannot be a directory (a fenced turn's hidden volume reads the same way).
    const file = join(mkdtempSync(join(tmpdir(), "history-")), "sccache");
    writeFileSync(file, "");
    expect(wrap(wrapper, { ...stub, SCCACHE_DIR: file })).toBe("plain");
});
