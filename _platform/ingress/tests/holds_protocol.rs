//! The holds protocol over real sockets: fake peers record what this machine tells them and answer what they hold, and
//! two whole machines hand a request that landed on the wrong one to the one holding the tunnel.

mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http::{Method, Response, StatusCode};
use http_body_util::BodyExt;
use intentic_ingress::body;
use intentic_ingress::cluster::{self, Cluster, HOLDS_PATH, HOP_HEADER, Holds, Op, REMOTE_TTL};
use intentic_ingress::edge::{Edge, EdgeOptions, Via};
use intentic_ingress::peers::Peer;
use intentic_ingress::registry::{Held, Registry, Slot};
use intentic_ingress::revocation::Revocation;
use intentic_ingress::serve::{self, Listening};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tunnel::{Close, DISPLACED_CODE, Ended};

use support::{
    Keys, SANDBOX_ID, ZONE, daemon_host, dial, get, idle_session, send, serving, upgrade, wait_for,
};

const X: &str = "aaaaaaaaaaaa";
const Y: &str = "bbbbbbbbbbbb";

fn this() -> Peer {
    Peer {
        host: "127.0.0.1".into(),
        port: 8080,
        internal_port: 8081,
    }
}

/// A peer's internal surface: records every holds message POSTed to it and answers a GET with what it holds.
struct FakePeer {
    peer: Peer,
    heard: Arc<Mutex<Vec<Holds>>>,
    _listening: Listening,
}

impl FakePeer {
    fn heard(&self) -> Vec<(Op, Vec<String>)> {
        self.heard
            .lock()
            .unwrap()
            .iter()
            .map(|holds| {
                let mut ids = holds.ids.clone();
                ids.sort();
                (holds.op, ids)
            })
            .collect()
    }

    fn from(&self, op: Op, ids: &[&str]) -> Holds {
        Holds {
            from: self.peer.clone(),
            instance: format!("peer-{}", self.peer.internal_port),
            op,
            ids: ids.iter().map(|id| (*id).to_owned()).collect(),
        }
    }
}

async fn fake_peer(holds: &'static [&'static str]) -> FakePeer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer = Peer {
        host: "127.0.0.1".into(),
        port: 1,
        internal_port: listener.local_addr().unwrap().port(),
    };
    let heard = Arc::new(Mutex::new(Vec::new()));
    let recording = heard.clone();
    let answering = peer.clone();
    let listening = serve::serve_on(listener, move |request, _| {
        let heard = recording.clone();
        let peer = answering.clone();
        async move {
            if request.method() == Method::POST {
                let body = request.into_body().collect().await.unwrap().to_bytes();
                heard
                    .lock()
                    .unwrap()
                    .push(serde_json::from_slice(&body).unwrap());
                return Response::new(body::full(r#"{"ok":true}"#));
            }
            let own = Holds {
                from: peer.clone(),
                instance: format!("peer-{}", peer.internal_port),
                op: Op::Set,
                ids: holds.iter().map(|id| (*id).to_owned()).collect(),
            };
            Response::new(body::full(serde_json::to_vec(&own).unwrap()))
        }
    })
    .unwrap();
    FakePeer {
        peer,
        heard,
        _listening: listening,
    }
}

async fn register(
    registry: &Registry,
    id: &str,
) -> (
    intentic_ingress::session::Session,
    watch::Receiver<Option<Close>>,
    tokio::io::DuplexStream,
) {
    let (session, pipe) = idle_session().await;
    let (closing, closed) = watch::channel(None);
    registry.register(
        id,
        Slot::Socket,
        Held {
            session: session.clone(),
            closing,
        },
    );
    (session, closed, pipe)
}

struct World {
    cluster: Arc<Cluster>,
    registry: Arc<Registry>,
    a: FakePeer,
    b: FakePeer,
    moving: watch::Sender<Vec<Peer>>,
}

async fn world(
    a_holds: &'static [&'static str],
    b_holds: &'static [&'static str],
    this: Peer,
    ttl: Duration,
) -> World {
    let (a, b) = (fake_peer(a_holds).await, fake_peer(b_holds).await);
    let (moving, peers) = watch::channel(vec![a.peer.clone(), b.peer.clone()]);
    let registry = Arc::new(Registry::new());
    let cluster = Cluster::new("self", this, peers, registry.clone(), ttl);
    World {
        cluster,
        registry,
        a,
        b,
        moving,
    }
}

