import { heredocBodies } from "./shell-regions.js";

// The one heredoc scan the policy classifier and the daemon's command readers share, pinned by exact offset.

const bodiesOf = (command: string): string[] => heredocBodies(command).map(({ start, end }) => command.slice(start, end));

test("a body starts on the line after its opener, not at the newline, and ends where its terminator's line starts", () => {
    expect(heredocBodies("cat <<EOF\nx\nEOF")).toEqual([{ start: 10, end: 12 }]);
    const command = "cat > f <<'EOF'\nline one\nline two\nEOF\nls";
    expect(heredocBodies(command)).toEqual([{ start: command.indexOf("line one"), end: command.indexOf("EOF\nls") }]);
    expect(bodiesOf(command)).toEqual(["line one\nline two\n"]);
});

test("`<<` ends only at a terminator in the first column: an indented one is body, as bash reads it", () => {
    const command = "cat <<EOF\n  x\n  EOF\n\tEOF\nrm -rf /";
    expect(heredocBodies(command)).toEqual([{ start: 10, end: command.length }]);
});

test("`<<-` ends at a tab-indented terminator", () => {
    const command = "cat <<-EOF\n\tx\n\tEOF\nls";
    expect(heredocBodies(command)).toEqual([{ start: 11, end: 14 }]);
    expect(bodiesOf(command)).toEqual(["\tx\n"]);
});

test("the terminator is the whole word on its line, quoted delimiters included", () => {
    expect(bodiesOf("cat <<EOF\nEOFX\nxEOF\nEOF\nls")).toEqual(["EOFX\nxEOF\n"]);
    expect(bodiesOf(`cat <<'END'\n$HOME\nEND`)).toEqual(["$HOME\n"]);
    expect(bodiesOf(`cat <<"END"\n$HOME\nEND`)).toEqual(["$HOME\n"]);
});

test("an unterminated body runs to the end of the command, and an opener with no line after it has none", () => {
    expect(heredocBodies("cat <<'EOF'\nrm -rf /")).toEqual([{ start: 12, end: 20 }]);
    expect(heredocBodies("cat <<EOF")).toEqual([]);
});

test("every heredoc in the command is found, in order", () => {
    expect(bodiesOf("cat <<A >a\n1\nA\ncat <<-B >b\n\t2\n\tB\nls")).toEqual(["1\n", "\t2\n"]);
});
