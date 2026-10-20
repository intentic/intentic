//! The functions `dev.intentic.bridgebench.Jni` binds by name, written with the `jni` crate as `_editor/mobile-core`'s
//! bridge is. `echo` reads its argument with `get_string_unchecked`, which the Kotlin signature makes sound;
//! `echoChecked` with `get_string`, as mobile-core's bridge does today, which looks `java.lang.String` up by
//! `FindClass` and checks the argument's class on every call.

use jni::JNIEnv;
use jni::objects::{JByteArray, JClass, JString};
use jni::strings::JavaStr;
use jni::sys::{jbyteArray, jstring};
use std::borrow::Cow;
use std::ptr;

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_bridgebench_Jni_noop(_env: JNIEnv, _class: JClass) {}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_bridgebench_Jni_echo<'local>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
    request: JString<'local>,
) -> jstring {
    // SAFETY: the Kotlin signature only passes a java.lang.String.
    let Ok(request) = (unsafe { env.get_string_unchecked(&request) }) else {
        return ptr::null_mut();
    };
    answer(&env, &request)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_bridgebench_Jni_echoChecked<'local>(
    mut env: JNIEnv<'local>,
    _class: JClass<'local>,
    request: JString<'local>,
) -> jstring {
    let Ok(request) = env.get_string(&request) else {
        return ptr::null_mut();
    };
    answer(&env, &request)
}

fn answer(env: &JNIEnv, request: &JavaStr) -> jstring {
    let request: Cow<str> = request.into();
    env.new_string(crate::echo(&request))
        .map_or(ptr::null_mut(), |reply| reply.into_raw())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_intentic_bridgebench_Jni_bytes<'local>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
    input: JByteArray<'local>,
) -> jbyteArray {
    let Ok(input) = env.convert_byte_array(&input) else {
        return ptr::null_mut();
    };
    env.byte_array_from_slice(&crate::bytes(&input))
        .map_or(ptr::null_mut(), |out| out.into_raw())
}