#[tokio::test]
async fn an_id_routes_to_the_peer_whose_delta_claimed_it_and_only_a_known_peer_is_heard() {
    let w = world(&[], &[], this(), REMOTE_TTL).await;
    assert_eq!(w.cluster.holder(X), None);
    w.cluster.receive(w.a.from(Op::Add, &[X]));
    assert_eq!(w.cluster.holder(X), Some(w.a.peer.clone()));
    assert_eq!(w.cluster.remote_count(), 1);

    let stranger = Peer {
        host: "stranger".into(),
        port: 8080,
        internal_port: 8081,
    };
    w.cluster.receive(Holds {
        from: stranger,
        instance: "stranger".into(),
        op: Op::Add,
        ids: vec![Y.into()],
    });
    assert_eq!(w.cluster.holder(Y), None);
}

#[tokio::test]
async fn only_the_holder_may_withdraw_an_id_and_forget_drops_a_wrong_one() {
    let w = world(&[], &[], this(), REMOTE_TTL).await;
    w.cluster.receive(w.a.from(Op::Add, &[X]));
    w.cluster.receive(w.b.from(Op::Remove, &[X]));
    assert_eq!(w.cluster.holder(X), Some(w.a.peer.clone()));
    w.cluster.receive(w.a.from(Op::Remove, &[X]));
    assert_eq!(w.cluster.holder(X), None);

    w.cluster.receive(w.a.from(Op::Add, &[Y]));
    w.cluster.forget(Y);
    assert_eq!(w.cluster.holder(Y), None);
}

#[tokio::test]
async fn a_delta_add_displaces_a_local_tunnel_and_a_set_leaves_it_alone() {
    let w = world(&[], &[], this(), REMOTE_TTL).await;
    let (_, closed, _pipe) = register(&w.registry, X).await;
    w.cluster.receive(w.a.from(Op::Add, &[X]));
    let close = closed.borrow().clone().unwrap();
    assert_eq!(close.code, DISPLACED_CODE);
    assert!(
        close
            .reason
            .contains(&format!("peer-{}", w.a.peer.internal_port)),
        "{}",
        close.reason
    );
    assert!(w.registry.lookup(X, Slot::Socket).is_none());
    assert_eq!(w.cluster.holder(X), Some(w.a.peer.clone()));

    let (held, closed, _pipe) = register(&w.registry, Y).await;
    w.cluster.receive(w.a.from(Op::Set, &[Y]));
    assert!(closed.borrow().is_none());
    assert!(w.registry.lookup(Y, Slot::Socket).unwrap().same(&held));
    // A set replaces the peer's entries whole: the X it added before is gone.
    assert_eq!(w.cluster.holder(X), None);
    assert_eq!(w.cluster.holder(Y), Some(w.a.peer.clone()));
}

#[tokio::test]
async fn an_entry_expires_when_its_peer_stops_refreshing_it() {
    let w = world(&[], &[], this(), Duration::from_millis(200)).await;
    w.cluster.receive(w.a.from(Op::Add, &[X]));
    assert_eq!(w.cluster.holder(X), Some(w.a.peer.clone()));
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(w.cluster.holder(X), None);

    w.cluster.receive(w.a.from(Op::Add, &[Y]));
    tokio::time::sleep(Duration::from_millis(250)).await;
    w.cluster.tick().await;
    assert_eq!(w.cluster.remote_count(), 0);
}

#[tokio::test]
async fn every_peer_hears_a_local_arrival_and_departure_and_a_tick_pushes_the_whole_list() {
    let w = world(&[], &[], this(), REMOTE_TTL).await;
    let (session, _, _pipe) = register(&w.registry, X).await;
    w.registry.unregister(X, Slot::Socket, &session);
    wait_for("both peers to hear both changes", || {
        w.a.heard().len() == 2 && w.b.heard().len() == 2
    })
    .await;
    for peer in [&w.a, &w.b] {
        let mut heard = peer.heard();
        heard.sort_by_key(|(op, _)| format!("{op:?}"));
        assert_eq!(
            heard,
            [
                (Op::Add, vec![X.to_owned()]),
                (Op::Remove, vec![X.to_owned()])
            ]
        );
    }
    assert_eq!(w.a.heard.lock().unwrap()[0].from, this());

    let (_x, _, _pipe_x) = register(&w.registry, X).await;
    let (_y, _, _pipe_y) = register(&w.registry, Y).await;
    wait_for("the arrivals to be heard", || {
        w.a.heard().len() == 4 && w.b.heard().len() == 4
    })
    .await;
    w.cluster.tick().await;
    for peer in [&w.a, &w.b] {
        assert_eq!(
            peer.heard().last().unwrap(),
            &(Op::Set, vec![X.to_owned(), Y.to_owned()])
        );
    }
}

