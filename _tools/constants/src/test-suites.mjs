// A test file's run is named by its file name; each run's per-test budget is in ms.
export const INTEGRATION_MARKERS = ["integration", "e2e"];
export const SUITE_TIMEOUTS = { unit: 20_000, integration: 120_000 };
export const SUITE_KINDS = Object.keys(SUITE_TIMEOUTS);
export const INTEGRATION_NAME = new RegExp(`\\.(${INTEGRATION_MARKERS.join("|")})\\.(test|spec)\\.[cm]?[jt]sx?$`);
export const suiteKindOf = (file) => (INTEGRATION_NAME.test(file) ? "integration" : "unit");
// The env var naming the file where requires() (@intentic/testing/requires) records each test that stood down, for
// `suites` to count once the run ends.
export const STOOD_DOWN_FILE = "SUITES_STOOD_DOWN_FILE";
