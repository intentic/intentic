//! Waking a thread that waits on the platform: the capture thread waits for damage (an X connection's socket, a DXGI
//! thread's own wake) and for the hub (acks, joins, keyframe requests) at once. A pipe on Unix, an event on Windows
//! (voxl's scheme), so either can be waited on beside the platform's own descriptors or handles.

/// Something `wait_any` can wait for: a file descriptor on Unix, a handle on Windows.
#[cfg(unix)]
pub type Waitable<'a> = std::os::fd::BorrowedFd<'a>;
#[cfg(windows)]
pub type Waitable<'a> = std::os::windows::io::BorrowedHandle<'a>;

/// A non-blocking, close-on-exec pipe for waking a thread that polls file descriptors.
#[cfg(unix)]
pub fn wake_pipe() -> nix::Result<(std::os::fd::OwnedFd, std::os::fd::OwnedFd)> {
    nix::unistd::pipe2(nix::fcntl::OFlag::O_NONBLOCK | nix::fcntl::OFlag::O_CLOEXEC)
}

/// Wakes a thread blocked in `wait_any`.
pub struct Wake {
    #[cfg(unix)]
    r: std::os::fd::OwnedFd,
    #[cfg(unix)]
    w: std::os::fd::OwnedFd,
    /// Manual reset: signalled until drained, however many wakes came in between.
    #[cfg(windows)]
    event: std::os::windows::io::OwnedHandle,
}

impl Wake {
    #[cfg(unix)]
    pub fn new() -> std::io::Result<Self> {
        let (r, w) = wake_pipe()?;
        Ok(Wake { r, w })
    }

    #[cfg(windows)]
    pub fn new() -> std::io::Result<Self> {
        use std::os::windows::io::FromRawHandle;
        // SAFETY: no attributes and no name; the handle is checked before it is owned.
        let h = unsafe {
            windows_sys::Win32::System::Threading::CreateEventW(
                std::ptr::null(),
                1,
                0,
                std::ptr::null(),
            )
        };
        if h.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: a handle CreateEventW just returned, owned by nothing else.
        Ok(Wake {
            event: unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(h) },
        })
    }

    pub fn signal(&self) {
        #[cfg(unix)]
        let _ = nix::unistd::write(&self.w, &[1u8]);
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            // SAFETY: the event this Wake owns.
            unsafe { windows_sys::Win32::System::Threading::SetEvent(self.event.as_raw_handle()) };
        }
    }

    pub fn drain(&self) {
        #[cfg(unix)]
        {
            let mut buf = [0u8; 64];
            while matches!(nix::unistd::read(&self.r, &mut buf), Ok(n) if n > 0) {}
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            // SAFETY: the event this Wake owns.
            unsafe {
                windows_sys::Win32::System::Threading::ResetEvent(self.event.as_raw_handle())
            };
        }
    }

    pub fn waitable(&self) -> Waitable<'_> {
        #[cfg(unix)]
        return std::os::fd::AsFd::as_fd(&self.r);
        #[cfg(windows)]
        return std::os::windows::io::AsHandle::as_handle(&self.event);
    }
}

/// Blocks until one of `w` is ready or `timeout_ms` passes (negative: no timeout).
pub fn wait_any(w: &[Waitable], timeout_ms: i32) {
    #[cfg(unix)]
    {
        use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
        let mut p: Vec<PollFd> = w
            .iter()
            .map(|&fd| PollFd::new(fd, PollFlags::POLLIN))
            .collect();
        let _ = poll(
            &mut p,
            PollTimeout::try_from(timeout_ms).unwrap_or(PollTimeout::NONE),
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        let hs: Vec<_> = w.iter().map(|h| h.as_raw_handle()).collect();
        let ms = if timeout_ms < 0 {
            windows_sys::Win32::System::Threading::INFINITE
        } else {
            timeout_ms as u32
        };
        if hs.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(u64::from(ms)));
            return;
        }
        // SAFETY: borrowed handles, alive for the call.
        unsafe {
            windows_sys::Win32::System::Threading::WaitForMultipleObjects(
                hs.len() as u32,
                hs.as_ptr(),
                0,
                ms,
            )
        };
    }
}

/// CPU time this thread has used, in microseconds (0 where the platform will not say).
pub fn thread_cpu_us() -> i64 {
    #[cfg(unix)]
    {
        use nix::time::{ClockId, clock_gettime};
        clock_gettime(ClockId::CLOCK_THREAD_CPUTIME_ID)
            .map(|t| t.tv_sec() * 1_000_000 + t.tv_nsec() / 1000)
            .unwrap_or(0)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::{GetCurrentThread, GetThreadTimes};
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut c, mut e, mut k, mut u) = (zero, zero, zero, zero);
        let ft = |f: FILETIME| ((f.dwHighDateTime as i64) << 32 | f.dwLowDateTime as i64) / 10;
        // SAFETY: the current thread's pseudo-handle and four FILETIMEs to fill.
        match unsafe { GetThreadTimes(GetCurrentThread(), &mut c, &mut e, &mut k, &mut u) } {
            0 => 0,
            _ => ft(k) + ft(u),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn a_signal_wakes_a_wait_and_a_drain_rearms_it() {
        let wake = Wake::new().unwrap();
        let t = Instant::now();
        wait_any(&[wake.waitable()], 30);
        assert!(
            t.elapsed() >= Duration::from_millis(25),
            "returned with nothing signalled"
        );
        wake.signal();
        wake.signal();
        let t = Instant::now();
        wait_any(&[wake.waitable()], 5_000);
        assert!(
            t.elapsed() < Duration::from_secs(2),
            "a signal did not wake the wait"
        );
        wake.drain();
        let t = Instant::now();
        wait_any(&[wake.waitable()], 30);
        assert!(
            t.elapsed() >= Duration::from_millis(25),
            "a drained wake still woke"
        );
    }

    #[test]
    fn a_signal_from_another_thread_wakes_the_waiter() {
        let wake = std::sync::Arc::new(Wake::new().unwrap());
        let other = wake.clone();
        let t = Instant::now();
        let h = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            other.signal();
        });
        wait_any(&[wake.waitable()], 10_000);
        assert!(t.elapsed() < Duration::from_secs(5));
        h.join().unwrap();
    }
}
