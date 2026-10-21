// THE AGENT'S HOUSE, built as the sandbox is: the picture on the page of a folder's own sandbox (AgentHouse.vue,
// setup/LocalSandboxSetup.vue) is drawn by its setup's real phases, never by a clock of its own. Each stage is something
// the setup has actually reached, so a page that shows a roof is a sandbox whose daemon is coming up, and one with the
// lights on is a sandbox that answers with the folder's link made; the folder's copy moving in is its own first copy.

export const HOUSE_STAGES = [
    // Nothing built yet: the plans drawn up (the installer fetched, Docker checked, the setup code redeemed).
    `plan`,
    // The ground laid and the materials brought in: the sandbox image, downloaded or found on this computer.
    `ground`,
    // The container started.
    `walls`,
    // The daemon coming up inside it.
    `roof`,
    // The sandbox answering, the folder's link to it made: lights on, and the lotus over the door.
    `lit`,
    // The folder's copy moving in.
    `moving`,
    // Moved in: the agent's at home.
    `home`,
] as const;

export type HouseStage = (typeof HOUSE_STAGES)[number];

// The setup's phase ids (the desktop app's setupPlan.ts, which `ic` and the scripts print; sandbox-contract's
// setup-progress.fixture.json lists them, and a test holds this table to it) to what they build. A phase
// this list does not know is narration under the stage already reached, never a step back.
export const STAGE_OF_PHASE: Readonly<Record<string, HouseStage>> = {
    "fetching-ic": `plan`,
    "checking-docker": `plan`,
    "installing-docker": `plan`,
    preflight: `plan`,
    "claiming-code": `plan`,
    "pulling-image": `ground`,
    "starting-sandbox": `walls`,
    "waiting-health": `roof`,
    // The folder's link comes right after the daemon answers (ic's connect.rs, 2026-10-21), and its first copy runs while
    // the public address is checked and this computer is connected, so those two are the folder moving in.
    "desktop-sync": `lit`,
    verifying: `moving`,
    "connecting-machine": `moving`,
};

/** The stage a setup's phase builds, or `plan` for one this list does not know (or none yet). */
const stageOfPhase = (phase: string | undefined): HouseStage => (phase === undefined ? undefined : STAGE_OF_PHASE[phase]) ?? `plan`;

/** The stage a build has reached: by its running phase, and `home` once it is ready, whatever phase it ended on. A
 * folder's setup that finished is its copy moving in until the folder is in (`copying`). */
export const houseStageOf = (build: { readonly state: string; readonly phase: string | undefined }): HouseStage => {
    if (build.state === `ready`) {
        return `home`;
    }
    return build.state === `copying` ? `moving` : stageOfPhase(build.phase);
};

/** Whether the house has reached `stage`: what each part of the drawing is shown by. */
export const reached = (current: HouseStage, stage: HouseStage): boolean => HOUSE_STAGES.indexOf(current) >= HOUSE_STAGES.indexOf(stage);

/** How many of the materials' blocks stand on the site, out of `of`, for a download `progress` (0..1) through. */
export const blocksStacked = (stage: HouseStage, progress: number, of: number): number => {
    if (stage === `plan`) {
        return 0;
    }
    if (stage !== `ground`) {
        return of;
    }
    const share = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
    // The first block lands as the step begins: a download that has not reported yet is still a site being supplied.
    return Math.max(1, Math.round(share * of));
};
