import { expect, test } from "vitest";
import { invalidExtensionFragment } from "./fragment-sources.js";

test("accepts a RUN/ENV-only fragment, comments and blank lines included", () => {
    const fragment = `# install the postgres client\nRUN apt-get update && apt-get install -y postgresql-client\nENV PGCLIENT=1\n`;
    expect(invalidExtensionFragment(fragment)).toBeUndefined();
});

test("accepts a line-continued RUN body", () => {
    const fragment = `RUN set -eux; \\\n    apt-get update; \\\n    apt-get install -y whisper\n`;
    expect(invalidExtensionFragment(fragment)).toBeUndefined();
});

test("rejects FROM (the daemon owns the base pin)", () => {
    expect(invalidExtensionFragment(`FROM ubuntu:24.04\nRUN echo hi`)).toBe(`FROM ubuntu:24.04`);
});

test("rejects a non-RUN/ENV instruction", () => {
    expect(invalidExtensionFragment(`RUN echo ok\nCOPY x /x`)).toBe(`COPY x /x`);
    expect(invalidExtensionFragment(`USER root`)).toBe(`USER root`);
});

test("rejects a privileged runtime directive, even hidden in a comment or a continued body", () => {
    expect(invalidExtensionFragment(`# intentic:runtime --privileged`)).toBe(`# intentic:runtime --privileged`);
    expect(invalidExtensionFragment(`RUN true \\\n    # intentic:runtime --cap-add=NET_ADMIN`)).toBe(`    # intentic:runtime --cap-add=NET_ADMIN`);
});
