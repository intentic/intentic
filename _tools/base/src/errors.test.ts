import { errnoCode, errorMessage, exitCodeOf, isFetchNetworkFailure, isMissing, networkCodeOf, stderrOf, stdoutOf, undefinedIfMissing } from "./errors.js";

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe(`errorMessage`, () => {
    it(`reads an Error's message and stringifies everything else`, () => {
        expect(errorMessage(new Error(`boom`))).toBe(`boom`);
        expect(errorMessage(new TypeError(``))).toBe(``);
        expect(errorMessage(`plain`)).toBe(`plain`);
        expect(errorMessage(42)).toBe(`42`);
        expect(errorMessage(undefined)).toBe(`undefined`);
        expect(errorMessage({ message: `duck` })).toBe(`[object Object]`);
    });
});

describe(`errnoCode`, () => {
    it(`reads a string code and nothing else`, () => {
        expect(errnoCode(errno(`EACCES`))).toBe(`EACCES`);
        expect(errnoCode({ code: 404 })).toBeUndefined();
        expect(errnoCode(new Error(`plain`))).toBeUndefined();
        expect(errnoCode(`ENOENT`)).toBeUndefined();
        expect(errnoCode(undefined)).toBeUndefined();
    });
});

describe(`isMissing`, () => {
    it(`is true for ENOENT and ENOTDIR only`, () => {
        expect(isMissing(errno(`ENOENT`))).toBe(true);
        expect(isMissing(errno(`ENOTDIR`))).toBe(true);
        expect(isMissing(errno(`EACCES`))).toBe(false);
        expect(isMissing(errno(`EISDIR`))).toBe(false);
        expect(isMissing(new TypeError(`x is undefined`))).toBe(false);
    });
});

describe(`undefinedIfMissing`, () => {
    it(`answers undefined for a missing path`, async () => {
        await expect(Promise.reject(errno(`ENOENT`)).catch(undefinedIfMissing)).resolves.toBeUndefined();
    });

    it(`rethrows every other failure unchanged`, async () => {
        const denied = errno(`EACCES`);
        await expect(Promise.reject(denied).catch(undefinedIfMissing)).rejects.toBe(denied);
        const bug = new TypeError(`x is undefined`);
        await expect(Promise.reject(bug).catch(undefinedIfMissing)).rejects.toBe(bug);
    });
});

// The shapes below are the two runtimes' own, as each throws them (errors.integration.test.ts has them thrown for real):
// Bun puts the errno on the TypeError, Node's undici on its cause, an AggregateError there for a multi-address host.
const bunRefused = Object.assign(new TypeError(`ECONNREFUSED: Unable to connect. Is the computer able to access the url?`), { code: `ECONNREFUSED` });
const nodeRefused = new TypeError(`fetch failed`, { cause: errno(`ECONNREFUSED`) });
const nodeRefusedEverywhere = new TypeError(`fetch failed`, {
    cause: Object.assign(new AggregateError([errno(`ECONNREFUSED`), errno(`ECONNREFUSED`)]), { code: `ECONNREFUSED` }),
});

describe(`stderrOf and exitCodeOf`, () => {
    it(`read what execFile hangs on a failed command, and nothing else`, () => {
        const failed = Object.assign(new Error(`Command failed: git status`), { code: 128, stderr: `fatal: not a git repository\n` });
        expect(stderrOf(failed)).toBe(`fatal: not a git repository\n`);
        expect(exitCodeOf(failed)).toBe(128);
        // A spawn failure's string code is an errno, not an exit status.
        expect(exitCodeOf(errno(`ENOENT`))).toBeUndefined();
        expect(stderrOf(new Error(`plain`))).toBeUndefined();
        expect(stderrOf(`fatal: text`)).toBeUndefined();
    });

    it(`reads the stdout a command printed before exiting non-zero, whose exit is its answer`, () => {
        const conflicted = Object.assign(new Error(`Command failed: git merge-tree`), { code: 1, stdout: `4b825dc\0a.ts\0`, stderr: `` });
        expect([stdoutOf(conflicted), exitCodeOf(conflicted)]).toEqual([`4b825dc\0a.ts\0`, 1]);
        expect(stdoutOf(new Error(`plain`))).toBeUndefined();
        expect(stdoutOf(Object.assign(new Error(`odd`), { stdout: Buffer.from(`bytes`) }))).toBeUndefined();
    });

    it(`does not read a DOMException's legacy error number as an exit`, () => {
        expect(exitCodeOf(new DOMException(`timed out`, `TimeoutError`))).toBeUndefined();
    });
});

describe(`networkCodeOf`, () => {
    it(`finds the code on the error, on its cause, or on the first attempt of an AggregateError`, () => {
        expect(networkCodeOf(bunRefused)).toBe(`ECONNREFUSED`);
        expect(networkCodeOf(nodeRefused)).toBe(`ECONNREFUSED`);
        expect(networkCodeOf(nodeRefusedEverywhere)).toBe(`ECONNREFUSED`);
        expect(networkCodeOf(new TypeError(`fetch failed`, { cause: new AggregateError([errno(`ENETUNREACH`)]) }))).toBe(`ENETUNREACH`);
        expect(networkCodeOf(new TypeError(`fetch failed`))).toBeUndefined();
    });

    it(`stops on a cause cycle`, () => {
        const looped = new Error(`a`);
        Object.assign(looped, { cause: looped });
        expect(networkCodeOf(looped)).toBeUndefined();
    });
});

describe(`isFetchNetworkFailure`, () => {
    it(`is true for either runtime's refusal, whatever its sentence`, () => {
        expect(isFetchNetworkFailure(bunRefused)).toBe(true);
        expect(isFetchNetworkFailure(nodeRefused)).toBe(true);
        expect(isFetchNetworkFailure(nodeRefusedEverywhere)).toBe(true);
        // Node's own refusal of a blocked port carries a cause with no code.
        expect(isFetchNetworkFailure(new TypeError(`fetch failed`, { cause: new Error(`bad port`) }))).toBe(true);
    });

    it(`is false for a malformed request, an abort, a deadline and a bug`, () => {
        expect(isFetchNetworkFailure(Object.assign(new TypeError(`fetch() URL is invalid`), { code: `ERR_INVALID_URL` }))).toBe(false);
        expect(isFetchNetworkFailure(new TypeError(`Failed to parse URL from x`, { cause: Object.assign(new TypeError(`Invalid URL`), { code: `ERR_INVALID_URL` }) }))).toBe(false);
        expect(isFetchNetworkFailure(new DOMException(`aborted`, `AbortError`))).toBe(false);
        expect(isFetchNetworkFailure(new DOMException(`timed out`, `TimeoutError`))).toBe(false);
        expect(isFetchNetworkFailure(new TypeError(`Cannot read properties of undefined (reading 'json')`))).toBe(false);
        // The sentence alone is no evidence: Node's wording with nothing under it is somebody's hand-written fake.
        expect(isFetchNetworkFailure(new TypeError(`fetch failed`))).toBe(false);
        expect(isFetchNetworkFailure(errno(`ECONNREFUSED`))).toBe(false);
    });
});
