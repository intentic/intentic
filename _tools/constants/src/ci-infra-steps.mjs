// The steps of a CI job the runner owns, not the repository: a failure in one says the fleet died before any step of
// the checkout ran, so it is nothing an agent on the code can fix. One list, read by the daemon's CI board and by
// _tools/scripts/ci/ci-audit.mjs.
export const INFRA_STEP = /^(Set up job|Set up runner|Initialize containers|Stop containers|Complete job|Post .*)$/;

export const isInfraStep = (name) => INFRA_STEP.test(name);
