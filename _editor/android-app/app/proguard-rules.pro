# The core binds Core's native methods (start, call, rowCount, row, card, pageId) by JNI name, and calls Listener.onEvent by
# name from its event thread: R8 must keep both as written, in every class that implements the listener.
-keep class dev.intentic.app.core.Core { native <methods>; }
-keep interface dev.intentic.app.core.Core$Listener { *; }
-keepclassmembers class * implements dev.intentic.app.core.Core$Listener { void onEvent(java.lang.String); }
# Credential Manager finds its Play services provider by reflection; Google's integration guide asks for this rule.
-if class androidx.credentials.CredentialManager
-keep class androidx.credentials.playservices.** { *; }
# kotlinx.serialization and AndroidX ship their own consumer rules.
