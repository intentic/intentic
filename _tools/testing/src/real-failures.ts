// REAL FAILURES, NOT HAND-WRITTEN ONES. A test that fakes a dependency's failure by writing its sentence
// (`new TypeError("fetch failed")`, `new Error("spawn git ENOENT")`) proves the code reads that sentence, and keeps
// passing after the runtime words it differently. Node's fetch says `fetch failed` and hangs the errno on `cause`; Bun's
// says `ECONNREFUSED: Unable to connect…` and puts the errno on the error itself; the suites run on Bun while the daemon
// runs on Node. Each helper here makes the running runtime produce the failure, so a fake built from one has the shape
// production meets, and a runtime that changes that shape fails the suite instead of production.
import { execFile } from "node:child_process";
import { createServer } from "node:net";

// A loopback port nothing listens on: bound by this process and released, so no other test holds it either.
const releasedPort = async (): Promise<number> => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (address === null || typeof address === "string") {
        throw new Error("a loopback listener answered no port");
    }
    return address.port;
};

// Both runtimes reject with an Error; anything else is a runtime this suite has not met, said rather than passed on.
const asError = (thrown: unknown, what: string): Error => {
    if (thrown instanceof Error) {
        return thrown;
    }
    throw new Error(`${what} rejected with a non-Error: ${String(thrown)}`);
};

// What this runtime's fetch rejects with for a connection nobody accepts.
export const refusedFetchError = async (): Promise<Error> => {
    const port = await releasedPort();
    try {
        await fetch(`http://127.0.0.1:${port}/`);
    } catch (error) {
        return asError(error, "a refused fetch");
    }
    throw new Error(`a fetch of released port ${port} was answered`);
};

// What this runtime's execFile fails with for a program that is not on PATH (Node: `spawn x ENOENT`, Bun: `Executable not
// found in $PATH: "x"`; both with code ENOENT).
export const missingProgramError = async (program = "intentic-no-such-program"): Promise<Error> =>
    await new Promise((resolve, reject) => {
        execFile(program, [], (error) => (error === null ? reject(new Error(`${program} ran`)) : resolve(asError(error, "a missing program"))));
    });
