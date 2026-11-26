// Which shell searches the empty-search probes read, and how; and the copy held to @intentic/text-search's probes, whose
// note and rg reading this file's module repeats because the image copies it to /usr/local/bin as written.
import { expect, test } from "bun:test";
import * as original from "../../../../_agent-tools/text-search/src/probes.ts";
import { hasCase, PROBE_BUDGET_MS, PROBE_PRUNE_GLOBS, probeNote, probesOf, REGEX_SYNTAX, RG_LABELS, searchCommandOf, searchOfWords } from "../search-probes.mjs";

const searchOf = (line, cwd = "/repo") => {
    const command = searchCommandOf(line, cwd);
    const search = command === undefined ? undefined : searchOfWords(command.words);
    return search === undefined ? undefined : { ...search, cwd: command.cwd, piped: command.piped };
};

test("simple rg and recursive grep lines are read: pattern, paths, kept flags, where they ran", () => {
    expect(searchOf(`rg -n "fooBar" src lib`)).toMatchObject({ program: "rg", pattern: "fooBar", paths: ["src", "lib"], kept: [], cwd: "/repo", piped: false });
    expect(searchOf(`rg -tts -g '*.vue' --glob=!dist -w -e 'a.b' -- -dir`)).toMatchObject({
        pattern: "a.b",
        paths: ["-dir"],
        kept: ["-t", "ts", "-g", "*.vue", "--glob=!dist", "-w"],
    });
    expect(searchOf(`cd /work/intentic && cd _tools && rg needle 2>/dev/null | head -20`)).toMatchObject({
        pattern: "needle",
        cwd: "/work/intentic/_tools",
        piped: true,
    });
    expect(searchOf(`grep -rn --include=*.ts "fooBar" src`)).toMatchObject({ program: "grep", pattern: "fooBar", paths: ["src"], kept: ["-r", "--include=*.ts"] });
    expect(searchOf(`grep -rnC3 'x' .`)).toMatchObject({ pattern: "x", paths: ["."], kept: ["-r"] });
    // grep's --color takes its value only after `=`, never the next word.
    expect(searchOf(`grep -r --color foo .`)).toMatchObject({ pattern: "foo", paths: ["."] });
    expect(searchOf(`grep -r --color=always foo .`)).toMatchObject({ pattern: "foo", paths: ["."] });
    expect(searchOf(`rg --color never foo`)).toMatchObject({ pattern: "foo", paths: [] });
});

test("the case a search ran with is read as rg reads it: the last of -i, -s and -S, smart case by the pattern", () => {
    expect(searchOf(`rg -i foo`)?.ignoreCase).toBe(true);
    expect(searchOf(`rg -i -s foo`)?.ignoreCase).toBe(false);
    expect(searchOf(`rg -S foo`)?.ignoreCase).toBe(true);
    expect(searchOf(`rg -S Foo`)?.ignoreCase).toBe(false);
    expect(searchOf(`rg -uu foo`)).toMatchObject({ hidden: true, noIgnore: true });
    expect(searchOf(`rg -u foo`)).toMatchObject({ hidden: false, noIgnore: true });
    expect(searchOf(`grep -ri foo .`)?.ignoreCase).toBe(true);
});

test("anything the shell or the program would do more with is not read", () => {
    for (const line of [
        `rg foo | grep bar`,
        `rg foo || true`,
        `rg foo; echo done`,
        `rg foo && echo found`,
        `rg "$PATTERN" src`,
        `rg $(cat pattern) src`,
        "rg `cat pattern`",
        `rg foo src/*.ts`,
        `rg -g *.ts foo`,
        `rg foo > out.txt`,
        `(rg foo)`,
        `FOO=1 rg foo`,
        `rg foo &`,
        `rg -v foo`,
        `rg --files foo`,
        `rg -f patterns.txt`,
        `rg -e a -e b`,
        `rg --some-new-flag foo`,
        `rg -r x foo`,
        `rg foo | head -n 5 file`,
        `grep -n foo src/a.ts`,
        `grep -rv foo .`,
        `grep -rc foo .`,
        `grep -rL foo .`,
        `egrep -r foo .`,
        `rg`,
        `rg 'unclosed`,
        `cd ~/x && rg foo`,
        `cd a b && rg foo`,
        `ls && rg foo`,
    ]) {
        expect(searchOf(line), line).toBeUndefined();
    }
});

test("only probes that could find something the search did not are planned", () => {
    const kinds = (line) => probesOf(searchOfWords(searchCommandOf(line, "/").words)).map((probe) => probe.kind);
    expect(kinds(`rg fooBar`)).toEqual(["case", "ignored"]);
    expect(kinds(`rg -i fooBar`)).toEqual(["ignored"]);
    expect(kinds(`rg 123`)).toEqual(["ignored"]);
    expect(kinds(`rg -uu 'a[0]'`)).toEqual(["case", "literal"]);
    expect(kinds(`rg -F 'a[0]'`)).toEqual(["case", "ignored"]);
    // A dot alone matches itself as a regex: plain text cannot find more.
    expect(kinds(`rg -i a.b`)).toEqual(["ignored"]);
    // grep -r already reads ignored and hidden files.
    expect(kinds(`grep -r 'Foo(' .`)).toEqual(["case", "literal"]);
});

test("the copy says and decides exactly what @intentic/text-search's probes do", () => {
    expect(RG_LABELS).toEqual(original.RG_LABELS);
    expect(PROBE_PRUNE_GLOBS).toEqual(original.PROBE_PRUNE_GLOBS);
    expect(PROBE_BUDGET_MS).toBe(original.PROBE_BUDGET_MS);
    expect(REGEX_SYNTAX.source).toBe(original.REGEX_SYNTAX.source);
    for (const pattern of ["foo", "FOO", "123", "_-.", "Ünïcode", "a\\d", "字"]) {
        expect(hasCase(pattern), pattern).toBe(original.hasCase(pattern));
    }
    const hits = [
        [],
        [{ kind: "case", files: 1, more: false, examples: ["a.ts"] }],
        [
            { kind: "case", files: 4, more: false, examples: ["a", "b", "c"] },
            { kind: "ignored", files: 3, more: true, examples: ["d", "e", "f"] },
            { kind: "literal", files: 3, more: false, examples: ["g", "h", "i"] },
        ],
    ];
    for (const set of hits) {
        expect(probeNote(set)).toBe(original.probeNote(set));
    }
    const labels = { case: "A", ignored: "B", literal: "C" };
    expect(probeNote(hits[2], labels)).toBe(original.probeNote(hits[2], labels));
});
