//! Every listener and every tunnel stream hand their requests here. Each resolves once to a destination (Node's Unix
//! socket, a preview's upstream, or a page Node rendered when asked) and is relayed as it stands; an upgrade becomes a
//! byte splice once the far side answers 101, whichever carrier brought it.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use std::convert::Infallible;

use http::header::{self, HeaderMap, HeaderName, HeaderValue};
use http::request::Parts;
use http::{Method, Request, Response, StatusCode, Uri, Version};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use netd_wire::{
    Answer, LOOPBACK_LISTENER, ListenConfig, NetdHeader, PARENT_LISTENER, Page, PreviewRoute,
    Question, Scheme, TerminalPlan, Upstream,
};
use relay::body::{self, Body};
use relay::{for_next_hop, host_of, is_upgrade, strip_hop_by_hop};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::watch;
use tower_service::Service;

use crate::connect::{self, Io, NodeConnector, Pool, UpstreamConnector};
use crate::guard::{self, Verdict};
use crate::link::Link;
use crate::route::{self, Listener, Target};
use crate::term::{self, Terminals};
use crate::uplinks::Uplinks;
use crate::vitals::{self, Vitals};

// What a preview request handed back to Node is, named on it (`NetdHeader::Preview`): the outbox Node decided it is,
// a pass being exchanged on a host the preview guard covers, or a navigation the guard refused, for Node's page.
const OUTBOX: &str = "outbox";
const PASS: &str = "pass";
const SIGN_IN: &str = "signin";

// A restarting Node is waited for this long before a request is answered 503; its sockets stay open meanwhile.
const NODE_PATIENCE: Duration = Duration::from_secs(30);

// A resolved preview upstream is served as is this long; a panel that stops is noticed within it.
const PREVIEW_ROUTE_FRESH: Duration = Duration::from_secs(1);

// Past fresh and within this, the route is still served while Node is asked again in the background, so a daemon stalled
// in a collection or a sync call never holds a preview's request; past it, the request waits for Node's answer.
const PREVIEW_ROUTE_STALE: Duration = Duration::from_secs(60);

// Past this many hosts the cache sheds what has gone stale; only hosts Node resolved to an upstream are ever held.
const PREVIEW_ROUTE_ROOM: usize = 256;

const TERMINAL_UPGRADES: &str = "a terminal opens as a WebSocket";

const ONE_HOST: &str = "a request names one Host";

const MEDIA_UPGRADES: &str = "a browser media socket opens as a WebSocket";

const MEDIA_NAMES: &str = "a browser media socket names its session: [A-Za-z0-9_-]{1,64}";

const DEVICE_UPGRADES: &str = "a device's screen or terminal opens as a WebSocket";

const DEVICE_NAMES: &str =
    "a device's screen or terminal names its device and session: [A-Za-z0-9_-]{1,64} each";

const RUNNER_NAMES: &str = "a runner's view names its runner: [A-Za-z0-9_-]{1,64}";

const RUNNER_ALLOWED: &str =
    "a runner's view opens only its terminal, browser view, desktop view or a media socket";

const RUNNER_UPGRADES: &str = "a runner's view opens as a WebSocket";

const RUNNER_REFUSED: &str = "this runner view was not admitted";

// The Host a runner's view is sent on with: never a preview's name, so the runner's netd hands it to its own routes.
const RUNNER_HOST: &str = "localhost";

const OWN_LISTENER: &str = "a preview never reaches one of this sandbox's own listeners";

// A host that dials this machine: `localhost` and its subdomains, a loopback address, or the unspecified one (which
// connects to the local host). netd's listeners bind these or a wildcard that covers them.
fn is_loopback_host(host: &str) -> bool {
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .is_ok_and(|address| address.is_loopback() || address.is_unspecified())
}

// What a runner view's splice is buffered by between the person's socket and the runner's stream.
const VIEW_BUFFER: usize = 64 * 1024;

// A runner's loopback port a runner-slot preview reaches, as the runner's netd relays it: `localhost`, so a dev server
// bound to `::1` alone is reached too, and Host and Origin rewritten as for any port forward.
fn runner_port_upstream(port: u16) -> Upstream {
    Upstream {
        host: "localhost".into(),
        port,
        scheme: Scheme::Http,
        localhost: true,
        frameable: false,
    }
}

// An open runner view: whose ticket opened it (none for a media socket, or a daemon without auth), and what ends it.
struct View {
    member: Option<String>,
    media: bool,
    ending: watch::Sender<bool>,
}

pub struct Netd {
    link: &'static Link,
    node: Pool<NodeConnector>,
    node_connector: NodeConnector,
    upstream: Pool<UpstreamConnector>,
    upstream_connector: UpstreamConnector,
    config: watch::Receiver<Option<Arc<ListenConfig>>>,
    // Only routes netd relays itself are held: a local upstream, or a runner's port.
    previews: Mutex<HashMap<String, (Instant, PreviewRoute)>>,
    refreshing: Mutex<HashSet<String>>,
    terminals: Arc<Terminals>,
    vitals: Arc<Vitals>,
    /// Where each window's castd listens, `<session>.sock` (browser-wire's `BROWSER_MEDIA_SOCKET_DIR` for the
    /// container's own netd).
    cast_dir: PathBuf,
    /// Connected computers' uplinks, which their screens and terminals are carried down (`uplinks.rs`).
    devices: Arc<Uplinks>,
    /// This sandbox's runners' uplinks, which a person's view of a runner and a runner-slot preview are carried down.
    runners: Arc<Uplinks>,
    /// Every runner view spliced now, so a member's revocation ends theirs.
    views: Arc<Mutex<HashMap<u64, View>>>,
    next_view: AtomicU64,
}

enum Destination {
    /// Node's socket; `handed` hands a preview request back marked as what it is (`OUTBOX`, `PASS`, `SIGN_IN`).
    Node {
        handed: Option<&'static str>,
    },
    Upstream {
        upstream: Upstream,
        host: String,
        proto: &'static str,
        ancestors: Vec<String>,
    },
    /// A port on one of this sandbox's runners, carried down its uplink.
    Runner {
        runner: String,
        port: u16,
        frameable: bool,
        host: String,
        ancestors: Vec<String>,
    },
    /// Node's own answer, rendered when netd asked where the request goes.
    Page(Page),
    Unavailable,
}

