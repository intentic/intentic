use std::fs::{self, File};
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::wl_registry;
use wayland_client::{delegate_noop, Connection, Dispatch, EventQueue, QueueHandle};
use wayland_protocols::wp::security_context::v1::client::{
    wp_security_context_manager_v1::WpSecurityContextManagerV1,
    wp_security_context_v1::WpSecurityContextV1,
};

use super::Sandbox;
use crate::util::{Fail, Result};

struct State;
impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
delegate_noop!(State: ignore WpSecurityContextManagerV1);
delegate_noop!(State: ignore WpSecurityContextV1);

pub(super) struct Compositor {
    queue: EventQueue<State>,
    manager: WpSecurityContextManagerV1,
}

impl Compositor {
    pub fn connect() -> Result<Self> {
        let connection = Connection::connect_to_env().map_err(|err| {
            Fail(format!(
            "The screen service could not connect to sway: {err}. Start it from the sway session."
        ))
        })?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> Result<Self> {
        let (globals, queue) = registry_queue_init::<State>(&connection)
            .map_err(|err| Fail(format!("Could not read sway's Wayland globals: {err}.")))?;
        let manager = globals.bind(&queue.handle(), 1..=1, ()).map_err(|_| Fail(
            "This compositor has no Wayland security-context-v1 support. Sandbox windows are unavailable; the unrestricted display will not be shared.".into()
        ))?;
        Ok(Self { queue, manager })
    }

    pub fn sync(&mut self) -> Result<()> {
        self.queue.roundtrip(&mut State).map(|_| ()).map_err(|err| {
            Fail(format!(
                "The screen service lost its connection to sway: {err}."
            ))
        })
    }

    pub fn listen(&mut self, directory: &Path, sandbox: &Sandbox) -> Result<Listener> {
        let path = directory.join("wayland-0");
        match fs::remove_file(&path) {
            Ok(()) => (),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => (),
            Err(err) => {
                return Err(Fail(format!(
                    "Could not replace {}: {err}.",
                    path.display()
                )))
            }
        }
        // Slugs may be 128 bytes, longer than sockaddr_un permits with the host's directory prefix. Linux resolves
        // this short directory-fd path to the same socket inode. The container connects through its short mount path.
        let folder = File::open(directory).map_err(|err| Fail(err.to_string()))?;
        let bind_path = format!("/proc/self/fd/{}/wayland-0", folder.as_raw_fd());
        let listener = UnixListener::bind(bind_path)
            .map_err(|err| Fail(format!("Could not listen at {}: {err}.", path.display())))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| Fail(err.to_string()))?;
        // A socketpair supplies the protocol's close fd: sway watches the read endpoint for HUP. Only we hold its
        // peer, so stopping a sandbox, a crash or a killed service all revoke acceptance without another request.
        let (close, held) = UnixStream::pair().map_err(|err| Fail(err.to_string()))?;
        let lifetime = Listener { path, _close: held };
        let context =
            self.manager
                .create_listener(listener.as_fd(), close.as_fd(), &self.queue.handle(), ());
        context.set_sandbox_engine("dev.intentic.sandbox".into());
        context.set_app_id(sandbox.slug.clone());
        context.set_instance_id(sandbox.id.clone());
        context.commit();
        context.destroy();
        self.sync()?;
        // Keep no copy of the listening fd: once sway dies, a leftover file must refuse new connections.
        Ok(lifetime)
    }
}

pub(super) struct Listener {
    path: PathBuf,
    _close: UnixStream,
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "needs a running compositor with security-context-v1 and WAYLAND_DISPLAY"]
    fn real_compositor_restricts_clients_and_revokes_acceptance() {
        let mut compositor = Compositor::connect().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let sandbox = Sandbox {
            slug: "screen-test".into(),
            id: "container-id".into(),
        };
        let listener = compositor.listen(dir.path(), &sandbox).unwrap();
        let path = dir.path().join("wayland-0");
        let alias = dir.path().join("alias");
        fs::hard_link(&path, &alias).unwrap();
        let connection = Connection::from_socket(UnixStream::connect(&path).unwrap()).unwrap();
        let (globals, mut queue) = registry_queue_init::<State>(&connection).unwrap();
        let names: Vec<String> = globals
            .contents()
            .clone_list()
            .into_iter()
            .map(|global| global.interface)
            .collect();
        assert!(names.iter().any(|name| name == "wl_compositor"));
        for forbidden in [
            "wp_security_context_manager_v1",
            "zwlr_screencopy_manager_v1",
            "zwlr_layer_shell_v1",
            "zwp_virtual_keyboard_manager_v1",
            "zwlr_virtual_pointer_manager_v1",
        ] {
            assert!(
                !names.iter().any(|name| name == forbidden),
                "{forbidden} leaked"
            );
        }
        // A nested security context must fail plainly, with no unrestricted-display fallback.
        let nested = Connection::from_socket(UnixStream::connect(&path).unwrap()).unwrap();
        assert!(Compositor::from_connection(nested)
            .err()
            .unwrap()
            .0
            .contains("no Wayland security-context-v1"));
        drop(listener);
        compositor.sync().unwrap();
        // The alias preserves the socket inode, so this proves fd revocation, not just removal of its pathname.
        assert!(UnixStream::connect(&alias).is_err());
        // The protocol stops accepting new clients; it does not kill clients already connected.
        queue.roundtrip(&mut State).unwrap();
        let replacement = compositor.listen(dir.path(), &sandbox).unwrap();
        fs::remove_file(&path).unwrap();
        drop(replacement);
        let repaired = compositor.listen(dir.path(), &sandbox).unwrap();
        let repaired_client = Connection::from_socket(UnixStream::connect(&path).unwrap()).unwrap();
        registry_queue_init::<State>(&repaired_client).unwrap();
        drop(repaired);

        let long_folder = dir.path().join("s".repeat(128));
        fs::create_dir(&long_folder).unwrap();
        let long = compositor.listen(&long_folder, &sandbox).unwrap();
        let folder = File::open(&long_folder).unwrap();
        let short_path = format!("/proc/self/fd/{}/wayland-0", folder.as_raw_fd());
        let client = Connection::from_socket(UnixStream::connect(short_path).unwrap()).unwrap();
        registry_queue_init::<State>(&client).unwrap();
        drop(long);
    }
}
