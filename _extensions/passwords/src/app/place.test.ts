import { parsePlace } from "./place.js";

// What a person types into "Works on", read as the place it is.
describe(`parsePlace`, () => {
    it(`reads sites, programs, ssh targets, git hosts and sudo`, () => {
        expect(parsePlace(`github.com`)).toEqual({ kind: `site`, host: `github.com` });
        expect(parsePlace(` https://www.gitlab.example.com/users/sign_in `)).toEqual({ kind: `site`, host: `gitlab.example.com` });
        expect(parsePlace(`FortiClient.exe`)).toEqual({ kind: `program`, program: `FortiClient.exe` });
        expect(parsePlace(`FortiClient`)).toEqual({ kind: `program`, program: `FortiClient` });
        expect(parsePlace(`C:\\Program Files\\Fortinet\\FortiClient.exe`)).toEqual({ kind: `program`, program: `C:\\Program Files\\Fortinet\\FortiClient.exe` });
        expect(parsePlace(`ssh radar@build-01`)).toEqual({ kind: `ssh`, target: `radar@build-01` });
        expect(parsePlace(`git github.com`)).toEqual({ kind: `git`, url: `https://github.com` });
        expect(parsePlace(`sudo`)).toEqual({ kind: `sudo` });
        expect(parsePlace(`sudo as root`)).toEqual({ kind: `sudo`, user: `root` });
    });

    it(`answers nothing for what is no place`, () => {
        expect(parsePlace(``)).toBeUndefined();
        expect(parsePlace(`two words.com here`)).toBeUndefined();
    });
});
