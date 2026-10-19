# Core's functions are bound by JNI name: R8 must keep the class and its native methods as written.
-keep class dev.intentic.spike.Core { native <methods>; }
# Arm C's renderer (core/src/surface), bound the same way.
-keep class dev.intentic.spike.SurfaceCore { native <methods>; }