impl Netd {
    // Each is a part of netd main.rs builds once and hands in; a struct of them would only be this list again.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        link: &'static Link,
        node_socket: std::path::PathBuf,
        config: watch::Receiver<Option<Arc<ListenConfig>>>,
        terminals: Arc<Terminals>,
        vitals: Arc<Vitals>,
        cast_dir: PathBuf,
        devices: Arc<Uplinks>,
        runners: Arc<Uplinks>,
    ) -> Self {
        let node_connector = NodeConnector::new(node_socket);
        let upstream_connector = UpstreamConnector::new();
        Self {
            cast_dir,
            devices,
            runners,
            views: Arc::default(),
            next_view: AtomicU64::new(1),
            link,
            node: connect::pool(node_connector.clone()),
            node_connector,
            upstream: connect::pool(upstream_connector.clone()),
            upstream_connector,
            config,
            previews: Mutex::new(HashMap::new()),
            refreshing: Mutex::new(HashSet::new()),
            terminals,
            vitals,
        }
    }

    pub async fn handle(
        self: &Arc<Self>,
        listener: Listener,
        mut request: Request<Incoming>,
    ) -> Response<Body> {
        // Read before every netd header is stripped, and only off a stream the parent's uplink brought: from anywhere
        // else it is a stranger's, and goes with the rest.
        let runner_port = runner_port_of(listener, request.headers());
        strip_netd_headers(request.headers_mut());
        // Two Hosts name two targets, and a hop after this one may read the other (RFC 9112 §3.2).
        if request
            .headers()
            .get_all(header::HOST)
            .iter()
            .nth(1)
            .is_some()
        {
            return plain(StatusCode::BAD_REQUEST, ONE_HOST);
        }
        let host = host_of(&request);
        // A runner-slot preview the parent carried here: this runner's own port, Node never asked. Never one of netd's own
        // listeners: the loopback port there would serve this runner's whole daemon, unauthenticated and marked as the
        // machine's own, at a preview's address (2026-11-23 review).
        if let Some(port) = runner_port {
            if self.own_port(port) {
                tracing::warn!(
                    port,
                    "refused a runner-slot preview aimed at one of netd's own listeners"
                );
                return plain(StatusCode::FORBIDDEN, OWN_LISTENER);
            }
            let destination = Destination::Upstream {
                upstream: runner_port_upstream(port),
                host: host.clone(),
                proto: "http",
                ancestors: Vec::new(),
            };
            return self.forward(destination, listener, request, None).await;
        }
        // Answered before anything waits for Node: it is how a caller tells a busy or restarting Node from a dead box.
        if vitals::serves(request.uri().path()) && self.target(listener, &host) == Target::Node {
            return self.vitals.respond(request.method(), request.headers());
        }
        // A window's media socket is its castd's, never Node's: relayed before anything waits for Node, so a picture
        // keeps flowing while the daemon restarts, and kept off Node's event loop, which is what castd is for.
        if self.target(listener, &host) == Target::Node
            && let Some(asked) = route::media(request.uri().path())
        {
            let session = match asked {
                route::Media::Session(session) => Some(session.to_owned()),
                route::Media::BadName => None,
            };
            return self.media(session, listener, request).await;
        }
        // A connected computer's uplink, and a person's screen or terminal carried down one: never Node's, so they keep
        // flowing while the daemon restarts, as a window's media socket does.
        if self.target(listener, &host) == Target::Node {
            if route::is_device_uplink(request.uri().path()) {
                return self.devices.uplink(request);
            }
            if let Some(asked) = route::device_view(request.uri().path()) {
                let named = match asked {
                    route::DeviceView::Session {
                        route,
                        device,
                        session,
                    } => Some((route, device.to_owned(), session.to_owned())),
                    route::DeviceView::BadName => None,
                };
                return self.device_view(named, listener, request).await;
            }
            // A runner dialling this parent, and a person's view of a runner carried down its uplink.
            if route::is_runner_uplink(request.uri().path()) {
                return self.runners.uplink(request);
            }
            if let Some(asked) = route::runner_view(request.uri().path()) {
                return self.runner_view(asked, request).await;
            }
        }
        // The owner's guard is checked before Node is asked anything, so a visitor without a pass costs Node nothing
        // but the page a navigation is shown.
        let guarded = self.guarded(listener, &host);
        let verdict = match guarded
            .as_deref()
            .and_then(|config| config.preview_guard.as_ref().map(|guard| (config, guard)))
        {
            Some((config, guard)) => {
                let (method, path) = (request.method().clone(), request.uri().path().to_owned());
                guard::judge(
                    guard,
                    &config.preview_probe_path,
                    &method,
                    &path,
                    request.headers_mut(),
                    guard::now(),
                )
            }
            None => Verdict::Open,
        };
        let destination = match verdict {
            Verdict::Open => {
                self.destination(listener, &host, request.uri().path())
                    .await
            }
            Verdict::Exchange => self.node_destination(Some(PASS)).await,
            Verdict::SignIn => self.node_destination(Some(SIGN_IN)).await,
            Verdict::Refused => return guard::refused(request.headers()),
        };
        match destination {
            Destination::Unavailable => return unavailable(),
            Destination::Page(page) => return answer_page(page),
            _ => {}
        }
        if is_netd_route(&destination, request.method(), request.uri().path()) {
            return self.terminal(request).await;
        }
        self.forward(destination, listener, request, guarded).await
    }

    // Relays a request to the destination it resolved to: a fresh connection for an upgrade, else the pool; a runner's
    // port down that runner's uplink, a stream per exchange.
    async fn forward(
        &self,
        destination: Destination,
        listener: Listener,
        request: Request<Incoming>,
        guarded: Option<Arc<ListenConfig>>,
    ) -> Response<Body> {
        if let Destination::Runner { .. } = destination {
            return self.runner_preview(destination, request, guarded).await;
        }
        // A preview is a dev server's, never netd's own door: a loopback upstream on one of netd's listener ports would
        // hand a preview host the daemon, its loopback port's proofs included.
        if let Destination::Upstream { upstream, .. } = &destination
            && is_loopback_host(&upstream.host)
            && self.own_port(upstream.port)
        {
            tracing::warn!(port = upstream.port, host = %upstream.host, "refused a preview upstream that is one of netd's own listeners");
            return plain(StatusCode::FORBIDDEN, OWN_LISTENER);
        }
        let upgrade = is_upgrade(request.headers(), request.version());
        let (mut parts, incoming) = request.into_parts();
        outbound(&destination, &mut parts, upgrade, listener);
        let outbound = Request::from_parts(parts, body::incoming(incoming));
        if upgrade {
            return match self.dial(&destination, outbound.uri().clone()).await {
                Ok(io) => relay::exchange(io, in_origin_form(outbound))
                    .await
                    .unwrap_or_else(|error| bad_gateway(&error.to_string())),
                Err(error) => bad_gateway(&error.to_string()),
            };
        }
        let sent = match &destination {
            Destination::Node { .. } => self.node.request(outbound).await,
            _ => self.upstream.request(outbound).await,
        };
        match (sent, destination) {
            (
                Ok(answer),
                Destination::Upstream {
                    upstream,
                    ancestors,
                    ..
                },
            ) => {
                let mut relayed = from_far_side(answer, upstream.frameable.then_some(&ancestors));
                if let Some(guard) = guarded
                    .as_deref()
                    .and_then(|config| config.preview_guard.as_ref())
                {
                    guard::keep_pass(relayed.headers_mut(), &guard.cookie);
                }
                relayed
            }
            (Ok(answer), _) => from_far_side(answer, None),
            (Err(error), Destination::Upstream { upstream, host, .. }) => {
                tracing::debug!(error = %causes(&error), port = upstream.port, "a preview upstream did not answer");
                self.previews
                    .lock()
                    .expect("preview cache poisoned")
                    .remove(&host);
                self.unreachable(&host, upstream.port).await
            }
            (Err(error), _) => {
                tracing::warn!(error = %causes(&error), "the daemon did not answer a forwarded request");
                bad_gateway("the daemon did not answer")
            }
        }
    }

    /// Serves one stream a carrier brought (a QUIC stream or a `/tunnel/v2` yamux one, `Listener::Tunnel`; a stream down
    /// a runner's uplink from its parent, `Listener::Parent`) as the HTTP/1.1 connection it is: every request on it
    /// routed like any listener's, and an upgrade itself.
    pub async fn serve_stream<S>(self: &Arc<Self>, stream: S, listener: Listener)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let netd = self.clone();
        let service = service_fn(move |request| {
            let netd = netd.clone();
            async move { Ok::<_, Infallible>(netd.handle(listener, request).await) }
        });
        let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service)
            .with_upgrades()
            .await;
    }

    // The media socket's upgrade, relayed to `<cast dir>/<session>.sock` as the HTTP/1.1 it arrived as (castd checks the
    // token, netd only carries it), then spliced. Only an upgrade: castd's control routes (`/health`, `/screenshot`, …)
    // are Node's to ask on the socket itself, and a path under the media route never names one. One that arrived on the
    // loopback port says so (browser-wire's MEDIA_LISTENER_HEADER, the name netd gives Node too): the viewer runs on this
    // computer, and castd encodes for it as for no network at all.
    async fn media(
        &self,
        session: Option<String>,
        listener: Listener,
        request: Request<Incoming>,
    ) -> Response<Body> {
        let Some(session) = session else {
            return plain(StatusCode::NOT_FOUND, MEDIA_NAMES);
        };
        if !is_upgrade(request.headers(), request.version()) {
            return plain(StatusCode::UPGRADE_REQUIRED, MEDIA_UPGRADES);
        }
        let socket = self.cast_dir.join(format!("{session}.sock"));
        let io = match UnixStream::connect(&socket).await {
            Ok(stream) => Io::Unix {
                inner: TokioIo::new(stream),
            },
            Err(error) => {
                tracing::debug!(%error, session = %session, "no media daemon answered");
                return bad_gateway(&format!(
                    "no media daemon is serving the browser session {session}"
                ));
            }
        };
        let (mut parts, incoming) = request.into_parts();
        for_next_hop(&mut parts.headers, true);
        stamp_listener(&mut parts.headers, listener);
        parts.version = Version::HTTP_11;
        let outbound = in_origin_form(Request::from_parts(parts, body::incoming(incoming)));
        relay::exchange(io, outbound)
            .await
            .unwrap_or_else(|error| bad_gateway(&error.to_string()))
    }

    // A person's screen or terminal on a connected computer, opened as a stream down its uplink and relayed there as
    // the HTTP/1.1 upgrade it arrived as, with the path rewritten to remoted's (`/media/<session>`, `/terminal/<session>`)
    // and the query, which carries the token remoted checks, kept. One that arrived on the loopback port says so, as a
    // window's media socket does: the viewer runs on the computer the sandbox runs on.
    async fn device_view(
        &self,
        named: Option<(route::DeviceRoute, String, String)>,
        listener: Listener,
        request: Request<Incoming>,
    ) -> Response<Body> {
        let Some((route, device, session)) = named else {
            return plain(StatusCode::NOT_FOUND, DEVICE_NAMES);
        };
        if !is_upgrade(request.headers(), request.version()) {
            return plain(StatusCode::UPGRADE_REQUIRED, DEVICE_UPGRADES);
        }
        let Some(opener) = self.devices.opener(&device) else {
            return bad_gateway(&format!(
                "the device {device} has no uplink: its remote access is not running"
            ));
        };
        let stream = match opener.open().await {
            Ok(stream) => stream,
            Err(error) => {
                tracing::debug!(%error, %device, "the device's uplink opened no stream");
                return bad_gateway(&format!(
                    "the device {device}'s uplink did not open a stream"
                ));
            }
        };
        let (mut parts, incoming) = request.into_parts();
        let target = match parts.uri.query() {
            Some(query) => format!("{}/{session}?{query}", route.upstream()),
            None => format!("{}/{session}", route.upstream()),
        };
        parts.uri = match target.parse() {
            Ok(uri) => uri,
            Err(_) => return plain(StatusCode::BAD_REQUEST, DEVICE_NAMES),
        };
        for_next_hop(&mut parts.headers, true);
        stamp_listener(&mut parts.headers, listener);
        parts.version = Version::HTTP_11;
        let outbound = Request::from_parts(parts, body::incoming(incoming));
        relay::exchange(TokioIo::new(stream), outbound)
            .await
            .unwrap_or_else(|error| bad_gateway(&error.to_string()))
    }

    // A person's view of a runner, carried down its uplink (2026-11-23). Only what the allowlist names, only as an
    // upgrade, and each view but a media socket only once the daemon redeemed the ticket it minted for exactly that
    // runner, view and session (`Question::RunnerView`). What reaches the runner is the path on the runner with the query
    // less its ticket, no credentials (`authorization`, `cookie`), no `origin`, and a Host that is no preview's; the
    // runner runs without auth, so this is its only gate. The splice is ended by the member's revocation.
    async fn runner_view(
        &self,
        asked: route::RunnerView,
        request: Request<Incoming>,
    ) -> Response<Body> {
        let (runner, route) = match asked {
            route::RunnerView::Route { runner, route } => (runner, route),
            route::RunnerView::BadName => return plain(StatusCode::NOT_FOUND, RUNNER_NAMES),
            route::RunnerView::NotAllowed => return plain(StatusCode::NOT_FOUND, RUNNER_ALLOWED),
        };
        if !is_upgrade(request.headers(), request.version()) {
            return plain(StatusCode::UPGRADE_REQUIRED, RUNNER_UPGRADES);
        }
        let path = route.path();
        let query = request.uri().query().unwrap_or_default().to_owned();
        let member = if route.ticketed() {
            match self.admit_runner_view(&runner, &path, &query).await {
                Ok(member) => member,
                Err(refusal) => return *refusal,
            }
        } else {
            None
        };
        let Some(opener) = self.runners.opener(&runner) else {
            return bad_gateway(&format!(
                "the runner {runner} has no uplink: it is not connected to this sandbox"
            ));
        };
        let far = match opener.open().await {
            Ok(far) => far,
            Err(error) => {
                tracing::debug!(%error, %runner, "the runner's uplink opened no stream");
                return bad_gateway(&format!(
                    "the runner {runner}'s uplink did not open a stream"
                ));
            }
        };
        let (mut parts, incoming) = request.into_parts();
        let kept = without_ticket(&query);
        let target = if kept.is_empty() {
            path
        } else {
            format!("{path}?{kept}")
        };
        parts.uri = match target.parse() {
            Ok(uri) => uri,
            Err(_) => return plain(StatusCode::BAD_REQUEST, RUNNER_ALLOWED),
        };
        for_next_hop(&mut parts.headers, true);
        for credential in [header::AUTHORIZATION, header::COOKIE, header::ORIGIN] {
            parts.headers.remove(credential);
        }
        parts
            .headers
            .insert(header::HOST, HeaderValue::from_static(RUNNER_HOST));
        parts.version = Version::HTTP_11;
        let near = self.revocable(far, member, !route.ticketed());
        let outbound = Request::from_parts(parts, body::incoming(incoming));
        relay::exchange(TokioIo::new(near), outbound)
            .await
            .unwrap_or_else(|error| bad_gateway(&error.to_string()))
    }

    // Asks the daemon whether this view may open; its member, or the refusal to answer with. Anything but an answer
    // that allows it refuses it: an older daemon refuses a question it does not know.
    async fn admit_runner_view(
        &self,
        runner: &str,
        path: &str,
        query: &str,
    ) -> Result<Option<String>, Box<Response<Body>>> {
        if !self.link.ready(NODE_PATIENCE).await {
            return Err(Box::new(unavailable()));
        }
        let asked = self
            .link
            .ask(Question::RunnerView {
                runner: runner.to_owned(),
                path: path.to_owned(),
                query: query.to_owned(),
            })
            .await;
        match asked {
            Ok(Answer::RunnerView {
                allowed: true,
                member,
                ..
            }) => Ok(member),
            Ok(Answer::RunnerView { reason, .. }) => {
                tracing::info!(%runner, path, reason = reason.as_deref().unwrap_or("none given"), "refused a runner view");
                Err(Box::new(plain(StatusCode::FORBIDDEN, RUNNER_REFUSED)))
            }
            Ok(other) => {
                tracing::error!(
                    ?other,
                    "the daemon answered a runner view's question with another"
                );
                Err(Box::new(plain(StatusCode::FORBIDDEN, RUNNER_REFUSED)))
            }
            Err(error) => {
                tracing::warn!(%error, %runner, path, "the daemon did not admit a runner view");
                Err(Box::new(plain(StatusCode::FORBIDDEN, RUNNER_REFUSED)))
            }
        }
    }

    // The near end of a runner view's splice: a buffer whose far side is copied to the runner's stream until either ends
    // or the view is revoked, which drops both and so closes the person's socket.
    fn revocable<S>(
        &self,
        mut far: S,
        member: Option<String>,
        media: bool,
    ) -> tokio::io::DuplexStream
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (near, mut inner) = tokio::io::duplex(VIEW_BUFFER);
        let (ending, mut ended) = watch::channel(false);
        let id = self.next_view.fetch_add(1, Ordering::Relaxed);
        self.views.lock().expect("views poisoned").insert(
            id,
            View {
                member,
                media,
                ending,
            },
        );
        let views = self.views.clone();
        tokio::spawn(async move {
            let revoked = tokio::select! {
                _ = tokio::io::copy_bidirectional(&mut inner, &mut far) => false,
                _ = ended.wait_for(|ended| *ended) => true,
            };
            if revoked {
                let _ = far.shutdown().await;
            }
            views.lock().expect("views poisoned").remove(&id);
        });
        near
    }

    /// Ends the runner views a member's ticket opened, or every member's; any revocation ends every runner media socket
    /// too, whose viewers dial again with fresh tokens over a view socket that is still entitled.
    pub fn revoke_views(&self, member: Option<&str>) {
        for view in self.views.lock().expect("views poisoned").values() {
            let theirs =
                view.member.is_some() && (member.is_none() || view.member.as_deref() == member);
            if theirs || view.media {
                view.ending.send_replace(true);
            }
        }
    }

    // A runner-slot preview, carried down the runner's uplink as the request it is with the runner's port named on it,
    // a stream per exchange. The owner's guard ran before this, as for any preview; frameable and the pass are applied to
    // the answer as for a local upstream.
    async fn runner_preview(
        &self,
        destination: Destination,
        request: Request<Incoming>,
        guarded: Option<Arc<ListenConfig>>,
    ) -> Response<Body> {
        let Destination::Runner {
            runner,
            port,
            frameable,
            host,
            ancestors,
        } = destination
        else {
            unreachable!("only a runner destination is relayed to a runner");
        };
        let far = match self.runners.opener(&runner) {
            Some(opener) => opener.open().await.ok(),
            None => None,
        };
        let Some(far) = far else {
            self.previews
                .lock()
                .expect("preview cache poisoned")
                .remove(&host);
            return bad_gateway(&format!(
                "the runner {runner} has no uplink: its port {port} cannot be reached"
            ));
        };
        let upgrade = is_upgrade(request.headers(), request.version());
        let (mut parts, incoming) = request.into_parts();
        if let Some(authority) = parts
            .uri
            .authority()
            .and_then(|authority| HeaderValue::from_str(authority.as_str()).ok())
        {
            parts.headers.insert(header::HOST, authority);
        }
        for_next_hop(&mut parts.headers, upgrade);
        if !parts.headers.contains_key("x-forwarded-proto") {
            parts
                .headers
                .insert("x-forwarded-proto", HeaderValue::from_static("https"));
        }
        parts
            .headers
            .insert(NetdHeader::RunnerPort.name(), HeaderValue::from(port));
        parts.version = Version::HTTP_11;
        let outbound = in_origin_form(Request::from_parts(parts, body::incoming(incoming)));
        let mut answer = match relay::exchange(TokioIo::new(far), outbound).await {
            Ok(answer) => answer,
            Err(error) => return bad_gateway(&error.to_string()),
        };
        timing_allowed(answer.headers_mut());
        if frameable {
            frameable_headers(answer.headers_mut(), &ancestors);
        }
        if let Some(guard) = guarded
            .as_deref()
            .and_then(|config| config.preview_guard.as_ref())
        {
            guard::keep_pass(answer.headers_mut(), &guard.cookie);
        }
        answer
    }

    async fn terminal(self: &Arc<Self>, mut request: Request<Incoming>) -> Response<Body> {
        let handshake = match request.version() {
            Version::HTTP_11 => term::Handshake::of(request.headers()),
            _ => None,
        };
        let Some(handshake) = handshake else {
            return plain(StatusCode::UPGRADE_REQUIRED, TERMINAL_UPGRADES);
        };
        let query = request.uri().query().unwrap_or_default().to_owned();
        let (plan, member) = match self.terminal_plan(&query).await {
            Ok(planned) => planned,
            Err(refusal) => return *refusal,
        };
        let upgrade = hyper::upgrade::on(&mut request);
        let terminals = self.terminals.clone();
        let switching = handshake.switching();
        tokio::spawn(async move {
            if let Ok(upgraded) = upgrade.await {
                terminals
                    .serve(TokioIo::new(upgraded), plan, member, &query)
                    .await;
            }
        });
        switching
    }

    // Asked before the socket opens, so a daemon that cannot answer fails the upgrade and the browser retries.
    async fn terminal_plan(
        &self,
        query: &str,
    ) -> Result<(TerminalPlan, Option<String>), Box<Response<Body>>> {
        let asked = self
            .link
            .ask(Question::Terminal {
                query: query.to_owned(),
            })
            .await;
        match asked {
            Ok(Answer::Terminal { plan, member }) => Ok((plan, member)),
            Ok(other) => {
                tracing::error!(
                    ?other,
                    "the daemon answered a terminal's question with another"
                );
                Err(Box::new(bad_gateway(
                    "the daemon could not plan the terminal",
                )))
            }
            Err(error) => {
                tracing::warn!(%error, "the daemon did not plan a terminal");
                Err(Box::new(unavailable()))
            }
        }
    }

    // The config, when the owner's guard covers this host as it arrived: on the preview port or the tunnel, never the
    // machine's own loopback port, whose previews only that machine reaches.
    fn guarded(&self, listener: Listener, host: &str) -> Option<Arc<ListenConfig>> {
        if !matches!(listener, Listener::Preview | Listener::Tunnel) {
            return None;
        }
        let config = self.config.borrow().clone()?;
        let guard = config.preview_guard.as_ref()?;
        let sandbox_id = config.sandbox_id.as_deref();
        (route::target(listener, host, sandbox_id) == Target::Preview
            && guard::covers(guard, host, sandbox_id))
        .then_some(config)
    }

    // Whether `port` is one netd's listen config binds: the daemon's, the preview port or the loopback port.
    fn own_port(&self, port: u16) -> bool {
        self.config.borrow().as_deref().is_some_and(|config| {
            std::iter::once(&config.daemon)
                .chain(config.preview.as_ref())
                .chain(config.loopback.as_ref())
                .any(|endpoint| endpoint.port == port)
        })
    }

    fn target(&self, listener: Listener, host: &str) -> Target {
        let config = self.config.borrow();
        let sandbox_id = config
            .as_deref()
            .and_then(|config| config.sandbox_id.as_deref());
        route::target(listener, host, sandbox_id)
    }

    async fn destination(
        self: &Arc<Self>,
        listener: Listener,
        host: &str,
        path: &str,
    ) -> Destination {
        let config = self.config.borrow().clone();
        let sandbox_id = config
            .as_deref()
            .and_then(|config| config.sandbox_id.as_deref());
        match route::target(listener, host, sandbox_id) {
            Target::Node => self.node_destination(None).await,
            Target::Preview => {
                let Some(config) = config else {
                    return Destination::Unavailable;
                };
                // The probe reports the preview's state whatever it resolves to, so a cached upstream never answers it.
                let routed = if path == config.preview_probe_path {
                    self.resolve(host, true).await
                } else {
                    self.preview_route(host).await
                };
                match routed {
                    Ok(PreviewRoute::Runner {
                        runner,
                        port,
                        frameable,
                    }) => Destination::Runner {
                        runner,
                        port,
                        frameable,
                        host: host.to_owned(),
                        ancestors: config.frame_ancestors.clone(),
                    },
                    Ok(PreviewRoute::Upstream { upstream }) => Destination::Upstream {
                        upstream,
                        host: host.to_owned(),
                        proto: if listener == Listener::Tunnel {
                            "https"
                        } else {
                            "http"
                        },
                        ancestors: config.frame_ancestors.clone(),
                    },
                    Ok(PreviewRoute::Page { page }) => Destination::Page(page),
                    Ok(PreviewRoute::Outbox) => self.node_destination(Some(OUTBOX)).await,
                    Err(error) => {
                        tracing::warn!(%error, host, "could not resolve a preview host");
                        Destination::Unavailable
                    }
                }
            }
        }
    }

    async fn node_destination(&self, handed: Option<&'static str>) -> Destination {
        if self.link.ready(NODE_PATIENCE).await {
            Destination::Node { handed }
        } else {
            Destination::Unavailable
        }
    }

    async fn preview_route(self: &Arc<Self>, host: &str) -> anyhow::Result<PreviewRoute> {
        let cached = self
            .previews
            .lock()
            .expect("preview cache poisoned")
            .get(host)
            .cloned();
        if let Some((at, route)) = cached {
            if at.elapsed() >= PREVIEW_ROUTE_FRESH && at.elapsed() < PREVIEW_ROUTE_STALE {
                self.refresh(host);
            }
            if at.elapsed() < PREVIEW_ROUTE_STALE {
                return Ok(route);
            }
        }
        self.resolve(host, false).await
    }

    // One background question per host at a time; its answer replaces the stale route for everyone after it.
    fn refresh(self: &Arc<Self>, host: &str) {
        if !self
            .refreshing
            .lock()
            .expect("refresh set poisoned")
            .insert(host.to_owned())
        {
            return;
        }
        let netd = self.clone();
        let host = host.to_owned();
        tokio::spawn(async move {
            if let Err(error) = netd.resolve(&host, false).await {
                tracing::debug!(%error, host, "a background preview refresh failed; the stale route stands");
            }
            netd.refreshing
                .lock()
                .expect("refresh set poisoned")
                .remove(&host);
        });
    }

    // Node decides once what becomes of the request; only an upstream is remembered, since a page is of its moment.
    async fn resolve(&self, host: &str, probe: bool) -> anyhow::Result<PreviewRoute> {
        if !self.link.ready(NODE_PATIENCE).await {
            anyhow::bail!("the daemon is not up to resolve {host}");
        }
        let answer = self
            .link
            .ask(Question::Preview {
                host: host.to_owned(),
                probe,
            })
            .await?;
        let Answer::Preview { route } = answer else {
            anyhow::bail!("the daemon answered {host}'s route with {answer:?}");
        };
        let mut previews = self.previews.lock().expect("preview cache poisoned");
        match &route {
            PreviewRoute::Upstream { .. } | PreviewRoute::Runner { .. } if !probe => {
                if previews.len() >= PREVIEW_ROUTE_ROOM {
                    previews.retain(|_, (at, _)| at.elapsed() < PREVIEW_ROUTE_STALE);
                }
                previews.insert(host.to_owned(), (Instant::now(), route.clone()));
            }
            PreviewRoute::Upstream { .. } | PreviewRoute::Runner { .. } => {}
            PreviewRoute::Page { .. } | PreviewRoute::Outbox => {
                previews.remove(host);
            }
        }
        Ok(route)
    }

    // An upgrade dials a connection of its own, since an upgraded one never returns to a pool.
    async fn dial(&self, destination: &Destination, uri: Uri) -> std::io::Result<Io> {
        match destination {
            Destination::Node { .. } => self.node_connector.clone().call(uri).await,
            _ => self.upstream_connector.clone().call(uri).await,
        }
    }

    // The request was consumed by the failed attempt, so Node is asked for the page with a request of its own.
    async fn unreachable(&self, host: &str, port: u16) -> Response<Body> {
        let request = Request::builder()
            .uri("http://node/")
            .header(header::HOST, host)
            .header(NetdHeader::PreviewUnreachable.name(), port)
            .body(body::empty())
            .expect("a static request always builds");
        match self.node.request(request).await {
            Ok(answer) => from_far_side(answer, None),
            Err(_) => bad_gateway(&format!("nothing is answering on port {port}")),
        }
    }
}

