//! cast-win-dupcheck: tries desktop duplication of every output under every adapter that lists it, and says what each
//! answered. For finding out why a monitor will not duplicate.

#[cfg(windows)]
fn main() {
    use windows::Win32::Graphics::Dxgi::*;
    use windows::core::Interface;
    cast_win::init_process();
    if std::env::args().any(|a| a == "--wake") {
        cast_win::keep_display_on();
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.unwrap();
    let mut a = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(a) } {
        a += 1;
        let desc = unsafe { adapter.GetDesc1() }.unwrap();
        let name = cast_win::displays::from_wide(&desc.Description);
        let info = cast_win::displays::adapters()
            .into_iter()
            .find(|x| x.name == name);
        let mut o = 0;
        while let Ok(output) = unsafe { adapter.EnumOutputs(o) } {
            o += 1;
            let od = unsafe { output.GetDesc() }.unwrap();
            let gdi = cast_win::displays::from_wide(&od.DeviceName);
            let result = match info.as_ref().map(cast_win::d3d::Device::new) {
                Some(Ok(dev)) => {
                    let o1: IDXGIOutput1 = output.cast().unwrap();
                    match unsafe { o1.DuplicateOutput(&dev.device) } {
                        Ok(_) => "duplicated".to_string(),
                        Err(e) => format!("{e}"),
                    }
                }
                Some(Err(e)) => e,
                None => "no adapter info".into(),
            };
            println!(
                "{name} | {gdi} attached={} | {result}",
                od.AttachedToDesktop.as_bool()
            );
        }
    }
}

#[cfg(not(windows))]
fn main() {}
