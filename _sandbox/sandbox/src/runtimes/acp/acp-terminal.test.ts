import { terminalProgram } from "./acp-terminal.js";

test("a shell's script is the command the rulebook reads", () => {
    expect(terminalProgram({ command: "bash", args: ["-lc", "git push --force origin main"] })).toBe("git push --force origin main");
    expect(terminalProgram({ command: "/bin/sh", args: ["-c", "rm -rf build"] })).toBe("rm -rf build");
});

test("any other argv reads as one line", () => {
    expect(terminalProgram({ command: "git", args: ["status"] })).toBe("git status");
    expect(terminalProgram({ command: "bash", args: ["script.sh"] })).toBe("bash script.sh");
    expect(terminalProgram({ command: "ls" })).toBe("ls");
});
