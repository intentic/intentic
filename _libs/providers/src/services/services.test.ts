import type { Provider } from "@intentic/engine";
import { envLine, shellQuote } from "@intentic/sandbox-run/quote";
import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import { createInfisicalProvider } from "./infisical.js";
import { createInvoiceninjaProvider } from "./invoiceninja.js";
import { createOpenprojectProvider } from "./openproject.js";
import { createOutlineProvider } from "./outline.js";
import { createPaperlessProvider } from "./paperless.js";

const res = (stdout: string, code = 0, stderr = ""): SshResult => ({ stdout, stderr, code });

// Drives a compose-service provider entirely over SSH: docker ps reports the labelled container, the
// project inspect reports each service's image, the wget reports liveness, docker compose up can fail.
const fakeSsh = (
    opts: { running?: boolean; upFails?: boolean; healthy?: boolean; images?: Record<string, string>; writeFails?: boolean } = {},
): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            // Simulate an unwritable state dir (e.g. non-root user on root-owned /opt): the mkdir/cat writes exit non-zero.
            if (opts.writeFails && (command.startsWith("mkdir -p /opt/intentic") || command.startsWith("cat > /opt/intentic"))) {
                return res("", 1, "mkdir: cannot create directory '/opt/intentic': Permission denied");
            }
            if (command.includes("com.docker.compose.project")) {
                return res(
                    opts.running
                        ? Object.entries(opts.images ?? {})
                              .map(([service, image]) => `${service}=${image}`)
                              .join("\n")
                        : "",
                );
            }
            if (command.includes("docker ps")) {
                return res(opts.running ? "up" : "");
            }
            if (command.includes("wget")) {
                return res("", opts.healthy ? 0 : 1);
            }
            if (command.includes("docker compose")) {
                return res("up", opts.upFails ? 1 : 0);
            }
            return res("");
        },
        dispose: async () => {},
    };
    return { executor: { connect: async () => session }, commands };
};

const unreachable: SshExecutor = {
    connect: async () => {
        throw new Error("ECONNREFUSED");
    },
};

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "svc",
    output: () => {
        throw new Error("unused");
    },
});

const base = {
    server: "host",
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    internalIp: "10.0.0.5",
    adminUser: "intentic@example.com",
    adminPassword: "pw",
};

// One row per catalog service: its provider factory, the inputs the resolver feeds it, the deterministic
// outputs, the desired image-by-compose-service map, and the .env keys the write-once guard must carry.
const cases: {
    kind: string;
    make: (executor: SshExecutor) => Provider;
    inputs: Record<string, unknown>;
    outputs: Record<string, string>;
    images: Record<string, string>;
    envKeys: string[];
    extraFiles: string[];
}[] = [
    {
        kind: "paperless",
        make: createPaperlessProvider,
        inputs: { ...base, domain: "docs.example.com", paperlessImage: "paperless@sha256:aaaa", valkeyImage: "valkey@sha256:bbbb" },
        outputs: { url: "https://docs.example.com", internalUrl: "http://10.0.0.5:8000" },
        images: { broker: "valkey@sha256:bbbb", paperless: "paperless@sha256:aaaa" },
        envKeys: ["PAPERLESS_SECRET_KEY", "PAPERLESS_ADMIN_PASSWORD"],
        extraFiles: [],
    },
    {
        kind: "openproject",
        make: createOpenprojectProvider,
        inputs: { ...base, adminUser: "admin", domain: "pm.example.com", openprojectImage: "openproject@sha256:cccc" },
        outputs: { url: "https://pm.example.com", internalUrl: "http://10.0.0.5:8082" },
        images: { openproject: "openproject@sha256:cccc" },
        envKeys: ["OPENPROJECT_SECRET_KEY_BASE", "OPENPROJECT_SEED_ADMIN_USER_PASSWORD"],
        extraFiles: [],
    },
    {
        kind: "outline",
        make: createOutlineProvider,
        inputs: {
            ...base,
            domain: "wiki.example.com",
            authDomain: "auth.wiki.example.com",
            outlineImage: "outline@sha256:dddd",
            postgresImage: "postgres@sha256:eeee",
            valkeyImage: "valkey@sha256:bbbb",
            dexImage: "dex@sha256:ffff",
        },
        outputs: { url: "https://wiki.example.com", internalUrl: "http://10.0.0.5:3210" },
        images: { postgres: "postgres@sha256:eeee", redis: "valkey@sha256:bbbb", dex: "dex@sha256:ffff", outline: "outline@sha256:dddd" },
        envKeys: ["SECRET_KEY", "UTILS_SECRET", "POSTGRES_PASSWORD", "OIDC_CLIENT_SECRET"],
        extraFiles: ["dex-config.yaml"],
    },
    {
        kind: "invoiceninja",
        make: createInvoiceninjaProvider,
        inputs: {
            ...base,
            domain: "invoices.example.com",
            invoiceninjaImage: "invoiceninja@sha256:aaaa",
            mariadbImage: "mariadb@sha256:1111",
            valkeyImage: "valkey@sha256:bbbb",
        },
        outputs: { url: "https://invoices.example.com", internalUrl: "http://10.0.0.5:8083" },
        images: {
            mariadb: "mariadb@sha256:1111",
            redis: "valkey@sha256:bbbb",
            app: "invoiceninja@sha256:aaaa",
            worker: "invoiceninja@sha256:aaaa",
            scheduler: "invoiceninja@sha256:aaaa",
        },
        envKeys: ["APP_KEY", "DB_PASSWORD", "DB_ROOT_PASSWORD", "IN_PASSWORD"],
        extraFiles: [],
    },
    {
        kind: "infisical",
        make: createInfisicalProvider,
        inputs: {
            ...base,
            domain: "secrets.example.com",
            infisicalImage: "infisical@sha256:2222",
            postgresImage: "postgres@sha256:eeee",
            valkeyImage: "valkey@sha256:bbbb",
        },
        outputs: { url: "https://secrets.example.com", internalUrl: "http://10.0.0.5:8084" },
        images: { postgres: "postgres@sha256:eeee", redis: "valkey@sha256:bbbb", infisical: "infisical@sha256:2222" },
        envKeys: ["ENCRYPTION_KEY", "AUTH_SECRET", "POSTGRES_PASSWORD"],
        extraFiles: [],
    },
];

