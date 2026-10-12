import { version } from "../../version.js";
import { buildInfo, buildText, resetBuildInfo } from "./build-info.js";

afterEach(() => resetBuildInfo());

test("the commit comes from the image's environment, a blank one counting as none", () => {
    expect(buildInfo({ INTENTIC_COMMIT: " 0123456789abcdef0123 ", SOURCE_COMMIT: "fedcba" })).toMatchObject({ version, commit: "0123456789abcdef0123" });
    resetBuildInfo();
    expect(buildInfo({ INTENTIC_COMMIT: "", SOURCE_COMMIT: "fedcba" })).toMatchObject({ commit: "fedcba" });
});

test("without a stamp the build still names its version and when it was compiled", () => {
    const build = buildInfo({});
    expect(build.version).toBe(version);
    expect(Number.isFinite(Date.parse(build.builtAt ?? ""))).toBe(true);
    expect(buildText({ version: "0.0.0", commit: "0123456789abcdef" })).toBe("0.0.0 (commit 0123456789ab)");
    expect(buildText({ version: "1.2.3" })).toBe("1.2.3");
});
