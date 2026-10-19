import { terminalLine, terminalProgram } from "./acp-terminal.js";

test("a shell's script is the command the rulebook reads", () => {
    expect(terminalProgram({ command: "bash", args: ["-lc", "git push --force origin main"] })).toBe("git push --force origin main");
    expect(terminalProgram({ command: "/bin/sh", args: ["-c", "rm -rf build"] })).toBe("rm -rf build");
});

test("any other argv reads as one line", () => {
    expect(terminalProgram({ command: "git", args: ["status"] })).toBe("git status");
    expect(terminalProgram({ command: "bash", args: ["script.sh"] })).toBe("bash script.sh");
    expect(terminalProgram({ command: "ls" })).toBe("ls");
});

// F05: Devin sends its whole command line as `command`; quoted as one word, every command it ran exited 127.
test("a bare command is the agent's own shell line, run as written", () => {
    expect(terminalLine({ command: "cd /work/site && pnpm --filter @app_/landing run typecheck" })).toBe("cd /work/site && pnpm --filter @app_/landing run typecheck");
    expect(terminalLine({ command: "ls -la", args: [] })).toBe("ls -la");
});

test("an argv with arguments is quoted word by word", () => {
    expect(terminalLine({ command: "git", args: ["commit", "-m", "two words"] })).toBe("git commit -m 'two words'");
});
