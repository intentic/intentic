import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelDevinLogin, startDevinLogin } from "./devin-login.js";

// Devin's CLI opens its page with `xdg-open` and never reads BROWSER, and a published image carries no xdg-open: there it
// printed no address and waited, and Connect failed with "did not offer a sign-in page in time". The stand-in answers
// the menu as the CLI does and opens its page with BROWSER cleared, so only an opener on its PATH can catch the page.
test("a browser sign-in catches the page the CLI opens through xdg-open, wherever BROWSER goes unread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devin-login-test-"));
    const cli = join(dir, "devin");
    const page = "https://app.devin.ai/auth/cli/continue?redirect_uri=http%3A%2F%2F127.0.0.1%3A45267%2Fcallback&state=s1&code_challenge=c1";
    await writeFile(cli, `#!/bin/sh\nprintf 'How would you like to log in?\\n'\nread -r _\nenv -u BROWSER xdg-open '${page}' || exit 3\nsleep 60\n`);
    await chmod(cli, 0o755);
    try {
        const started = await startDevinLogin(cli, "browser");
        expect(started.url).toBe(page);
        expect(started.landing).toEqual({ host: "127.0.0.1", port: 45267, path: "/callback", state: "s1" });
        cancelDevinLogin(started.handshake);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}, 20_000);
