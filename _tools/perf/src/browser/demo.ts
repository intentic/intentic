import { spawn } from "node:child_process";
import { join } from "node:path";
import { freePort } from "@intentic/base/fs";

export interface DemoServer {
    /** `http://127.0.0.1:<port>`; the demo's routes live under `/demo/`. */
    readonly origin: string;
    /** Everything Vite printed since it started, for spotting a mid-run dependency re-optimisation. */
    readonly log: () => string;
    readonly stop: () => Promise<void>;
}

/**
 * Starts `_site/demo`'s Vite directly rather than `pnpm dev`, which first fetches the listed extensions from GitHub:
 * the counts must not depend on the network. `--force` re-optimises dependencies so a stale pre-bundle cannot serve old
 * code.
 */
export const startDemo = async (repo: string): Promise<DemoServer> => {
    // 47145/47146 may be port-mirrors of the owner's servers, so the port is always one the OS just handed out.
    const port = await freePort();
    const demo = join(repo, "_site", "demo");
    const child = spawn(process.execPath, [join(demo, "node_modules", "vite", "bin", "vite.js"), "--port", String(port), "--strictPort", "--force"], {
        cwd: demo,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    let output = "";
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`demo server did not start within 60s:\n${output}`)), 60_000);
        const read = (chunk: Buffer): void => {
            output += chunk.toString();
            if (output.includes(`:${port}/`)) {
                clearTimeout(timer);
                resolve();
            }
        };
        child.stdout.on("data", read);
        child.stderr.on("data", read);
        child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`demo server exited with ${code}:\n${output}`));
        });
    });
    return {
        origin: `http://127.0.0.1:${port}`,
        log: () => output,
        stop: async () => {
            if (child.exitCode === null) {
                child.kill("SIGTERM");
                await exited;
            }
        },
    };
};
