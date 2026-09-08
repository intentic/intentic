// Types for ci-infra-steps.mjs, the one list of runner-owned job steps the CI board and the audit script share.
export const INFRA_STEP: RegExp;
export function isInfraStep(name: string): boolean;
