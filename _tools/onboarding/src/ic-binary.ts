import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";
import { repoRoot } from "@intentic/constants/node";

/* THE `ic` BINARY THE CLI LANE DRIVES, AND WHY IT IS NOT THE ONE A USER DOWNLOADS.
 *
 * The one-liner the wizard renders is a bootstrap shim: it fetches `ic` from the LATEST GITHUB RELEASE, gets
 * the machine ready for Docker, and hands the whole flow over to `ic sandbox connect`. Running those bytes
 * verbatim here would test the last release rather than this branch — the objection images.ts makes about
 * pulling `:latest` instead of building the api — and on a machine with no Docker it would try to install
 * some. So this lane takes the setup CODE off the rendered command and runs THIS checkout's binary against
 * this run's platform. The shim's own half (fetching ic, preparing Docker) is what the desktop smokes cover,
 * on both operating systems, against the bytes an installer actually shipped.
 *
 * FOUR SOURCES, most explicit first, and every one of them is this checkout:
 *
 *   IC_BIN                       CI hands one in, cross-built by a job that has the Rust toolchain.
 *   _sandbox/ic/dist-bin/…       what build-ic.sh leaves; a developer who has already built one.
 *   target/release/ic            a previous `cargo build --release` in this tree.
 *   cargo                        build it now, when the toolchain is here.
 *
 * With none of those, the lane STANDS DOWN with the sentence that fixes it, exactly as the world does without
 * Docker: this tier gates releases, so every reason it is red has to be one somebody can act on, and "no Rust
 * toolchain on this machine" is a fact about the machine rather than about the product.
 */

const run = promisify(execFile);
const root = repoRoot(import.meta.url);

// What `_tools/scripts/build/build-ic.sh linux-x64` writes: a static musl binary, the same artifact the
// desktop setup tier hands the shipped connect.sh through IC_BIN.
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
        // Minutes on a cold registry, seconds on a warm one. Release profile, because this is the binary the
        // lane spends its whole run inside and a debug build's docker polling is measurably slower.
        await run(`cargo`, [`build`, `--release`, `--manifest-path`, MANIFEST], { timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    } catch (cause) {
        return { standDown: `building ic from this checkout failed: ${errorMessage(cause)}` };
    }
    return (await executable(CARGO_BUILT))
        ? { path: CARGO_BUILT }
        : { standDown: `cargo build --release succeeded but left no binary at ${CARGO_BUILT}` };
};
