import { isJailedDefaultCommand, jailedDefaultCommand, shellJailFiles, unjailedSessions } from "./shell-jail.js";

// The rules of a person's shell in the jail, without a tmux server: which line starts which shell, and which sessions a
// sweep ends. The line itself is run by bash in shell-jail.integration.test.ts.

const files = shellJailFiles("/run/intentic/shell-jail");

test("the line keeps a daemon session's shell, marks a person's pane, and starts its shell inside the sandbox", () => {
    const line = jailedDefaultCommand("zsh", files);
    expect(line).toBe(
        [
            ": intentic-shell-jail;",
            `case "$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null)" in panel-*|job-*|agent-*|svc-*|intentic-server-pin) exec zsh;; esac;`,
            `tmux set-option -p -t "$TMUX_PANE" @intentic_jail 1 2>/dev/null;`,
            `exec /usr/bin/bwrap --args 3 --chdir "$PWD" -- zsh 3</run/intentic/shell-jail/args`,
        ].join(" "),
    );
    expect(isJailedDefaultCommand(line)).toBe(true);
    expect(isJailedDefaultCommand("zsh")).toBe(false);
});

test("an empty default-command stands for tmux's own: the default shell as a login shell", () => {
    expect(jailedDefaultCommand("", files)).toContain(`-- "$SHELL" -l 3<`);
});

test("a sweep ends a person's session made before the jail with a shell outside it, and nothing else", () => {
    const armedAt = 1_000;
    const listing = [
        "web-old\t900\t",
        "web-old\t900\t1",
        "web-new\t1000\t",
        "web-jailed\t900\t1",
        "panel-site\t100\t",
        "job-push\t100\t",
        "agent-abc\t100\t",
        "svc-api\t100\t",
        "intentic-server-pin\t100\t",
        "",
    ].join("\n");
    expect(unjailedSessions(listing, armedAt)).toEqual(["web-old"]);
});