// A route netd answers itself is the daemon's own: a preview's app may have a path of the same name.
fn is_netd_route(destination: &Destination, method: &Method, path: &str) -> bool {
    matches!(destination, Destination::Node { handed: None }) && term::serves(method, path)
}

fn strip_netd_headers(headers: &mut HeaderMap) {
    for netd in NetdHeader::ALL {
        headers.remove(netd.name());
    }
}

// The runner port a parent's netd named on a runner-slot preview: only on `Listener::Parent`, never 0, else none.
fn runner_port_of(listener: Listener, headers: &HeaderMap) -> Option<u16> {
    if listener != Listener::Parent {
        return None;
    }
    headers
        .get(NetdHeader::RunnerPort.name())?
        .to_str()
        .ok()?
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
}

// Says which way a request came in, to Node and castd: `loopback` from the machine-published loopback port, `parent`
// down a runner's uplink, nothing otherwise. Said only by netd, which stripped any copy the request arrived with
// (`strip_netd_headers`).
fn stamp_listener(headers: &mut HeaderMap, listener: Listener) {
    let value = match listener {
        Listener::Loopback { .. } => LOOPBACK_LISTENER,
        Listener::Parent => PARENT_LISTENER,
        Listener::Daemon | Listener::Preview | Listener::Tunnel => return,
    };
    headers.insert(NetdHeader::Listener.name(), HeaderValue::from_static(value));
}

