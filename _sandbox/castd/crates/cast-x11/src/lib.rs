//! cast-x11: cast-core's platform on an X display, castd's (voxl's X11 backend, MIT, v0.4.0 at 21f194f). Capture with
//! XDamage (in place from Xvfb's `-shmem` framebuffer, else MIT-SHM or plain GetImage on any X server), RandR resizing
//! with window fitting, XTEST input with DOM keys mapped to keysyms, and the cursor and clipboard through XFixes and
//! selections.

pub mod capture;
pub mod desktop;
pub mod input;
pub mod keys;
mod keysym_table;
pub mod screen;

pub use capture::X11Screen;
