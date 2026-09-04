import { describe, expect, it } from "vitest";
import { BUILD_ENV, BUILD_PATHS, buildScript, dockerConfigJson, LOG_TAIL_BYTES, REPORT_HEADERS } from "./hosted-build-script.js";

/* THE SCRIPT'S PROMISES, pinned as text: the brakes it carries are the ones the platform cannot enforce from
 * outside once the builder is running. A build under `timeout`, a push to the image the platform named, the
 * cache beside it, and exactly one report, with the exit code in the header the route reads. */
describe(`the builder script`, () => {
    const script = buildScript();

    it(`is busybox sh with no bash, curl or jq in it`, () => {
        expect(script.startsWith(`#!/bin/sh\n`)).toBe(true);
        expect(script).not.toMatch(/\bbash\b|\bcurl\b|\bjq\b/);
    });

    it(`builds under the platform's timeout, from the Dockerfile the platform wrote, to the image it named`, () => {
        expect(script).toContain(`timeout "$${BUILD_ENV.timeoutSeconds}" buildctl`);
        expect(script).toContain(`--local context=${BUILD_PATHS.context}`);
        expect(script).toContain(`--local dockerfile=${BUILD_PATHS.context}`);
        expect(script).toContain(`type=image,name=$${BUILD_ENV.image},push=true`);
        expect(script).toContain(`--export-cache "type=registry,ref=$${BUILD_ENV.cache},mode=min"`);
        expect(script).toContain(`--import-cache "type=registry,ref=$${BUILD_ENV.cache}"`);
        expect(script).toContain(`--metadata-file ${BUILD_PATHS.metadata}`);
    });

    it(`starts buildkitd with no entitlements`, () => {
        expect(script).toContain(`buildkitd --addr unix:///run/buildkit/buildkitd.sock`);
        expect(script).not.toContain(`--allow-insecure-entitlement`);
        expect(script).not.toContain(`--oci-worker-net=host`);
    });

    it(`reports once, with the secret, exit code and digest in the headers the route reads and the log tail as the body`, () => {
        expect(script).toContain(`--header "${REPORT_HEADERS.secret}: $${BUILD_ENV.secret}"`);
        expect(script).toContain(`--header "${REPORT_HEADERS.exitCode}: $1"`);
        expect(script).toContain(`--header "${REPORT_HEADERS.digest}: $DIGEST"`);
        expect(script).toContain(`--post-file=/build/log.tail "$${BUILD_ENV.reportUrl}"`);
        expect(script).toContain(`tail -c ${LOG_TAIL_BYTES} ${BUILD_PATHS.log}`);
        // The digest comes out of buildkit's metadata file, the one place the pushed image's identity is written.
        expect(script).toContain(`containerimage.digest`);
    });

    it(`exits with the build's own code, so Fly's exit event agrees with the report`, () => {
        expect(script).toContain(`echo $? > /build/rc`);
        expect(script.trimEnd().endsWith(`exit "$RC"`)).toBe(true);
    });
});

describe(`the registry login`, () => {
    it(`is docker's config shape with Fly's fixed username and the token as the password`, () => {
        const parsed = JSON.parse(dockerConfigJson(`registry.fly.io`, `tok-123`)) as { auths: Record<string, { auth: string }> };
        expect(Buffer.from(parsed.auths[`registry.fly.io`]!.auth, `base64`).toString(`utf8`)).toBe(`x:tok-123`);
    });
});
