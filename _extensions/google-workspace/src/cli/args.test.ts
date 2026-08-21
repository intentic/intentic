import { describe, expect, it } from "vitest";
import { UsageError, bool, flag, limit, list, parseArgs, positional, required } from "./args.js";

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
