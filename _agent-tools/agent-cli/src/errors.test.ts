import { buildApplication, buildCommand, buildRouteMap, type CommandContext } from "@stricli/core";
import { failure, helpCommand, shellWord, stricliFailure } from "./errors.js";
import { countParser } from "./flags.js";
import { captureCli } from "./testing.js";

describe("failure", () => {
    test("one error line with the tool, the code and the message, then the next step", () => {
        expect(failure("webq", "blocked", "HTTP 403 from https://example.com/docs", "webq fetch https://example.com/docs --browser force")).toBe(
            "webq: error: blocked: HTTP 403 from https://example.com/docs\nwebq: next: webq fetch https://example.com/docs --browser force\n",
        );
    });

    test("with no step worth naming it is the one line", () => {
        expect(failure("fileq", "too_large", "cannot read big.pdf: too-large (300 MB)")).toBe("fileq: error: too_large: cannot read big.pdf: too-large (300 MB)\n");
    });

    test("a message that runs onto more lines keeps its first, so the shape stays one line", () => {
        expect(failure("fileq", "internal", "boom\n    at somewhere (x.ts:1:1)")).toBe("fileq: error: internal: boom\n");
    });
});

describe("shellWord", () => {
    test("a plain path stays as it is; one with spaces, quotes or a URL's & is quoted to paste as one word", () => {
        expect(shellWord("/work/docs/plan.docx")).toBe("/work/docs/plan.docx");
        expect(shellWord("/tmp/a b.docx")).toBe("'/tmp/a b.docx'");
        expect(shellWord("https://x.dev/?a=1&b=2")).toBe("'https://x.dev/?a=1&b=2'");
        expect(shellWord("it's")).toBe("'it'\\''s'");
    });
});

const app = buildApplication(
    buildRouteMap({
        routes: {
            fetch: buildCommand({
                docs: { brief: "takes one url and a budget" },
                parameters: {
                    flags: { budget: { kind: "parsed", parse: countParser, default: "10", brief: "budget" } },
                    positional: { kind: "tuple", parameters: [{ parse: String, brief: "url", placeholder: "url" }] },
                },
                func(this: CommandContext, flags: { readonly budget: number }, url: string) {
                    this.process.stdout.write(`fetched ${url} within ${flags.budget}\n`);
                },
            }),
            gitAttributes: buildCommand({
                docs: { brief: "takes nothing" },
                parameters: { positional: { kind: "tuple", parameters: [] } },
                func(this: CommandContext) {
                    throw new Error("the attributes went missing");
                },
            }),
        },
        docs: { brief: "fixture" },
    }),
    { name: "fixture", scanner: { caseStyle: "allow-kebab-for-camel" }, determineExitCode: () => 2 },
);

describe("stricli's own errors", () => {
    test("an unknown flag reads as a usage error naming the verb's help, on the error line's shape", async () => {
        const outcome = await captureCli(app, ["fetch", "https://x.dev", "--budgt", "5"]);
        expect(outcome.exitCode).toBe(2);
        expect(outcome.err).toBe("fixture: error: usage: No flag registered for --budgt, did you mean --budget?\nfixture: next: fixture fetch --help\n");
    });

    test("a flag value its parser refuses is a usage error too", async () => {
        const outcome = await captureCli(app, ["fetch", "https://x.dev", "--budget", "-5"]);
        expect(outcome.err).toBe('fixture: error: usage: Failed to parse "-5" for budget: expected a non-negative number, got "-5"\nfixture: next: fixture fetch --help\n');
    });

    test("an unknown verb points at the tool's help, with stricli's guess kept", async () => {
        const outcome = await captureCli(app, ["fetsh"]);
        expect(outcome.err).toBe("fixture: error: usage: No command registered for `fetsh`, did you mean `fetch`?\nfixture: next: fixture --help\n");
    });

    test("a command that throws is internal, its first line kept and the stack dropped", async () => {
        const outcome = await captureCli(app, ["git-attributes"]);
        expect(outcome.exitCode).toBe(2);
        expect(outcome.err).toBe(
            "fixture: error: internal: Error: the attributes went missing\n" +
                "fixture: next: this is fixture's own failure, not an empty answer: report it with the command that was run\n",
        );
    });

    test("terminal colour is stripped, and text that is not stricli's passes through untouched", () => {
        const red = `${String.fromCharCode(27)}[1m${String.fromCharCode(27)}[31mExpected argument for url${String.fromCharCode(27)}[39m${String.fromCharCode(27)}[22m\n`;
        expect(stricliFailure("fixture", red, "fixture fetch --help")).toBe("fixture: error: usage: Expected argument for url\nfixture: next: fixture fetch --help\n");
        expect(stricliFailure("fixture", "Could not detect the document format\n", "fixture --help")).toBeUndefined();
    });
});

describe("helpCommand", () => {
    test("names the verb the line started with, kebab spelling included, and the tool's help otherwise", () => {
        expect(helpCommand("fixture", app, ["fetch", "--nope"])).toBe("fixture fetch --help");
        expect(helpCommand("fixture", app, ["git-attributes", "x"])).toBe("fixture git-attributes --help");
        expect(helpCommand("fixture", app, ["notes.docx", "--nope"])).toBe("fixture --help");
        expect(helpCommand("fixture", app, ["--nope"])).toBe("fixture --help");
        expect(helpCommand("fixture", app, [])).toBe("fixture --help");
    });
});
