# Pont JS : les méthodes @JavascriptInterface sont appelées par réflexion
# depuis le JS de la page — R8 ne doit pas les supprimer ni les renommer.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