// A query without its runner view ticket, every other pair kept as written.
fn without_ticket(query: &str) -> String {
    query
        .split('&')
        .filter(|pair| {
            !pair.is_empty()
                && pair.split_once('=').map_or(*pair, |(key, _)| key)
                    != browser_wire::RUNNER_VIEW_TICKET
        })
        .collect::<Vec<_>>()
        .join("&")
}

// Rewrites a request for its destination: an h1 request to that address, Host present, hop-by-hop headers gone. A
// target naming its authority (h2's `:authority`, an h1 absolute form) was routed by it, so it is the Host sent on,
// whatever Host the request came with (RFC 9112 §3.2.2).
fn outbound(destination: &Destination, parts: &mut Parts, upgrade: bool, listener: Listener) {
    if let Some(authority) = parts
        .uri
        .authority()
        .and_then(|authority| HeaderValue::from_str(authority.as_str()).ok())
    {
        parts.headers.insert(header::HOST, authority);
    }
    for_next_hop(&mut parts.headers, upgrade);
    let path = parts
        .uri
        .path_and_query()
        .map_or("/", |path| path.as_str())
        .to_owned();
    let base = match destination {
        Destination::Node { handed } => {
            if let Some(handed) = handed {
                parts
                    .headers
                    .insert(NetdHeader::Preview.name(), HeaderValue::from_static(handed));
            }
            stamp_listener(&mut parts.headers, listener);
            "http://node".to_owned()
        }
        Destination::Upstream {
            upstream,
            host,
            proto,
            ..
        } => {
            let scheme = scheme_name(upstream.scheme);
            if let Ok(forwarded_host) = HeaderValue::from_str(host) {
                parts.headers.insert("x-forwarded-host", forwarded_host);
            }
            if !parts.headers.contains_key("x-forwarded-proto") {
                parts
                    .headers
                    .insert("x-forwarded-proto", HeaderValue::from_static(proto));
            }
            if upstream.localhost {
                let localhost = format!("localhost:{}", upstream.port);
                if parts.headers.contains_key(header::ORIGIN)
                    && let Ok(origin) = HeaderValue::from_str(&format!("{scheme}://{localhost}"))
                {
                    parts.headers.insert(header::ORIGIN, origin);
                }
                if let Ok(host) = HeaderValue::from_str(&localhost) {
                    parts.headers.insert(header::HOST, host);
                }
            }
            format!("{scheme}://{}:{}", uri_host(&upstream.host), upstream.port)
        }
        Destination::Runner { .. } | Destination::Page(_) | Destination::Unavailable => {
            unreachable!(
                "a runner's port, a page and an unavailable destination are answered before a request is rewritten for them"
            )
        }
    };
    parts.uri = format!("{base}{path}")
        .parse()
        .unwrap_or_else(|_| Uri::from_static("http://node/"));
    parts.version = Version::HTTP_11;
}

