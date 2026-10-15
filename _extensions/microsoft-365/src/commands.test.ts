import { parse, validateArguments } from "./commands.js";

test("a flag no command reads, a missing id or a stray word is refused before anything is sent", () => {
    expect(() => parse(["mail", "list", "--unknown", "x"])).toThrow("Unknown");
    expect(() => parse(["mail", "list", "--limit"])).toThrow("empty flag");
    expect(() => parse(["mail", "list", "--limit", "5", "--limit", "6"])).toThrow("repeated");
    expect(() => validateArguments(parse(["mail", "list", "--file", "ignored.json"]))).toThrow("not an option of `m365 mail list`");
    expect(() => validateArguments(parse(["whoami", "extra"]))).toThrow("takes no further words");
    expect(() => validateArguments(parse(["mail", "read"]))).toThrow("takes one id");
    expect(() => validateArguments(parse(["mail", "explode"]))).toThrow("m365 [--account");
    expect(() => validateArguments(parse(["--account", "office", "mail", "reply-all", "id", "--file", "r.json"]))).not.toThrow();
});
