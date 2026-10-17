import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { missingProgramError, refusedFetchError } from "@intentic/testing/real-failures";
import { errnoCode, isFetchNetworkFailure, networkCodeOf } from "./errors.js";

// THE READERS AGAINST THE RUNTIMES' OWN FAILURES. errors.test.ts pins the shapes as written down; here the running
// runtime throws them, so a Bun or Node release that moves the code somewhere new fails this suite instead of a
// production classifier. The suites run on Bun and the daemon on Node, so both are asked.

const exec = promisify(execFile);
const errorsModule = fileURLToPath(new URL("./errors.ts", import.meta.url));

// The same reading, run by Node against Node's own fetch. Node strips the module's types itself (Node 23.6+).
const underNode = async (): Promise<{ readonly failure: boolean; readonly code: string | undefined; readonly invalid: boolean }> => {
    const script = `
        const { isFetchNetworkFailure, networkCodeOf } = await import(${JSON.stringify(errorsModule)});
        const { createServer } = await import("node:net");
        const server = createServer();
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address();
        await new Promise((resolve) => server.close(resolve));
        const caught = async (url) => { try { await fetch(url); } catch (error) { return error; } throw new Error(url + " answered"); };
        const refused = await caught("http://127.0.0.1:" + port + "/");
        const invalid = await caught("not a url");
        console.log(JSON.stringify({ failure: isFetchNetworkFailure(refused), code: networkCodeOf(refused), invalid: isFetchNetworkFailure(invalid) }));
    `;
    const { stdout } = await exec("node", ["--no-warnings", "--input-type=module", "-e", script]);
    return JSON.parse(stdout);
};

test("a refused fetch reads as a network failure with its errno, under this runtime", async () => {
    const refused = await refusedFetchError();
    expect(isFetchNetworkFailure(refused)).toBe(true);
    expect(networkCodeOf(refused)).toBe("ECONNREFUSED");
});

test("a refused fetch reads the same under Node, where the daemon runs", async () => {
    expect(await underNode()).toEqual({ failure: true, code: "ECONNREFUSED", invalid: false });
});

test("a program that is not there fails with ENOENT, however the runtime words it", async () => {
    expect(errnoCode(await missingProgramError())).toBe("ENOENT");
});
