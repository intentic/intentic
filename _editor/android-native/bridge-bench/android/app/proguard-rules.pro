# The JNI functions are bound by name: R8 keeps the class and its native methods as written.
-keep class dev.intentic.bridgebench.Jni { native <methods>; }

# JNA binds a method to the C function of its name, reads structs' fields by reflection, and libjnidispatch calls back
# into JNA's own classes by name: JNA's own rules, as a UniFFI app on Android ships them.
-dontwarn java.awt.**
-keepattributes RuntimeVisibleAnnotations
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.Library { *; }
-keep class * extends com.sun.jna.Structure { *; }
-keep class dev.intentic.bridgebench.JnaDirectLib { *; }
-keep class dev.intentic.bridgebench.IntegrityCheckingUniffiLib { *; }
-keep class dev.intentic.bridgebench.UniffiLib { *; }
