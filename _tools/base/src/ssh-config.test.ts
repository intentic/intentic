import { hasManagedInclude, includedPaths, withManagedInclude, withoutManagedIncludes } from "./ssh-config.js";

const ours = (path: string): boolean => path === "intentic-hosts/*.conf";
const LINE = "Include intentic-hosts/*.conf";

test("includedPaths reads ssh's spellings and only live lines", () => {
    expect(includedPaths("Include a.conf")).toEqual(["a.conf"]);
    expect(includedPaths("  include=a.conf\r")).toEqual(["a.conf"]);
    expect(includedPaths(`INCLUDE "C:/Users/First Last/x" b.conf`)).toEqual(["C:/Users/First Last/x", "b.conf"]);
    expect(includedPaths("# Include a.conf")).toBeUndefined();
    expect(includedPaths("Host a.conf")).toBeUndefined();
    expect(includedPaths("IncludeX a.conf")).toBeUndefined();
});

// The daemon once tested `config.includes(line)`, so a line the user had commented out read as present and the hosts
// it managed silently stopped resolving.
test("a commented-out include is not present", () => {
    expect(hasManagedInclude(`# ${LINE}\nHost box\n`, ours)).toBe(false);
    expect(hasManagedInclude(`#${LINE}`, ours)).toBe(false);
    expect(hasManagedInclude(`Host box\n    HostName x\n${LINE}\n`, ours)).toBe(true);
});

test("a user's include of several paths is theirs, even when one of them is ours", () => {
    const config = `Include ~/.ssh/work.conf intentic-hosts/*.conf\n`;
    expect(hasManagedInclude(config, ours)).toBe(false);
    expect(withoutManagedIncludes(config, ours)).toBe(config);
});

test("adding puts exactly one live include first and leaves every other line, comments included, as it was", () => {
    const user = `# ${LINE}\nHost box\n    HostName 10.0.0.2\n${LINE}\n`;
    expect(withManagedInclude(user, LINE, ours)).toBe(`${LINE}\n# ${LINE}\nHost box\n    HostName 10.0.0.2\n`);
    expect(withManagedInclude("", LINE, ours)).toBe(`${LINE}\n`);
});

test("a config already in shape comes back unchanged, so the caller can skip the write", () => {
    const config = `${LINE}\nHost box\n`;
    expect(withManagedInclude(config, LINE, ours)).toBe(config);
});

test("removing drops our lines, CRLF ones too, and nothing else", () => {
    expect(withoutManagedIncludes(`${LINE}\r\nHost box\r\n# ${LINE}\r\n`, ours)).toBe(`Host box\r\n# ${LINE}\r\n`);
});
