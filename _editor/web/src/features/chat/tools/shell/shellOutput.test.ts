import { lexShell } from "./shellLex";
import { readShell } from "./shellOutput";

const settled = { failed: false, exitCode: undefined };

describe(`lexShell`, () => {
    it(`keeps every character, so the coloured pieces join back into the line`, () => {
        const line = `cd /work && FOO=1 rg -n "a;b|c" 'x y' $HOME/src 2>&1 | head -5; echo $(date) # done`;
        expect(
            lexShell(line)
                .tokens.map((token) => token.text)
                .join(``),
        ).toBe(line);
    });

    it(`splits statements on separators outside quotes, and pipelines on pipes`, () => {
        const { statements } = lexShell(`git status --short | head; rg -n "a;b" src && echo ok`);
        expect(statements.map((statement) => statement.pipeline.map((command) => command.argv))).toEqual([
            [[`git`, `status`, `--short`], [`head`]],
            [[`rg`, `-n`, `a;b`, `src`]],
            [[`echo`, `ok`]],
        ]);
    });

    it(`colours the program, its flags, strings, variables and separators`, () => {
        const kinds = lexShell(`rg -n "x" $DIR && ls`)
            .tokens.filter((token) => token.kind !== `space`)
            .map((token) => [token.kind, token.text]);
        expect(kinds).toEqual([
            [`program`, `rg`],
            [`flag`, `-n`],
            [`string`, `"x"`],
            [`variable`, `$DIR`],
            [`separator`, `&&`],
            [`program`, `ls`],
        ]);
    });

    it(`leaves a redirect's target out of the arguments`, () => {
        const { statements } = lexShell(`pnpm test 2>&1 > out.log`);
        expect(statements[0]?.pipeline[0]?.argv).toEqual([`pnpm`, `test`]);
    });

    it(`marks a flag glued to a quoted value as a flag followed by a string`, () => {
        const tokens = lexShell(`git log -S'grant.role ==='`).tokens.filter((token) => token.kind !== `space`);
        expect(tokens.slice(2)).toEqual([
            { kind: `flag`, text: `-S` },
            { kind: `string`, text: `'grant.role ==='` },
        ]);
    });
});

describe(`readShell`, () => {
    it(`drops a leading cd from the row and keeps it as where the command ran`, () => {
        const reading = readShell(`cd /srv/shop && git status`, ``, settled);
        expect(reading.tokens.map((token) => token.text).join(``)).toBe(`git status`);
        expect(reading.cwd).toBe(`/srv/shop`);
    });

    it(`cuts reads separated by echo into file slices numbered from their real first line`, () => {
        const command = `cd /srv/shop && sed -n 125,127p src/a.test.ts; echo ----; head -n 2 src/b.ts`;
        const output = `const a = 1;\nconst b = 2;\nconst c = 3;\n----\nimport x;\nimport y;\n`;
        const { sections } = readShell(command, output, settled);
        expect(sections).toEqual([
            {
                kind: `code`,
                path: `src/a.test.ts`,
                open: `/srv/shop/src/a.test.ts`,
                code: `const a = 1;\nconst b = 2;\nconst c = 3;`,
                lang: `typescript`,
                firstLine: 125,
            },
            { kind: `code`, path: `src/b.ts`, open: `/srv/shop/src/b.ts`, code: `import x;\nimport y;`, lang: `typescript`, firstLine: 1 },
        ]);
    });

    it(`leaves output as one text section when a delimiter never printed`, () => {
        const { sections } = readShell(`cat a.ts && echo ---- && cat b.ts`, `boom: no such file`, settled);
        expect(sections).toEqual([{ kind: `text`, text: `boom: no such file`, lang: undefined }]);
    });

    it(`groups search hits by file and translates the pattern to mark them`, () => {
        const output = `src/a.ts:3:const memberRow = 1\nsrc/a.ts:9:members.grant(x)\nsrc/b.ts:1:members.set(y)\n`;
        const { sections } = readShell(`rg -n "memberRow|members\\.(grant|set)\\(" src`, output, settled);
        expect(sections).toHaveLength(1);
        const [section] = sections;
        expect(section?.kind).toBe(`matches`);
        if (section?.kind !== `matches`) {
            return;
        }
        expect(section.hits).toBe(3);
        expect(section.files.map((file) => [file.path, file.hits.map((hit) => hit.line)])).toEqual([
            [`src/a.ts`, [3, 9]],
            [`src/b.ts`, [1]],
        ]);
        expect(new RegExp(section.mark!.source, section.mark!.flags).test(`members.grant(`)).toBe(true);
    });

    it(`reads a single-file grep's lines, which carry no file name`, () => {
        const { sections } = readShell(`grep -n "foo" src/a.ts`, `4:foo()\n10:  foo(1)`, settled);
        expect(sections[0]).toMatchObject({ kind: `matches`, files: [{ path: `src/a.ts`, hits: [{ line: 4 }, { line: 10 }] }] });
    });

    it(`translates grep's basic regex, where a bare pipe is literal`, () => {
        const { sections } = readShell(`grep -rn "a\\|b" src`, `src/x.ts:1:a`, settled);
        const mark = sections[0]?.kind === `matches` ? sections[0].mark : undefined;
        expect(mark?.source).toBe(`a|b`);
    });

    it(`reads git status --short as entries, and git log lines as commits`, () => {
        const status = readShell(`git status --short | head`, ` M src/a.ts\n?? new.ts\nR  old.ts -> moved.ts\n`, settled).sections[0];
        expect(status).toMatchObject({ kind: `status`, entries: [{ code: ` M` }, { code: `??` }, { code: `R `, open: `moved.ts` }] });
        const log = readShell(
            `git log --format='%h %ad %s' --date=short`,
            `b826bdf 2026-10-20 fix(auth): members\n1a2b3c4 2026-10-19 feat: x`,
            settled,
        ).sections[0];
        expect(log).toEqual({
            kind: `log`,
            entries: [
                { hash: `b826bdf`, text: `2026-10-20 fix(auth): members` },
                { hash: `1a2b3c4`, text: `2026-10-19 feat: x` },
            ],
        });
    });

    it(`highlights a patch as a diff and whole JSON as JSON`, () => {
        expect(readShell(`git diff`, `diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b`, settled).sections[0]).toMatchObject({ lang: `diff` });
        expect(readShell(`curl -s localhost/api`, `{"ok": true}`, settled).sections[0]).toMatchObject({ lang: `json` });
        expect(readShell(`pnpm test`, `✓ 7 passed`, settled).sections[0]).toMatchObject({ kind: `text`, lang: undefined });
    });

    it(`takes Claude Code's exit line off a failed command's output`, () => {
        const reading = readShell(`pnpm test`, `Exit code 1\nFAIL a.test.ts`, { failed: true, exitCode: undefined });
        expect(reading.exitCode).toBe(1);
        expect(reading.sections).toEqual([{ kind: `text`, text: `FAIL a.test.ts`, lang: undefined }]);
    });

    it(`does not trust statements inside a here-document`, () => {
        const { sections } = readShell(`cat <<EOF > a.ts\nsed -n 1,2p b.ts\nEOF`, `x`, settled);
        expect(sections).toEqual([{ kind: `text`, text: `x`, lang: undefined }]);
    });
});
