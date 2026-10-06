import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_FLAGS, UsageError, bool, flag, limit, list, parseArgs, positional, rejectUnknownFlags, required } from "./args.js";

describe("parseArgs", () => {
    it("reads a flag and its value, however it was spelled", () => {
        expect(flag(parseArgs(["--to", "a@x.com"]), "to")).toBe("a@x.com");
        expect(flag(parseArgs(["--to=a@x.com"]), "to")).toBe("a@x.com");
        expect(flag(parseArgs(["-n", "20"]), "n")).toBe("20");
    });

    it("keeps positionals in order, apart from the flags", () => {
        const args = parseArgs(["mail", "search", "--json", "from:ana", "is:unread"]);
        expect(args.positional).toEqual(["mail", "search", "from:ana", "is:unread"]);
        expect(bool(args, "json")).toBe(true);
    });

    // A flag whose next token is another flag takes no value: otherwise `--json --to x` would set json="--to".
    it("does not swallow the next flag as a value", () => {
        const args = parseArgs(["--all", "--body", "hi"]);
        expect(bool(args, "all")).toBe(true);
        expect(flag(args, "body")).toBe("hi");
    });

    // Negative numbers are values, not flags: the one place the leading dash has to be looked past.
    it("takes a negative number as a value", () => {
        expect(flag(parseArgs(["--offset", "-5"]), "offset")).toBe("-5");
    });

    it("stops reading flags after --, so a subject can start with a dash", () => {
        const args = parseArgs(["mail", "send", "--", "--not-a-flag"]);
        expect(args.positional).toEqual(["mail", "send", "--not-a-flag"]);
        expect(bool(args, "not-a-flag")).toBe(false);
    });

    it("splits a comma list and drops the blanks around it", () => {
        expect(list(parseArgs(["--to", "a@x.com, b@y.com ,"]), "to")).toEqual(["a@x.com", "b@y.com"]);
        expect(list(parseArgs([]), "to")).toEqual([]);
    });
});

describe("what a command demands", () => {
    it("names the flag that was missing", () => {
        expect(() => required(parseArgs([]), "subject")).toThrow(UsageError);
        expect(() => required(parseArgs([]), "subject")).toThrow(/--subject is required/);
    });

    it("names the positional that was missing, in the words the caller used", () => {
        expect(() => positional(parseArgs(["mail", "read"]), 2, "A message id")).toThrow(/A message id is required/);
    });

    // The ceiling is what keeps a stray -n from walking a whole mailbox one page at a time.
    it("caps a count at the command's ceiling and refuses a nonsense one", () => {
        expect(limit(parseArgs([]), 20)).toBe(20);
        expect(limit(parseArgs(["-n", "5"]), 20)).toBe(5);
        expect(limit(parseArgs(["-n", "100000"]), 20, 200)).toBe(200);
        expect(() => limit(parseArgs(["-n", "lots"]), 20)).toThrow(UsageError);
        expect(() => limit(parseArgs(["-n", "0"]), 20)).toThrow(/positive/);
    });
});

describe("flags gw does not know", () => {
    it("are refused before anything runs, naming the flag a typo probably meant", () => {
        expect(() => rejectUnknownFlags(parseArgs(["mail", "send", "--to", "a@x", "--attachh", "f.pdf"]))).toThrow(
            new UsageError("unknown flag --attachh; did you mean --attach? (gw <group> lists each command's flags)"),
        );
        expect(() => rejectUnknownFlags(parseArgs(["drive", "ls", "--colour", "red"]))).toThrow(
            new UsageError("unknown flag --colour (gw <group> lists each command's flags)"),
        );
    });

    it("let every flag gw reads through", () => {
        expect(() => rejectUnknownFlags(parseArgs(["cal", "list", "--calendar", "work", "-n", "5", "--json"]))).not.toThrow();
    });

    // The list is only safe while it holds every flag a command asks for: one missing would refuse a working command.
    it("include every flag name the sources read", () => {
        const sources = (dir: string): string[] =>
            readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) {
                    return sources(path);
                }
                return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
            });
        const read = new Set<string>();
        const call = /\b(?:flag|bool|list|required)\((?:ctx\.)?args((?:,\s*"[a-z][a-z-]*")+)\)|flags\.(?:has|get|set)\("([a-z][a-z-]*)"/g;
        for (const file of sources(join(import.meta.dir, ".."))) {
            for (const match of readFileSync(file, "utf8").matchAll(call)) {
                for (const name of (match[1] ?? `"${match[2]}"`).matchAll(/"([a-z][a-z-]*)"/g)) {
                    read.add(name[1] ?? "");
                }
            }
        }
        // The scan itself must see the reads it guards, one from each way a flag is asked for.
        expect(["attach", "csv", "case", "client-id", "meet", "json"].filter((name) => !read.has(name))).toEqual([]);
        expect([...read].filter((name) => !KNOWN_FLAGS.has(name))).toEqual([]);
        // `limit()` reads -n and --limit through its own spelling, which the scan above cannot see.
        expect(["n", "limit"].filter((name) => !KNOWN_FLAGS.has(name))).toEqual([]);
    });
});

describe("a flag that names a file", () => {
    // `--csv` was listed as valueless, so `--csv rows.csv` arrived as a switch plus a stray positional, and
    // `gw sheets write` answered that no data was passed.
    it("keeps its value", () => {
        const args = parseArgs(["sheets", "write", "ID", "--range", "Sheet1!A1", "--csv", "rows.csv"]);
        expect(flag(args, "csv")).toBe("rows.csv");
        expect(args.positional).toEqual(["sheets", "write", "ID"]);
    });

    it("while a switch at the end of a line leaves the id after it alone", () => {
        const args = parseArgs(["docs", "replace", "--find", "a", "--with", "b", "--case", "DOC1"]);
        expect(bool(args, "case")).toBe(true);
        expect(args.positional).toEqual(["docs", "replace", "DOC1"]);
    });
});