// An upgrade rides a connection of its own, whose h1 client writes the target as given (the pool writes origin form
// itself). An h1 server expects origin form from anything but a proxy, and a dev server matching the target as a path
// (`ws` with `path`, Vite's HMR) refused the absolute one (2026-10-06). The address was the dial's, and is spent.
fn in_origin_form(mut request: Request<Body>) -> Request<Body> {
    let target = request
        .uri()
        .path_and_query()
        .map_or("/", |path| path.as_str())
        .parse()
        .unwrap_or_else(|_| Uri::from_static("/"));
    *request.uri_mut() = target;
    request
}

// An IPv6 literal (a dev server bound to `::1` alone) is bracketed in a URI, or the port reads as part of it.
fn uri_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}

fn scheme_name(scheme: Scheme) -> &'static str {
    match scheme {
        Scheme::Http => "http",
        Scheme::Https => "https",
    }
}

fn from_far_side(
    answer: Response<Incoming>,
    frame_ancestors: Option<&Vec<String>>,
) -> Response<Body> {
    let (mut parts, incoming) = answer.into_parts();
    strip_hop_by_hop(&mut parts.headers);
    timing_allowed(&mut parts.headers);
    if let Some(ancestors) = frame_ancestors {
        frameable_headers(&mut parts.headers, ancestors);
    }
    Response::from_parts(parts, body::incoming(incoming))
}