for (const svc of cases) {
    test(`${svc.kind}: read returns undefined when the host is unreachable / down / unhealthy`, async () => {
        expect(await svc.make(unreachable).read(svc.inputs, ctx())).toBeUndefined();
        expect(await svc.make(fakeSsh({ running: false }).executor).read(svc.inputs, ctx())).toBeUndefined();
        expect(await svc.make(fakeSsh({ running: true, healthy: false }).executor).read(svc.inputs, ctx())).toBeUndefined();
    });

    test(`${svc.kind}: read returns the deterministic url/internalUrl + observed images when running and healthy`, async () => {
        const provider = svc.make(fakeSsh({ running: true, healthy: true, images: svc.images }).executor);
        expect(await provider.read(svc.inputs, ctx())).toEqual({ outputs: svc.outputs, detail: { images: svc.images } });
    });

    test(`${svc.kind}: diff is noop on matching images, update on a pin bump`, () => {
        const provider = svc.make(fakeSsh().executor);
        expect(provider.diff(svc.inputs, { outputs: {}, detail: { images: svc.images } })).toEqual({ action: "noop" });
        const first = Object.keys(svc.images)[0]!;
        const bumped = { ...svc.images, [first]: "other@sha256:0000" };
        expect(provider.diff(svc.inputs, { outputs: {}, detail: { images: bumped } }).action).toBe("update");
    });

    test(`${svc.kind}: apply writes the pinned compose + write-once .env, brings the stack up, and returns outputs`, async () => {
        const ssh = fakeSsh({ healthy: true });
        expect(await svc.make(ssh.executor).apply(svc.inputs, undefined, ctx())).toEqual(svc.outputs);
        const compose = ssh.commands.find((c) => c.includes(`cat > /opt/intentic/${svc.kind}/compose.yaml`));
        expect(compose).toBeDefined();
        for (const image of Object.values(svc.images)) {
            expect(compose).toContain(image);
        }
        for (const file of svc.extraFiles) {
            expect(ssh.commands.some((c) => c.includes(`cat > /opt/intentic/${svc.kind}/${file}`))).toBe(true);
        }
        const env = ssh.commands.find((c) => c.includes(`test -f /opt/intentic/${svc.kind}/.env`));
        expect(env).toBeDefined();
        for (const key of svc.envKeys) {
            expect(env).toContain(key);
        }
        expect(ssh.commands.some((c) => c.includes(`docker compose -p ${svc.kind}`) && c.includes("up -d"))).toBe(true);
    });

    test(`${svc.kind}: apply throws when docker compose up exits non-zero`, async () => {
        const ssh = fakeSsh({ upFails: true });
        await expect(svc.make(ssh.executor).apply(svc.inputs, undefined, ctx())).rejects.toThrow(new RegExp(`failed to bring up ${svc.kind}`));
    });

    test(`${svc.kind}: apply surfaces a failed state-dir write at its origin, before ever reaching docker compose`, async () => {
        const ssh = fakeSsh({ writeFails: true });
        await expect(svc.make(ssh.executor).apply(svc.inputs, undefined, ctx())).rejects.toThrow(
            new RegExp(`${svc.kind}: create /opt/intentic/${svc.kind} failed \\(exit 1\\): mkdir: cannot create`),
        );
        // The real error must not be masked as "compose.yaml: no such file" — we never reach `up -d`.
        expect(ssh.commands.some((c) => c.includes("docker compose") && c.includes("up -d"))).toBe(false);
    });

    test(`${svc.kind}: delete tears the stack down and removes the state dir`, async () => {
        const ssh = fakeSsh();
        await svc.make(ssh.executor).delete?.(svc.inputs, ctx());
        expect(ssh.commands.some((c) => c.includes(`docker compose -p ${svc.kind}`) && c.includes("down -v"))).toBe(true);
        expect(ssh.commands.some((c) => c.includes(`rm -rf /opt/intentic/${svc.kind}`))).toBe(true);
    });

    test(`${svc.kind}: malformed inputs are rejected`, async () => {
        await expect(svc.make(fakeSsh().executor).read({ ...svc.inputs, internalIp: 5 }, ctx())).rejects.toThrow(
            new RegExp(`${svc.kind} inputs malformed`),
        );
    });
}

