import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { jest, mock } from "bun:test";

// A MOCK NAMES A REAL MODULE AND STANDS IN FOR ALL OF IT. Every `jest.mock(path, factory)` (bun's `mock.module`) in every
// suite goes through here, by the shared preload:
// - the path is resolved from the file that mocks it, so a mock of a module that moved or was renamed fails at its own
//   line, naming the path. It used to register a mock nothing loads, leave the real module in place, and fail somewhere
//   else (ExtensionHost.test.ts waited for good on a page the real extensionStatuses never finished, CI 38812958978).
// - a module not loaded yet becomes whatever the factory returns, so every export the real module has and the factory
//   leaves out is filled with a stand-in that throws when called (or constructed), naming the module and the export.
//   (A module already loaded bun patches in place, keeping the exports the factory leaves out; it is left to do so.) A module that gains an export no longer fails, at link time
//   and outside any test, every file that mocks it (26 web files mocked the analytics module with `track` alone once
//   clientDiagnostics imported `replaySessionId`); a test that does reach the new export is told which one to provide.
// Only source files are filled: a package from node_modules or a builtin is mocked exactly as the factory says.

const transpiler = new Bun.Transpiler({ loader: "tsx" });
const REEXPORT_ALL = /export\s*\*\s*from\s*["']([^"']+)["']/g;

// Every name `file` exports, `export * from` followed; empty for a file the scanner cannot read (a .vue component).
const exportsOf = (file: string, seen = new Set<string>()): ReadonlySet<string> => {
    if (seen.has(file)) {
        return new Set();
    }
    seen.add(file);
    try {
        const source = readFileSync(file, "utf8");
        const names = new Set(transpiler.scan(source).exports);
        for (const [, from = ""] of source.matchAll(REEXPORT_ALL)) {
            for (const name of exportsOf(Bun.resolveSync(from, dirname(file)), seen)) {
                if (name !== "default") {
                    names.add(name);
                }
            }
        }
        return names;
    } catch {
        // allow(silent-catch): an unreadable module is mocked exactly as its factory says, as before this guard
        return new Set();
    }
};

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const fillable = (file: string): boolean => file.startsWith("/") && !file.includes("/node_modules/") && SOURCE.test(file);

// What a mock factory hands back: the module's exports, as an object keyed by export name. Whatever the test wrote.
type MockedModule = object;
type Factory = () => MockedModule | Promise<MockedModule>;

const standIn =
    (specifier: string, name: string) =>
    (): never => {
        throw new Error(`${name} from "${specifier}" was called, and the jest.mock of it in this file does not provide it: add it to the factory`);
    };

// The factory's own exports, getters kept live, and a stand-in for every name it left out.
const filled = (specifier: string, names: ReadonlySet<string>, given: PropertyDescriptorMap): MockedModule => {
    const out = Object.defineProperties({}, given);
    for (const name of names) {
        if (!(name in out)) {
            Object.defineProperty(out, name, { value: standIn(specifier, name), enumerable: true });
        }
    }
    return out;
};

// The test file that called the mock: the first frame outside this module.
const callerFile = (): string | undefined => {
    for (const line of (new Error("where the mock was declared").stack ?? "").split("\n").slice(1)) {
        const file = /\(?((?:\/|[A-Za-z]:[\\/])[^():]+):\d+:\d+\)?\s*$/.exec(line.trim())?.[1];
        if (file !== undefined && file !== import.meta.path) {
            return file;
        }
    }
    return undefined;
};

const original = mock.module.bind(mock);

const guarded = (specifier: string, factory: Factory): void | Promise<void> => {
    const from = callerFile();
    if (from === undefined) {
        return original(specifier, factory);
    }
    let resolved: string;
    try {
        resolved = Bun.resolveSync(specifier, dirname(from));
    } catch {
        throw new Error(`jest.mock("${specifier}") in ${from} names no module from there: it moved or was renamed, so mock it where it is now`);
    }
    // Already loaded, bun patches the module in place and keeps every export the factory leaves out: nothing to fill.
    if (!fillable(resolved) || resolved in require.cache) {
        return original(resolved, factory);
    }
    const names = exportsOf(resolved);
    return original(resolved, () => {
        const given = factory();
        return given instanceof Promise ? given.then((value) => filled(specifier, names, Object.getOwnPropertyDescriptors(value)))
            : filled(specifier, names, Object.getOwnPropertyDescriptors(given));
    });
};

/** Puts the guard in front of `mock.module` and `jest.mock`, the global one included; the shared preload calls it once. */
export const guardModuleMocks = (): void => {
    Object.assign(mock, { module: guarded });
    Object.assign(jest, { mock: guarded });
    if (globalThis.jest !== undefined && globalThis.jest !== jest) {
        Object.assign(globalThis.jest, { mock: guarded });
    }
};