// Expose Resource Timing's negotiated protocol to the same origin the daemon already allowed through CORS.
// A foreign origin gets neither the response body nor its connection timing.
fn timing_allowed(headers: &mut HeaderMap) {
    if let Some(origin) = headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).cloned() {
        headers.insert("timing-allow-origin", origin);
    }
}

// A preview may be framed by the editor's origins and by itself (an app framing its own pages is checked against the
// preview's origin too), whatever the upstream app's own policy says.
fn frameable_headers(headers: &mut HeaderMap, ancestors: &[String]) {
    headers.remove("x-frame-options");
    let sources = std::iter::once("'self'")
        .chain(ancestors.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let policies: Vec<String> = headers
        .get_all(header::CONTENT_SECURITY_POLICY)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_owned))
        .collect();
    headers.remove(header::CONTENT_SECURITY_POLICY);
    if policies.is_empty() {
        if let Ok(value) = HeaderValue::from_str(&format!("frame-ancestors {sources}")) {
            headers.insert(header::CONTENT_SECURITY_POLICY, value);
        }
        return;
    }
    for policy in policies {
        if let Ok(value) = HeaderValue::from_str(&with_frame_ancestors(&policy, &sources)) {
            headers.append(header::CONTENT_SECURITY_POLICY, value);
        }
    }
}

