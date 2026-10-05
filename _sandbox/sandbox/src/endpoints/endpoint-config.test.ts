import { unversionedBase, versionedBase } from "./endpoint-config.js";

/* Where a pasted base URL's version segment is, read the same way by every consumer. */

test("a base without a version gets /v1; one that names its version is taken as it is", () => {
    expect(versionedBase("http://host.docker.internal:11434")).toBe("http://host.docker.internal:11434/v1");
    expect(versionedBase("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(versionedBase("https://api.z.ai/api/coding/paas/v4")).toBe("https://api.z.ai/api/coding/paas/v4");
    // Google's OpenAI-compatible surface sits below a pre-release version: /v1 appended there is a 404.
    expect(versionedBase("https://generativelanguage.googleapis.com/v1beta/openai")).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(versionedBase("https://example.com/v1beta")).toBe("https://example.com/v1beta");
    // A segment that only starts like a version is not one.
    expect(versionedBase("https://example.com/v1/openaix")).toBe("https://example.com/v1/openaix/v1");
});

test("the Anthropic root drops only a trailing /vN", () => {
    expect(unversionedBase("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
    expect(unversionedBase("https://api.anthropic.com")).toBe("https://api.anthropic.com");
});