#[tokio::test]
async fn the_peers_it_starts_with_are_greeted_both_ways() {
    let w = world(&[X], &[Y], this(), REMOTE_TTL).await;
    w.cluster.start(Duration::from_secs(3600));
    wait_for("both peers' holds", || {
        w.cluster.holder(X).is_some() && w.cluster.holder(Y).is_some()
    })
    .await;
    assert_eq!(w.cluster.holder(X), Some(w.a.peer.clone()));
    assert_eq!(w.cluster.holder(Y), Some(w.b.peer.clone()));
    wait_for("both peers to hear this machine", || {
        w.a.heard().len() == 1 && w.b.heard().len() == 1
    })
    .await;
    assert_eq!(w.a.heard()[0].0, Op::Set);
}

#[tokio::test]
async fn a_machine_discovery_adds_is_greeted_and_one_it_removes_takes_its_entries_along() {
    let w = world(&[], &[Y], this(), REMOTE_TTL).await;
    w.moving.send_replace(vec![w.a.peer.clone()]);
    w.cluster.start(Duration::from_secs(3600));
    wait_for("the first greeting", || w.a.heard().len() == 1).await;
    w.cluster.receive(w.a.from(Op::Add, &[X]));

    w.moving
        .send_replace(vec![w.a.peer.clone(), w.b.peer.clone()]);
    wait_for("the new machine's holds", || w.cluster.holder(Y).is_some()).await;
    wait_for("the new machine to hear this one", || {
        w.b.heard().len() == 1
    })
    .await;
    assert_eq!(w.a.heard().len(), 1);

    w.moving.send_replace(vec![w.b.peer.clone()]);
    wait_for("the departed machine's entries to go", || {
        w.cluster.holder(X).is_none()
    })
    .await;
    assert_eq!(w.cluster.holder(Y), Some(w.b.peer.clone()));
}

#[tokio::test]
async fn a_machine_with_no_address_of_its_own_receives_but_never_advertises() {
    let mut nameless = this();
    nameless.host = String::new();
    let w = world(&[], &[], nameless, REMOTE_TTL).await;
    let (_, _, _pipe) = register(&w.registry, X).await;
    w.cluster.receive(w.a.from(Op::Add, &[Y]));
    w.cluster.tick().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(w.a.heard().is_empty() && w.b.heard().is_empty());
    assert_eq!(w.cluster.holder(Y), Some(w.a.peer.clone()));
}

#[tokio::test]
async fn it_says_and_hears_nothing_after_close() {
    let w = world(&[], &[], this(), REMOTE_TTL).await;
    w.cluster.receive(w.a.from(Op::Add, &[X]));
    w.cluster.close();
    let (_, _, _pipe) = register(&w.registry, Y).await;
    w.cluster.tick().await;
    w.cluster.receive(w.a.from(Op::Add, &[Y]));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(w.cluster.holder(X), None);
    assert_eq!(w.cluster.holder(Y), None);
    assert!(w.a.heard().is_empty());
}

