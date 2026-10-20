//! Phase 1 on the platform: the session cookie's sign-ins, the sandbox list, and what it mints for a daemon.

use crate::contract::{Samples, assert_platform_route};
use intentic_mobile::wire::auth::{
    self, AuthError, EmailCodeRequest, EmailCodeSignIn, GoogleSignIn, OneTimeToken, SignedIn,
    Success, Verified,
};
use intentic_mobile::wire::platform::{self, *};

#[test]
fn platform_calls() {
    let mut samples = Samples::load("platform.json");
    let users = samples.checked::<Option<User>>("me.get:output");
    assert!(users.iter().any(|(_, user)| user.is_none()));
    samples.checked::<SignInOptions>("me.signInOptions:output");
    let lists = samples.checked::<SandboxList>("sandbox.list:output");
    let hosted = &lists[0].1.sandboxes[1];
    assert_eq!(
        hosted
            .hosted
            .as_ref()
            .and_then(|machine| machine.state.as_deref()),
        Some("asleep")
    );
    samples.checked::<SandboxId>("sandbox.identityAssertion:input");
    samples.checked::<MintedProof>("sandbox.identityAssertion:output");
    samples.checked::<SandboxId>("sandbox.ownerTicket:input");
    samples.checked::<MintedOwnerTicket>("sandbox.ownerTicket:output");
    samples.checked::<SandboxId>("sandbox.wake:input");
    samples.checked::<Done>("sandbox.wake:output");
    samples.checked::<HandoffStart>("desktop.handoff:input");
    samples.checked::<Handoff>("desktop.handoff:output");
    samples.checked::<HandoffRedeem>("desktop.redeem:input");
    samples.checked::<Redeemed>("desktop.redeem:output");
    samples.checked::<PushDevice>("push.register:input");
    samples.checked::<PushGrant>("push.register:output");
    samples.checked::<PushDeviceId>("push.unregister:input");
    samples.checked::<Done>("push.unregister:output");
    samples.decoded::<RpcError>("RpcError");
    samples.finish();
    for (name, route) in [
        ("me.get", platform::ME),
        ("me.signInOptions", platform::SIGN_IN_OPTIONS),
        ("sandbox.list", platform::SANDBOX_LIST),
        ("sandbox.identityAssertion", platform::IDENTITY_ASSERTION),
        ("sandbox.ownerTicket", platform::OWNER_TICKET),
        ("sandbox.wake", platform::WAKE),
        ("desktop.handoff", platform::DESKTOP_HANDOFF),
        ("desktop.redeem", platform::DESKTOP_REDEEM),
        ("push.register", platform::PUSH_REGISTER),
        ("push.unregister", platform::PUSH_UNREGISTER),
    ] {
        assert_platform_route(name, route);
    }
}

#[test]
fn better_auth() {
    let mut samples = Samples::load("auth.json");
    samples.checked::<EmailCodeRequest>("auth.sendEmailCode:input");
    samples.checked::<EmailCodeSignIn>("auth.signInEmailCode:input");
    samples.checked::<GoogleSignIn>("auth.googleSignIn:input");
    samples.checked::<OneTimeToken>("auth.verifyOneTimeToken:input");
    let signed_in = samples.decoded::<SignedIn>("SignedIn");
    assert!(signed_in[0].1.user.email_verified);
    samples.decoded::<Verified>("Verified");
    samples.decoded::<Success>("Success");
    samples.decoded::<AuthError>("AuthError");
    samples.finish();
    for (name, route) in [
        ("auth.sendEmailCode", auth::SEND_EMAIL_CODE),
        ("auth.signInEmailCode", auth::SIGN_IN_EMAIL_CODE),
        ("auth.googleSignIn", auth::GOOGLE_SIGN_IN),
        ("auth.verifyOneTimeToken", auth::VERIFY_ONE_TIME_TOKEN),
        ("auth.signOut", auth::SIGN_OUT),
    ] {
        assert_platform_route(name, route);
    }
}
