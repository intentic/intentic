import { dockerEnding, dockerEndingLine } from "./dockerWords";

// What a start of the engine came to, in the Docker card's words, which a folder window's card is answered with too. No
// catalog is registered here, so each message reads back as its own key: what is asserted is which message is said.

const DOCKER = { ours: false, windows: false };
const ON_WINDOWS = { ours: false, windows: true };
const OURS = { ours: true, windows: true };

it(`names each ending of a Docker Desktop start, and what is left to do about it`, () => {
    expect([
        dockerEnding(`notInstalled`, DOCKER),
        dockerEnding(`wouldNotStart`, DOCKER),
        dockerEnding(`notAllowed`, ON_WINDOWS),
        dockerEnding(`notAllowed`, DOCKER),
        dockerEnding(`tookTooLong`, DOCKER),
        dockerEnding(`broken`, DOCKER),
        dockerEnding(undefined, DOCKER),
    ]).toEqual([
        { heading: `desktop.docker.dockerIsntOnThisComputer`, body: `desktop.docker.nothingToStartUntilInstalled` },
        { heading: `desktop.docker.dockerWouldntStart`, body: `desktop.docker.tryOpeningItYourself` },
        // Windows hands out the permission at a new sign-in; elsewhere it is a group.
        { heading: `desktop.docker.accountNotAllowedWindows`, body: `desktop.docker.signOutAndBackIn` },
        { heading: `desktop.docker.accountNotAllowed`, body: `desktop.docker.addToDockerGroup` },
        { heading: `desktop.docker.dockerHasntFinishedStarting`, body: `desktop.docker.mayBeWaitingForYou` },
        { heading: `desktop.docker.engineIsBroken`, body: `desktop.docker.quitAndOpenAgain` },
        { heading: `desktop.docker.dockerIsntRunning`, body: `desktop.docker.tryOpeningItYourself` },
    ]);
});

it(`names Intentic's own engine by its own name, with nothing about a Docker Desktop window`, () => {
    expect([dockerEnding(`wouldNotStart`, OURS), dockerEnding(`tookTooLong`, OURS), dockerEnding(`broken`, OURS), dockerEnding(`notAllowed`, OURS)]).toEqual([
        { heading: `desktop.docker.oursWouldntStart`, body: `desktop.docker.oursCheckAgain` },
        { heading: `desktop.docker.oursTakingLong`, body: `desktop.docker.oursCheckAgain` },
        { heading: `desktop.docker.oursBroken`, body: `desktop.docker.oursRestartComputer` },
        { heading: `desktop.docker.oursIsntRunning`, body: `desktop.docker.oursCheckAgain` },
    ]);
});

it(`says the ending as one line where there is no card to put it on`, () => {
    expect(dockerEndingLine(`wouldNotStart`, DOCKER)).toBe(`desktop.docker.dockerWouldntStart. desktop.docker.tryOpeningItYourself`);
});