#[tokio::test]
async fn the_internal_surface_answers_its_holds_and_refuses_anything_malformed() {
    let w = world(&[], &[], this(), REMOTE_TTL).await;
    let (_, _, _pipe) = register(&w.registry, X).await;
    let surface = w.cluster.clone();
    let listening = serve::listen("127.0.0.1:0", move |request, _| {
        cluster::internal(surface.clone(), request)
    })
    .await
    .unwrap();
    let port = listening.address.port();
    let post = |body: &'static str| {
        send(
            port,
            Method::POST,
            "internal",
            HOLDS_PATH,
            &[("content-type", "application/json")],
            Bytes::from_static(body.as_bytes()),
        )
    };

    let own: Holds = serde_json::from_str(&get(port, "internal", HOLDS_PATH).await.body).unwrap();
    assert_eq!(
        own,
        Holds {
            from: this(),
            instance: "self".into(),
            op: Op::Set,
            ids: vec![X.into()]
        }
    );

    let valid = serde_json::to_string(&w.a.from(Op::Add, &[Y])).unwrap();
    let answer = send(
        port,
        Method::POST,
        "internal",
        HOLDS_PATH,
        &[],
        Bytes::from(valid),
    )
    .await;
    assert_eq!(answer.status, 200);
    assert_eq!(w.cluster.holder(Y), Some(w.a.peer.clone()));
    assert_eq!(post("not json").await.status, 400);
    assert_eq!(post(r#"{"op":"add"}"#).await.status, 400);
    assert_eq!(
        post(r#"{"from":{"host":"127.0.0.1","port":1,"internalPort":2},"instance":"a","op":"add","ids":["not-an-id"]}"#).await.status,
        400
    );
    assert_eq!(
        send(port, Method::PUT, "internal", HOLDS_PATH, &[], Bytes::new())
            .await
            .status,
        405
    );
    assert_eq!(get(port, "internal", "/tunnel/v1").await.status, 404);
    assert_eq!(get(port, "internal", "/health").await.status, 200);
}

// Two machines behind one address, one sandbox, the request landing on the wrong one: nothing faked but the sandbox.
struct Machine {
    this: Peer,
    edge: Arc<Edge>,
    cluster: Arc<Cluster>,
    moving: watch::Sender<Vec<Peer>>,
    _public: Listening,
    _internal: Listening,
}

async fn machine(name: &str, keys: &Keys) -> Machine {
    let public = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let internal = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let this = Peer {
        host: "127.0.0.1".into(),
        port: public.local_addr().unwrap().port(),
        internal_port: internal.local_addr().unwrap().port(),
    };
    let (moving, peers) = watch::channel(Vec::new());
    let registry = Arc::new(Registry::new());
    let cluster = Cluster::new(
        name,
        this.clone(),
        peers.clone(),
        registry.clone(),
        REMOTE_TTL,
    );
    cluster.start(Duration::from_secs(3600));
    let surface = cluster.clone();
    let internal = serve::serve_on(internal, move |request, _| {
        cluster::internal(surface.clone(), request)
    })
    .unwrap();
    let edge = Edge::new(EdgeOptions {
        key: keys.key(),
        revocation: Revocation::new(""),
        registry,
        cluster: Some(cluster.clone()),
        peers: Some(peers),
        instance: name.into(),
        hosted_app_prefix: None,
        build: String::new(),
        transports: Vec::new(),
    });
    let serving = edge.clone();
    let public = serve::serve_on(public, move |request, remote| {
        serving
            .clone()
            .handle(request.map(body::incoming), remote, Via::Proxy)
    })
    .unwrap();
    Machine {
        this,
        edge,
        cluster,
        moving,
        _public: public,
        _internal: internal,
    }
}

async fn pair(keys: &Keys) -> (Machine, Machine) {
    let (a, b) = (machine("a", keys).await, machine("b", keys).await);
    a.moving.send_replace(vec![b.this.clone()]);
    b.moving.send_replace(vec![a.this.clone()]);
    (a, b)
}

#[tokio::test]
async fn the_machine_not_dialled_learns_the_holder_and_hands_it_every_kind_of_request() {
    let keys = Keys::default();
    let (a, b) = pair(&keys).await;
    let sandbox = dial(a.this.port, &keys.grant(SANDBOX_ID), serving("served"))
        .await
        .unwrap();
    wait_for("b to learn the holder", || {
        b.cluster.holder(SANDBOX_ID).is_some()
    })
    .await;
    assert_eq!(b.cluster.holder(SANDBOX_ID), Some(a.this.clone()));
    assert_eq!(a.edge.registry().ids(), [SANDBOX_ID]);
    assert!(b.edge.registry().ids().is_empty());

    let answer = get(b.this.port, &daemon_host(SANDBOX_ID), "/health").await;
    assert_eq!(
        (answer.status, answer.body),
        (200, format!("served sandbox-{SANDBOX_ID}.{ZONE}/health"))
    );
    let seen = sandbox.last_seen();
    assert!(
        seen.get(HOP_HEADER).is_none(),
        "the hop mark reached the sandbox"
    );
    assert_eq!(seen["x-forwarded-for"], "127.0.0.1");
    let preview = get(
        b.this.port,
        &format!("preview-web-{SANDBOX_ID}.{ZONE}"),
        "/",
    )
    .await;
    assert_eq!(
        preview.body,
        format!("served preview-web-{SANDBOX_ID}.{ZONE}/")
    );

    let (head, mut socket) = upgrade(b.this.port, &daemon_host(SANDBOX_ID), "/ws", "echo").await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    socket.write_all(b"ping").await.unwrap();
    let mut echoed = [0_u8; 4];
    socket.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");
    assert!(sandbox.last_seen().get(HOP_HEADER).is_none());

    let health = |port| async move {
        serde_json::from_str::<serde_json::Value>(
            &get(port, &format!("ingress.{ZONE}"), "/health").await.body,
        )
        .unwrap()
    };
    let (health_a, health_b) = (health(a.this.port).await, health(b.this.port).await);
    assert_eq!(
        (
            health_a["instance"].as_str(),
            health_a["tunnels"].as_u64(),
            health_a["peers"].as_u64(),
            health_a["remote"].as_u64()
        ),
        (Some("a"), Some(1), Some(1), Some(0))
    );
    assert_eq!(
        (
            health_b["instance"].as_str(),
            health_b["tunnels"].as_u64(),
            health_b["peers"].as_u64(),
            health_b["remote"].as_u64()
        ),
        (Some("b"), Some(0), Some(1), Some(1))
    );
}

// A second hop would be how a forwarding loop starts; a peer that answered no keeps its entry, one that is gone loses it.
#[tokio::test]
async fn a_miss_is_final_once_hop_marked_and_a_holder_is_forgotten_only_when_unreachable() {
    const NOBODY_ID: &str = "0123456789ab";
    const GHOST_ID: &str = "feedfacecafe";
    let keys = Keys::default();
    let (a, b) = pair(&keys).await;
    b.cluster.receive(Holds {
        from: a.this.clone(),
        instance: "a".into(),
        op: Op::Add,
        ids: vec![NOBODY_ID.into()],
    });

    let marked = send(
        b.this.port,
        Method::GET,
        &daemon_host(NOBODY_ID),
        "/",
        &[(HOP_HEADER, "1")],
        Bytes::new(),
    )
    .await;
    assert_eq!(marked.status, 502);
    assert!(marked.body.contains(&format!("sandbox-{NOBODY_ID}")));
    let stale = get(b.this.port, &daemon_host(NOBODY_ID), "/").await;
    assert_eq!(stale.status, 502);
    assert_eq!(b.cluster.holder(NOBODY_ID), Some(a.this.clone()));

    let ghost = Peer {
        host: "127.0.0.1".into(),
        port: 1,
        internal_port: 1,
    };
    b.moving.send_replace(vec![a.this.clone(), ghost.clone()]);
    b.cluster.receive(Holds {
        from: ghost.clone(),
        instance: "ghost".into(),
        op: Op::Add,
        ids: vec![GHOST_ID.into()],
    });
    assert_eq!(b.cluster.holder(GHOST_ID), Some(ghost));
    assert_eq!(
        get(b.this.port, &daemon_host(GHOST_ID), "/").await.status,
        502
    );
    assert_eq!(b.cluster.holder(GHOST_ID), None);
}

// The displaced tunnel learns it was replaced rather than dropped; the newest registration wins on either machine.
#[tokio::test]
async fn a_redial_on_the_other_machine_displaces_the_first_which_then_forwards() {
    let keys = Keys::default();
    let (a, b) = pair(&keys).await;
    let first = dial(a.this.port, &keys.grant(SANDBOX_ID), serving("first"))
        .await
        .unwrap();
    wait_for("b to learn a holds it", || {
        b.cluster.holder(SANDBOX_ID).is_some()
    })
    .await;
    let _second = dial(b.this.port, &keys.grant(SANDBOX_ID), serving("second"))
        .await
        .unwrap();
    assert_eq!(
        first.ended.await.unwrap(),
        Ended::Closed(Some(DISPLACED_CODE))
    );
    wait_for("a to forward to b", || {
        a.edge.registry().ids().is_empty() && a.cluster.holder(SANDBOX_ID).is_some()
    })
    .await;
    assert_eq!(a.cluster.holder(SANDBOX_ID), Some(b.this.clone()));
    let answer = get(a.this.port, &daemon_host(SANDBOX_ID), "/moved").await;
    assert_eq!(
        (answer.status, answer.body),
        (200, format!("second sandbox-{SANDBOX_ID}.{ZONE}/moved"))
    );
    let _ = StatusCode::OK;
}
