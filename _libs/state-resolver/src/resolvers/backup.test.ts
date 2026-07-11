import { env } from "@intentic/graph";
import type { BackupInput, HostInput } from "@intentic/need-resolver";
import { expect, test } from "vitest";
import { backupId, forgejoId, komodoId } from "../lib/ids.js";
import { IMAGES } from "../lib/images.js";
import { resolveBackup } from "./backup.js";

const host: HostInput = { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") };
const base: BackupInput = { repo: "s3:s3.example.com/bucket", password: env("RESTIC_PASSWORD") };

test("emits one backup node depending on forgejo + komodo, with the pinned image and a secret password", () => {
    const node = resolveBackup("host", host, base, undefined, [forgejoId("host"), komodoId("host")]);
    expect(node.id).toBe(backupId("host"));
    expect(node.type).toBe("backup");
    expect(node.explicitDependsOn).toEqual([forgejoId("host"), komodoId("host")]);
    expect(node.inputs["repo"]).toBe("s3:s3.example.com/bucket");
    expect(node.inputs["password"]).toEqual(env("RESTIC_PASSWORD"));
    expect(node.inputs["image"]).toBe(IMAGES.backup);
    expect(node.inputs["signoz"]).toBe(false);
});

test("includes credentials, schedule, and retention only when provided", () => {
    const bare = resolveBackup("host", host, base, undefined, [forgejoId("host"), komodoId("host")]);
    expect(bare.inputs["credentials"]).toBeUndefined();
    expect(bare.inputs["schedule"]).toBeUndefined();
    expect(bare.inputs["retention"]).toBeUndefined();

    const full = resolveBackup(
        "host",
        host,
        { ...base, credentials: { AWS_ACCESS_KEY_ID: env("AWS_ACCESS_KEY_ID") }, schedule: "0 5 * * *", retention: { daily: 14 } },
        undefined,
        [forgejoId("host"), komodoId("host")],
    );
    expect(full.inputs["credentials"]).toEqual({ AWS_ACCESS_KEY_ID: env("AWS_ACCESS_KEY_ID") });
    expect(full.inputs["schedule"]).toBe("0 5 * * *");
    expect(full.inputs["retention"]).toEqual({ daily: 14 });
});

test("opts SignOz in (flag + service) → signoz true and a dependency on the service", () => {
    const node = resolveBackup("host", host, { ...base, signoz: true }, "obs", [forgejoId("host"), komodoId("host")]);
    expect(node.inputs["signoz"]).toBe(true);
    expect(node.explicitDependsOn).toEqual([forgejoId("host"), komodoId("host"), "obs"]);
});

test("signoz:true with no declared SignOz service stays false (nothing to back up) and adds no dep", () => {
    const node = resolveBackup("host", host, { ...base, signoz: true }, undefined, [forgejoId("host"), komodoId("host")]);
    expect(node.inputs["signoz"]).toBe(false);
    expect(node.explicitDependsOn).toEqual([forgejoId("host"), komodoId("host")]);
});
