import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { DAEMON_PORT, LOCAL_PORT, PREVIEW_PORT, TRANSLATOR_PORT } from "@intentic/constants";
import { expect, test } from "vitest";

// No two fixed in-container binds may share a port; declared ports (@intentic/constants) must be the single source, not
// a literal in the Dockerfile.

const DOCKERFILE = join(packageRoot(import.meta.url), "Dockerfile");

// Keyed by name so a failure says which pair collided, not just that two numbers matched.
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
    // Only the daemon needs EXPOSE; the loopback listener is published to the host by the run contract, not EXPOSE.
    expect(dockerfile).toMatch(new RegExp(`^EXPOSE .*\\b${DAEMON_PORT}\\b`, "m"));
});

// Catches a fifth fixed bind added like the translator's was: an ENV *_PORT= assignment or a loopback URL must resolve
// to a declared port. sshd's 22 matches neither form.
test("no port literal in the image is undeclared", async () => {
    const dockerfile = await readFile(DOCKERFILE, "utf8");
    const declared = new Set(Object.values(FIXED_PORTS));
    const found = [...dockerfile.matchAll(/(?:ENV\s+\w*PORT=|\/\/127\.0\.0\.1:)(\d+)/g)].map((match) => Number(match[1]));

    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((port) => !declared.has(port))).toEqual([]);
});