test("outline: the dex config wires the auth domain, the outline callback, the env-fed client secret, and an inlined password hash", async () => {
    const svc = cases[2]!;
    const ssh = fakeSsh({ healthy: true });
    await svc.make(ssh.executor).apply(svc.inputs, undefined, ctx());
    const dex = ssh.commands.find((c) => c.includes("cat > /opt/intentic/outline/dex-config.yaml"));
    expect(dex).toContain("issuer: https://auth.wiki.example.com");
    expect(dex).toContain("https://wiki.example.com/auth/oidc.callback");
    expect(dex).toContain("secretEnv: OIDC_CLIENT_SECRET");
    expect(dex).toContain("email: intentic@example.com");
    // The admin password's bcrypt hash is inlined into the (per-apply) dex config, not routed through .env,
    // so it always matches the current password and no compose ${…} round-trip can mangle its `$`.
    expect(dex).toMatch(/hash: "\$2[aby]\$/);
    expect(dex).not.toContain('"pw"'); // the plaintext never lands in a file
    const env = ssh.commands.find((c) => c.includes("test -f /opt/intentic/outline/.env"));
    expect(env).not.toContain("DEX_ADMIN_PASSWORD_HASH");
    // dex is force-recreated after the stack is healthy so it reloads the freshly-written config.
    expect(ssh.commands.some((c) => c.includes("up -d --force-recreate dex"))).toBe(true);
});

test("invoiceninja: the .env carries a Laravel base64: APP_KEY and the admin seed identity", async () => {
    const svc = cases[3]!;
    const ssh = fakeSsh({ healthy: true });
    await svc.make(ssh.executor).apply(svc.inputs, undefined, ctx());
    const env = ssh.commands.find((c) => c.includes("test -f /opt/intentic/invoiceninja/.env"));
    // Derived from the quoters rather than transcribed: a known value's line is exactly what envLine renders,
    // carried as one shell word. Pinning the emitted escapes instead is what made these assertions outlive the
    // format they described.
    expect(env).toContain(shellQuote(envLine("IN_PASSWORD", "pw")));
    // APP_KEY's value is minted per apply, so only its shape is knowable here.
    expect(env).toContain("APP_KEY");
    expect(env).toMatch(/base64:[A-Za-z0-9+/=]+/);
    const compose = ssh.commands.find((c) => c.includes("cat > /opt/intentic/invoiceninja/compose.yaml"));
    expect(compose).toContain("IN_USER_EMAIL: intentic@example.com");
});

test("infisical: apply bootstraps the instance admin via the one-shot API and tolerates non-200", async () => {
    const svc = cases[4]!;
    const logs: string[] = [];
    const ssh = fakeSsh({ healthy: true });
    await svc.make(ssh.executor).apply(
        svc.inputs,
        undefined,
        ctx((message) => logs.push(message)),
    );
    const seed = ssh.commands.find((c) => c.includes("/api/v1/admin/bootstrap"));
    expect(seed).toContain("http://10.0.0.5:8084/api/v1/admin/bootstrap");
    expect(seed).toContain('"email":"intentic@example.com"');
    // The fake answers the curl with no status — the seed logs and the apply still succeeds.
    expect(logs.some((message) => message.includes("bootstrap returned"))).toBe(true);
});
