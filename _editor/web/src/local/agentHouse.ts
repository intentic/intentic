// THE AGENT'S HOUSE, built as the sandbox is: the picture on the card of this computer's sandbox (AgentHouse.vue,
// LocalMachineCard.vue) is drawn by its setup's real phases, never by a clock of its own. Each stage is something the
// setup has actually reached, so a card that shows a roof is a sandbox whose daemon is coming up, and one with the
// lights on is a sandbox that answers; a folder's copy moving in is the folder's own first copy.

export const HOUSE_STAGES = [
    // Nothing built yet: the plans drawn up (the installer fetched, Docker checked, the setup code redeemed).
    `plan`,
    // The ground laid and the materials brought in: the sandbox image, downloaded or found on this computer.
    `ground`,
    // The container started.
    `walls`,
    // The daemon coming up inside it.
    `roof`,
    // The sandbox answering, end to end: lights on, and the lotus over the door.
    `lit`,
    // The folder's copy moving in.
    `moving`,
    // Moved in: the agent's at home.
    `home`,
] as const;

export type HouseStage = (typeof HOUSE_STAGES)[number];

// The setup's phase ids (the desktop app's setupPlan.ts, which `ic` and the scripts print) to what they build. A phase
// this list does not know is narration under the stage already reached, never a step back.
const STAGE_OF_PHASE: Readonly<Record<string, HouseStage>> = {
    "fetching-ic": `plan`,
    "checking-docker": `plan`,
    "installing-docker": `plan`,
    preflight: `plan`,
    "claiming-code": `plan`,
    "pulling-image": `ground`,
    "starting-sandbox": `walls`,
    "waiting-health": `roof`,
    verifying: `lit`,
    "desktop-sync": `moving`,
    // The device's own connection runs once the folder is in: the house is lived in from here.
    "connecting-machine": `home`,
};

/** The stage a setup's phase builds, or `plan` for one this list does not know (or none yet). */
export const stageOfPhase = (phase: string | undefined): HouseStage => (phase === undefined ? undefined : STAGE_OF_PHASE[phase]) ?? `plan`;

/** The stage a build has reached: by its running phase, and `home` once it is ready, whatever phase it ended on. */
export const houseStageOf = (build: { readonly state: string; readonly phase: string | undefined }): HouseStage =>
    build.state === `ready` ? `home` : stageOfPhase(build.phase);

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
