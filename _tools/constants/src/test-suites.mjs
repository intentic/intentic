// A test file's run is named by its file name; each run's per-test budget is in ms.
export const INTEGRATION_MARKERS = ["integration", "e2e"];
// Manual suites: a `*.eval.test.*` file drives a real model and spends real allowance, so no gate, turn-end check or
// plain `suites` call ever runs it. Only `suites --manual <filter>` does, and only the manual files its filters name.
export const MANUAL_MARKERS = ["eval"];
export const SUITE_TIMEOUTS = { unit: 20_000, integration: 120_000, eval: 1_800_000 };
// The kinds every `suites` call runs, each as a run of its own.
export const SUITE_KINDS = ["unit", "integration"];
export const INTEGRATION_NAME = new RegExp(`\\.(${INTEGRATION_MARKERS.join("|")})\\.(test|spec)\\.[cm]?[jt]sx?$`);
export const MANUAL_NAME = new RegExp(`\\.(${MANUAL_MARKERS.join("|")})\\.(test|spec)\\.[cm]?[jt]sx?$`);
export const suiteKindOf = (file) => (MANUAL_NAME.test(file) ? "eval" : INTEGRATION_NAME.test(file) ? "integration" : "unit");
// The env var naming the file where requires() (@intentic/testing/requires) records each test that stood down, for
// `suites` to count once the run ends.
export const STOOD_DOWN_FILE = "SUITES_STOOD_DOWN_FILE";
// The env var a CI job sets to the lane it is: the job that provides what a `requires(…, { lane })` test needs, where
// that test then fails if the need goes missing (the workflow-policy check holds each lane to a job that runs it).
export const CI_LANE = "INTENTIC_CI_LANE";
