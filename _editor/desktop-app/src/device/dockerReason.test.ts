import { dockerReasonOf } from "./dockerReason";

describe(`dockerReasonOf`, () => {
    it(`names the app's own sentence and the OS error, never Docker's words`, () => {
        expect(dockerReasonOf({ detail: `the docker command would not run: program not found (os error 2)` })).toEqual({ reason: `cliMissing`, osError: 2 });
        expect(
            dockerReasonOf({ detail: `C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe would not start: The requested operation requires elevation. (os error 740)` }),
        ).toEqual({ reason: `launchFailed`, osError: 740 });
        expect(dockerReasonOf({ detail: `permission denied while trying to connect to the docker API at npipe:////./pipe/docker_engine` })).toEqual({ reason: `denied` });
        expect(dockerReasonOf({ detail: `Docker's engine is up but did not answer within 20s` })).toEqual({ reason: `engineSilent` });
        expect(dockerReasonOf({ detail: `Docker Desktop is not installed where this app can find it.` })).toEqual({ reason: `notInstalled` });
        expect(dockerReasonOf({ detail: `something else entirely` })).toEqual({ reason: `other` });
        expect(dockerReasonOf({ detail: `` })).toEqual({ reason: `none` });
    });
});
