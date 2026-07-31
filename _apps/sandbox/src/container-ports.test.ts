import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DAEMON_PORT, LOCAL_PORT, PREVIEW_PORT, TRANSLATOR_PORT } from "@intentic/constants";
import { expect, test } from "vitest";

/* NO TWO FIXED BINDS IN THIS CONTAINER MAY SHARE A PORT — and the Dockerfile does not get to pick one.
 *
 * The translator's port lived here as a bare literal inside `ENV TRANSLATOR_URL=http://127.0.0.1:8788`. It was
 * the only fixed bind in the container not declared in @intentic/constants, so when the loopback listener was
 * added and took the number one above the daemon's, nothing compared them: 8788 twice, in two files, in two
 * languages. The daemon boots first and wins the bind, so cli-proxy-api died on arrival on every sandbox —
 * exit 0, its reason on stdout, restarted forever — and every routed (Codex/Grok/Kimi/Gemini) turn had no
 * translator to reach. Both halves of that are checked below: the values are distinct, and the image's baked
 * ports are the declared ones rather than literals free to drift back into each other.
 */

const DOCKERFILE = join(import.meta.dirname, "..", "Dockerfile");

// Keyed by the name so a failure says WHICH pair collided, not just that two numbers matched.
const FIXED_PORTS = { DAEMON_PORT, PREVIEW_PORT, LOCAL_PORT, TRANSLATOR_PORT };

test("every fixed in-container port is distinct", () => {
    const byPort = new Map<number, string[]>();
    for (const [name, port] of Object.entries(FIXED_PORTS)) {
        byPort.set(port, [...(byPort.get(port) ?? []), name]);
    }
    expect([...byPort].filter(([, names]) => names.length > 1)).toEqual([]);
});

test("the image bakes the declared ports, not its own literals", async () => {
    const dockerfile = await readFile(DOCKERFILE, "utf8");

    expect(dockerfile).toContain(`SANDBOX_PORT=${DAEMON_PORT}`);
    expect(dockerfile).toContain(`TRANSLATOR_URL=http://127.0.0.1:${TRANSLATOR_PORT}`);
    // The tunnel connector dials the daemon over the container network; the loopback listener is published to
    // the host by the run contract (@intentic/sandbox-run), not by EXPOSE.
    expect(dockerfile).toMatch(new RegExp(`^EXPOSE .*\\b${DAEMON_PORT}\\b`, "m"));
});

// The discovery half: a FIFTH fixed bind, added to the image the way the translator's was, fails here without
// anyone remembering this test exists. Both forms the image states a port in — an `ENV *_PORT=` assignment and
// a loopback URL — must resolve to something declared. sshd's 22 is not matched by either: it is EXPOSEd and
// bound by the entrypoint, never named as a daemon-family port.
test("no port literal in the image is undeclared", async () => {
    const dockerfile = await readFile(DOCKERFILE, "utf8");
    const declared = new Set(Object.values(FIXED_PORTS));
    const found = [...dockerfile.matchAll(/(?:ENV\s+\w*PORT=|\/\/127\.0\.0\.1:)(\d+)/g)].map((match) => Number(match[1]));

    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((port) => !declared.has(port))).toEqual([]);
});
