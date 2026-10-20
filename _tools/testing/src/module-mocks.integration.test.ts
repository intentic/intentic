import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The guard every suite's module mocks pass through (module-mocks.ts, installed by the shared preload), pinned on the two
// ways a mock drifted from its module in October: a module that gained an export failed every file mocking it at link
// time (the analytics module and `replaySessionId`, 26 web files), and a mock of a module that had moved mocked nothing
// and left the real module loaded (ExtensionHost.test.ts and `extensionStatuses`).

const dir = mkdtempSync(join(tmpdir(), "module-mocks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "more"), { recursive: true });
writeFileSync(join(dir, "more/extra.ts"), "export const replaySessionId = (): string => 'real';\n");
writeFileSync(join(dir, "analytics.ts"), "export const track = (): string => 'real';\nexport * from './more/extra';\n");
writeFileSync(join(dir, "diagnostics.ts"), "import { replaySessionId, track } from './analytics';\nexport const send = (): string => track();\nexport const session = (): string => replaySessionId();\n");

test("an export the factory left out links, and throws by name only when called", async () => {
    jest.mock(join(dir, "analytics.ts"), () => ({ track: () => "mocked" }));
    const diagnostics = await import(join(dir, "diagnostics.ts"));
    expect(diagnostics.send()).toBe("mocked");
    expect(() => diagnostics.session()).toThrow(`replaySessionId from "${join(dir, "analytics.ts")}" was called, and the jest.mock of it in this file does not provide it`);
});

test("a mock of a path that names no module fails where it is declared", () => {
    expect(() => jest.mock("./moved-away-long-ago", () => ({}))).toThrow(/jest\.mock\("\.\/moved-away-long-ago"\) in .*module-mocks\.integration\.test\.ts names no module from there/);
});
