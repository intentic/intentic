import { describe, expect, it } from "vitest";
import { createPaneRenderer } from "./pane-log-clean.js";

// Feed raw byte chunks through the emulator and return the rendered plain text.
const feed = async (...chunks: string[]): Promise<string> => {
    const renderer = createPaneRenderer({ cols: 200, rows: 50, scrollback: 1000 });
    for (const chunk of chunks) {
        await renderer.write(Buffer.from(chunk, "utf8"));
    }
    return renderer.render();
};

describe("createPaneRenderer", () => {
    it("resolves the zsh line-editor / autosuggestion cursor dance to the final command", async () => {
        // The exact escape run a real ls -la keystroke redraw emits: erase, cursor-right 168, cursor-left 168.
        const raw = "\x1b[0m# \x1b[K\x1b[168C\x1b[1m\x1b[0m\x1b[168D\x1b[?1h\x1b=\x1b[?2004hls -la\n";
        expect(await feed(raw)).toBe("# ls -la\n");
    });

    it("drops the ESC-k tmux tab-title string (ST-terminated) instead of leaking its text", async () => {
        expect(await feed("\x1bk~/work\x1b\\total 24\n")).toBe("total 24\n");
    });

    it("drops the ESC-k title string when BEL-terminated", async () => {
        expect(await feed("\x1bkls -la\x07total 24\n")).toBe("total 24\n");
    });

    it("renders a full prompt + command + output session as clean lines", async () => {
        const raw =
            "\x1bk~/work\x1b\\" + // tmux tab title — dropped
            "\x1b]7;file://host/work\x1b\\" + // OSC-7 cwd — consumed by xterm
            "\x1b[1m\x1b[31m╭─root@host\x1b[0m /work\r\n" +
            "╰─# \x1b[Kls -la\r\n" +
            "total 8\r\n" +
            "drwxr-xr-x 2 root root 4096 .\r\n";
        expect(await feed(raw)).toBe("╭─root@host /work\n╰─# ls -la\ntotal 8\ndrwxr-xr-x 2 root root 4096 .\n");
    });

    it("leaves no ESC, CR, or leaked title characters", async () => {
        const out = await feed(
            "\x1bkls -la\x1b\\\x1b[0m\x1b[27m\x1b[24m\x1b[J╭─\x1b[1m\x1b[31mroot@host\x1b[00m /work\r\n" +
                "╰─# \x1b[Kls -la\x1b[?2004h\r\n" +
                "total 24\r\n" +
                "# exit\r\nexit\r\n",
        );
        expect(out.includes("\x1b")).toBe(false);
        expect(out.includes("\r")).toBe(false);
        expect(out).not.toContain("kls"); // the ESC-k title text must not leak
        expect(out).toContain("root@host /work");
        expect(out).toContain("# ls -la");
        expect(out).toContain("total 24");
        expect(out).toContain("# exit");
    });

    it("strips a title string split across chunk boundaries", async () => {
        expect(await feed("\x1bk~/wo", "rk\x1b\\done\n")).toBe("done\n");
    });

    it("reassembles a CSI escape split across chunk boundaries", async () => {
        expect(await feed("\x1b[31mred", "\x1b[0m done\n")).toBe("red done\n");
    });

    it("renders nothing for an empty stream", async () => {
        expect(await feed("")).toBe("");
    });
});
