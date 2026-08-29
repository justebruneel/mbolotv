# Pont JS : les méthodes @JavascriptInterface sont appelées par réflexion
# depuis le JS de la page — R8 ne doit pas les supprimer ni les renommer.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# GeckoView embarque ses règles consumer, mais on garde ce keep défensif :
# le moteur est appelé via JNI depuis les libs natives libxul/libmozglue.
-keep class org.mozilla.geckoview.** { *; }
