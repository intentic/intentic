import type { CommandSpan } from "../command-classes.js";
import { normaliseCommand, readingsOf } from "./command-normalise.js";

// The text the classifier reads besides the command: the command itself when there was no quoting to strip.
const unquoted = (command: string): string => normaliseCommand(command)?.text ?? command;

// The original text behind `fragment` of the copy, as a card would mark it.
const behind = (command: string, fragment: string): string | undefined => {
    const normalised = normaliseCommand(command);
    const start = normalised?.text.indexOf(fragment) ?? -1;
    const span = start === -1 ? undefined : normalised?.original({ start, end: start + fragment.length });
    return span === undefined ? undefined : command.slice(span.start, span.end);
};

test.each([
    [String.raw`r\m -rf ~`, "rm -rf ~"],
    ["r''m -rf ~", "rm -rf ~"],
    ['"rm" -rf ~', "rm -rf ~"],
    ['$"rm" -rf ~', "rm -rf ~"],
    [String.raw`$'\x72m' -rf ~`, "rm -rf ~"],
    [String.raw`$'\162m' -rf ~`, "rm -rf ~"],
    [String.raw`$'rm' -rf ~`, "rm -rf ~"],
    ['g""it push --force', "git push --force"],
    ['git push -"-force"', "git push --force"],
    ["rm${IFS}-rf${IFS}~", "rm -rf ~"],
    ["rm$IFS-rf$IFS~", "rm -rf ~"],
    ["r\\\nm -rf ~", "rm -rf ~"],
])("%j reads as %j", (command, expected) => {
    expect(unquoted(command)).toBe(expected);
});

test("a quoted argument with whitespace stays one argument, its inside read as a nested shell would read it", () => {
    expect(normaliseCommand(`echo "rm -rf ~ is dangerous"`)).toBeUndefined();
    expect(unquoted(`bash -c "r''m -rf ~"`)).toBe(`bash -c "rm -rf ~"`);
    expect(unquoted(`sh -c 'g""it push --force'`)).toBe(`sh -c 'git push --force'`);
});

test("a backslash inside quotes is read as bash reads it there, so a quoted regex keeps its escapes", () => {
    expect(unquoted(String.raw`rg '\.env' src`)).toBe(String.raw`rg \.env src`);
    expect(unquoted(String.raw`grep "\.npmrc" .`)).toBe(String.raw`grep \.npmrc .`);
    expect(unquoted(String.raw`echo "\$HOME"`)).toBe("echo $HOME");
});

test("nothing to strip, an unterminated quote and another variable are left as written", () => {
    for (const command of ["ls -la", `ls -la "my dir"`, `echo "rm -rf`, "echo $IFSX"]) {
        expect(normaliseCommand(command), command).toBeUndefined();
    }
});

test("a span over the copy maps back over the text it was read from, the quotes it lost included", () => {
    expect(behind(`cd /tmp && "rm" -rf ~`, "rm -rf ~")).toBe(`"rm" -rf ~`);
    expect(behind(String.raw`ls; $'\x72m' -rf ~`, "rm")).toBe(String.raw`$'\x72m'`);
    expect(behind(String.raw`r\m -rf ~`, "m")).toBe(String.raw`\m`);
    expect(behind("rm${IFS}-rf ~", " -")).toBe("${IFS}-");
});

describe("readingsOf", () => {
    test("one matcher over both readings, every span over the command's own offsets", () => {
        const read = readingsOf(`"rm" x`, { locus: "device" });
        expect(read((text): CommandSpan[] => (text.startsWith("rm") ? [{ start: 0, end: 2 }] : []))).toEqual([{ start: 0, end: 4 }]);
    });

    test("the file check is asked once per path, though both readings name it", () => {
        const asked: string[] = [];
        const read = readingsOf(`cat "$HOME/.npmrc"`, { locus: "device", holdsSecret: (path) => void asked.push(path) });
        read((_text, context) => {
            context.holdsSecret?.("$HOME/.npmrc");
            return [];
        });
        expect(asked).toEqual(["$HOME/.npmrc"]);
    });
});