fn with_frame_ancestors(policy: &str, sources: &str) -> String {
    policy
        .split(';')
        .map(str::trim)
        .filter(|directive| {
            let name = directive.split_whitespace().next().unwrap_or("");
            !directive.is_empty() && !name.eq_ignore_ascii_case("frame-ancestors")
        })
        .map(str::to_owned)
        .chain(std::iter::once(format!("frame-ancestors {sources}")))
        .collect::<Vec<_>>()
        .join("; ")
}

// Node's page as it rendered it: its status, its headers and its body, nothing added.
fn answer_page(page: Page) -> Response<Body> {
    let mut response = Response::new(body::full(page.body));
    *response.status_mut() = StatusCode::from_u16(page.status).unwrap_or(StatusCode::BAD_GATEWAY);
    for (name, value) in page.headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(name), HeaderValue::try_from(value)) {
            response.headers_mut().append(name, value);
        }
    }
    response
}

// hyper-util's error names only the stage it failed in ("client error (SendRequest)"); the cause is its sources.
fn causes(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

fn plain(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body::full(message.to_owned()))
        .expect("a static response always builds")
}

fn unavailable() -> Response<Body> {
    let mut response = plain(
        StatusCode::SERVICE_UNAVAILABLE,
        "the sandbox daemon is restarting",
    );
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    response
}

