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

    // Rust words an io::Error in the OS's language and always appends its number: the number is what is read.
    it(`reads a refusal by the OS's error number, in whatever language the OS worded it`, () => {
        const polish = `C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe would not start: Odmowa dostępu. (os error 5)`;
        expect(dockerReasonOf({ detail: polish }, true)).toEqual({ reason: `denied`, osError: 5 });
        expect(dockerReasonOf({ detail: `Docker Desktop would not start: Brak dostępu (os error 13)` }, false)).toEqual({ reason: `denied`, osError: 13 });
        // The same numbers mean something else on the other side: EIO on Unix, ERROR_INVALID_DATA on Windows.
        expect(dockerReasonOf({ detail: `Docker Desktop would not start: Błąd wejścia/wyjścia (os error 5)` }, false)).toEqual({ reason: `launchFailed`, osError: 5 });
        expect(dockerReasonOf({ detail: `Docker Desktop.exe would not start: Dane są nieprawidłowe. (os error 13)` }, true)).toEqual({ reason: `launchFailed`, osError: 13 });
        // A number-less refusal is still read by its words.
        expect(dockerReasonOf({ detail: `Docker Desktop.exe would not start: Access is denied.` }, true)).toEqual({ reason: `denied` });
    });
});
