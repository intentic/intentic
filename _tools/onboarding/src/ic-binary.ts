import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";
import { repoRoot } from "@intentic/constants/node";

// Runs this checkout's own ic binary, not the wizard's fetch-latest-release one, so this lane tests this branch, not
// the last release. Checked in order, all from this checkout:
// - IC_BIN: handed in by CI, cross-built with the Rust toolchain.
// - _sandbox/ic/dist-bin/…: what build-ic.sh left, for a developer who already built one.
// - target/release/ic: a previous cargo build --release in this tree.
// - cargo: build it now, if the toolchain is here.
// With none found, stands down with an actionable message rather than failing red, since this tier blocks releases.

const run = promisify(execFile);
const root = repoRoot(import.meta.url);

// What `build-ic.sh linux-x64` writes: a static musl binary, same artifact shipped via IC_BIN.
const BUILT = join(root, `_sandbox/ic/dist-bin/ic-linux-amd64`);
const CARGO_BUILT = join(root, `_sandbox/ic/target/release/ic`);
const MANIFEST = join(root, `_sandbox/ic/Cargo.toml`);

export type IcBinary = { readonly path: string } | { readonly standDown: string };

const executable = async (path: string): Promise<boolean> => {
    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
};

const haveCargo = async (): Promise<boolean> => {
    try {
        await run(`cargo`, [`--version`], { timeout: 30_000 });
        return true;
    } catch {
        return false;
    }
};

export const findIcBinary = async (): Promise<IcBinary> => {
    const handedIn = process.env[`IC_BIN`];
    if (handedIn !== undefined && handedIn !== `` && (await executable(handedIn))) {
        return { path: handedIn };
    }
    for (const candidate of [BUILT, CARGO_BUILT]) {
        if (await executable(candidate)) {
            return { path: candidate };
        }
    }
    if (!(await haveCargo())) {
        return {
            standDown:
                `the CLI lane needs this checkout's ic binary and found none: no IC_BIN, nothing at ` +
                `_sandbox/ic/dist-bin/ic-linux-amd64, and no cargo to build one. Build it with ` +
                `bash _tools/scripts/build/build-ic.sh linux-x64, or point IC_BIN at one.`,
        };
    }
    try {
        // Release profile: the lane runs inside this binary the whole run, and a debug build polls docker slower.
        await run(`cargo`, [`build`, `--release`, `--manifest-path`, MANIFEST], { timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    } catch (cause) {
        return { standDown: `building ic from this checkout failed: ${errorMessage(cause)}` };
    }
    return (await executable(CARGO_BUILT))
        ? { path: CARGO_BUILT }
        : { standDown: `cargo build --release succeeded but left no binary at ${CARGO_BUILT}` };
};
