import { guardSelfMatch, selfKillRefusal } from "./self-kill-guard.js";

// What each guarded pattern will match with, as source text and flags.
const patterns = (command: string): { source: string; flags: string; kills: boolean; written: string }[] =>
    guardSelfMatch(command).matches.map((match) => ({ source: match.pattern.source, flags: match.pattern.flags, kills: match.kills, written: match.written }));

test("brackets the first character of a full-line pattern, in whatever quoting it came in", () => {
    expect(guardSelfMatch("pkill -f vite").command).toBe(String.raw`pkill -f \[v]ite`);
    expect(guardSelfMatch("pkill -f 'vite dev'").command).toBe("pkill -f '[v]ite dev'");
    expect(guardSelfMatch('pkill -f "node dist/main.js" || true').command).toBe('pkill -f "[n]ode dist/main.js" || true');
    expect(patterns("pkill -f vite")).toEqual([{ source: "[v]ite", flags: "u", kills: true, written: "vite" }]);
});

test("finds the pattern past signals, flag clusters and options that take a value", () => {
    expect(guardSelfMatch("pkill -9 -f vite").command).toBe(String.raw`pkill -9 -f \[v]ite`);
    expect(guardSelfMatch("pkill -KILL -u root -f next-server").command).toBe(String.raw`pkill -KILL -u root -f \[n]ext-server`);
    expect(guardSelfMatch("pkill --signal TERM --full vite").command).toBe(String.raw`pkill --signal TERM --full \[v]ite`);
    expect(guardSelfMatch("pkill -fu1000 -- vite").command).toBe(String.raw`pkill -fu1000 -- \[v]ite`);
    expect(patterns("sudo pkill -fi Vite")).toEqual([{ source: "[V]ite", flags: "iu", kills: true, written: "Vite" }]);
});

test("rewrites every invocation in command position, and pgrep without counting it as a kill", () => {
    expect(guardSelfMatch("cd /work && pkill -f vite; sleep 1; pgrep -fa esbuild || echo gone").command).toBe(
        String.raw`cd /work && pkill -f \[v]ite; sleep 1; pgrep -fa \[e]sbuild || echo gone`,
    );
    expect(patterns("pgrep -f esbuild")).toEqual([{ source: "[e]sbuild", flags: "u", kills: false, written: "esbuild" }]);
});

test("leaves a name-only match, a mention, and a heredoc body exactly as written", () => {
    for (const command of [
        "pkill vite",
        'echo "run pkill -f vite to stop it"',
        "git commit -m 'stop: pkill -f vite'",
        "cat > stop.sh <<'EOF'\npkill -f vite\nEOF",
    ]) {
        expect(guardSelfMatch(command)).toEqual({ command, matches: [] });
    }
});

test("a pattern it cannot bracket is still returned, for the caller to test against the whole line", () => {
    expect(guardSelfMatch("pkill -f '.*vite'").command).toBe("pkill -f '.*vite'");
    expect(patterns("pkill -f '.*vite'")).toEqual([{ source: ".*vite", flags: "u", kills: true, written: ".*vite" }]);
    // Not a pattern this runtime reads: still bracketed, which needs only its first character, but nothing to test with.
    expect(guardSelfMatch("pkill -f 'a(b'")).toEqual({ command: "pkill -f '[a](b'", matches: [] });
});

test("the refusal names the pattern and the form that cannot match itself", () => {
    const [match] = guardSelfMatch("pkill -f vite").matches;
    expect(match === undefined ? "" : selfKillRefusal(match)).toContain("pkill -f 'vite' would kill this Bash call's own shell");
    expect(match === undefined ? "" : selfKillRefusal(match)).toContain("pkill -f '[v]ite'");
});