fn bad_gateway(message: &str) -> Response<Body> {
    plain(StatusCode::BAD_GATEWAY, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_forwarding_failure_is_logged_with_what_caused_it() {
        #[derive(Debug)]
        struct Stage(std::io::Error);
        impl std::fmt::Display for Stage {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("client error (SendRequest)")
            }
        }
        impl std::error::Error for Stage {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        let reset = std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "connection reset by peer",
        );
        assert_eq!(
            causes(&Stage(reset)),
            "client error (SendRequest): connection reset by peer"
        );
    }

    /// Only netd says a request came in on the loopback port: a copy of the header from outside is gone before the
    /// request is routed, and a request from any other listener reaches Node without one.
    #[test]
    fn only_a_request_that_arrived_on_loopback_reaches_node_marked_as_one() {
        let forwarded = |listener: Listener, sent: Option<&'static str>| {
            let mut request = Request::get("/agents/attention").body(()).unwrap();
            if let Some(value) = sent {
                request
                    .headers_mut()
                    .insert(NetdHeader::Listener.name(), HeaderValue::from_static(value));
            }
            strip_netd_headers(request.headers_mut());
            let (mut parts, ()) = request.into_parts();
            outbound(
                &Destination::Node { handed: None },
                &mut parts,
                false,
                listener,
            );
            parts
                .headers
                .get(NetdHeader::Listener.name())
                .map(|value| value.to_str().unwrap().to_owned())
        };
        assert_eq!(
            forwarded(Listener::Loopback { tls: false }, None).as_deref(),
            Some(LOOPBACK_LISTENER)
        );
        assert_eq!(
            forwarded(Listener::Loopback { tls: true }, None).as_deref(),
            Some(LOOPBACK_LISTENER)
        );
        assert_eq!(forwarded(Listener::Tunnel, Some(LOOPBACK_LISTENER)), None);
        assert_eq!(forwarded(Listener::Daemon, Some(LOOPBACK_LISTENER)), None);
        assert_eq!(forwarded(Listener::Preview, None), None);
        assert_eq!(
            forwarded(Listener::Parent, Some(LOOPBACK_LISTENER)).as_deref(),
            Some(PARENT_LISTENER)
        );
        assert_eq!(forwarded(Listener::Tunnel, Some(PARENT_LISTENER)), None);
    }

    /// A runner port is read only off a stream from the parent, and is gone from every request once read.
    #[test]
    fn a_runner_port_is_honoured_only_from_the_parent() {
        let mut headers = HeaderMap::new();
        headers.insert(
            NetdHeader::RunnerPort.name(),
            HeaderValue::from_static("5173"),
        );
        assert_eq!(runner_port_of(Listener::Parent, &headers), Some(5173));
        for listener in [
            Listener::Daemon,
            Listener::Preview,
            Listener::Tunnel,
            Listener::Loopback { tls: false },
        ] {
            assert_eq!(runner_port_of(listener, &headers), None, "{listener:?}");
        }
        headers.insert(NetdHeader::RunnerPort.name(), HeaderValue::from_static("0"));
        assert_eq!(runner_port_of(Listener::Parent, &headers), None);
        headers.insert(NetdHeader::RunnerPort.name(), HeaderValue::from_static("x"));
        assert_eq!(runner_port_of(Listener::Parent, &headers), None);
        strip_netd_headers(&mut headers);
        assert!(headers.is_empty());
    }

    #[test]
    fn a_loopback_host_is_any_name_that_dials_this_machine() {
        for local in [
            "localhost",
            "LocalHost",
            "localhost.",
            "app.localhost",
            "127.0.0.1",
            "127.1.2.3",
            "::1",
            "[::1]",
            "0.0.0.0",
            "::",
        ] {
            assert!(is_loopback_host(local), "{local}");
        }
        for remote in [
            "example.test",
            "10.0.0.5",
            "localhost.example.test",
            "2001:db8::1",
        ] {
            assert!(!is_loopback_host(remote), "{remote}");
        }
    }

    #[test]
    fn a_runner_view_loses_its_ticket_and_keeps_the_rest() {
        assert_eq!(
            without_ticket("session=agent-1&ticket=abc&deflate=1"),
            "session=agent-1&deflate=1"
        );
        assert_eq!(without_ticket("ticket=abc"), "");
        assert_eq!(without_ticket("ticket"), "");
        assert_eq!(without_ticket("tickets=1&&x=ticket"), "tickets=1&x=ticket");
        assert_eq!(without_ticket(""), "");
    }

    #[test]
    fn an_ipv6_upstream_is_bracketed_in_its_uri() {
        assert_eq!(uri_host("::1"), "[::1]");
        assert_eq!(uri_host("[::1]"), "[::1]");
        assert_eq!(uri_host("127.0.0.1"), "127.0.0.1");
    }

    #[test]
    fn frame_ancestors_replaces_the_apps_own_and_keeps_the_rest() {
        assert_eq!(
            with_frame_ancestors(
                "default-src 'self'; frame-ancestors 'none';img-src *",
                "'self' https://app.example"
            ),
            "default-src 'self'; img-src *; frame-ancestors 'self' https://app.example"
        );
        assert_eq!(
            with_frame_ancestors("frame-ancestors", "'self'"),
            "frame-ancestors 'self'"
        );
    }

    #[test]
    fn a_frameable_answer_drops_x_frame_options_and_sets_its_ancestors() {
        let mut headers = HeaderMap::new();
        headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
        frameable_headers(&mut headers, &["https://app.example".to_owned()]);
        assert!(!headers.contains_key("x-frame-options"));
        assert_eq!(
            headers[header::CONTENT_SECURITY_POLICY],
            "frame-ancestors 'self' https://app.example"
        );
    }

    #[test]
    fn timing_is_visible_only_to_an_origin_allowed_by_the_daemon() {
        let mut headers = HeaderMap::new();
        timing_allowed(&mut headers);
        assert!(!headers.contains_key("timing-allow-origin"));
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("https://app.example"),
        );
        timing_allowed(&mut headers);
        assert_eq!(headers["timing-allow-origin"], "https://app.example");
    }

    #[test]
    fn a_page_is_written_as_node_rendered_it() {
        let page = Page {
            status: 404,
            headers: [
                (
                    "content-type".to_owned(),
                    "text/html; charset=utf-8".to_owned(),
                ),
                ("bad name".to_owned(), "dropped".to_owned()),
            ]
            .into(),
            body: "<p>No preview here</p>".into(),
        };
        let response = answer_page(page);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(response.headers().len(), 1);
    }
}
