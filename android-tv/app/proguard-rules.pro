# Pont JS : les méthodes @JavascriptInterface sont appelées par réflexion
# depuis le JS de la page — R8 ne doit pas les supprimer ni les renommer.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# GeckoView embarque ses règles consumer, mais on garde ce keep défensif :
# le moteur est appelé via JNI depuis les libs natives libxul/libmozglue.
-keep class org.mozilla.geckoview.** { *; }

# snakeyaml (dépendance embarquée de l'AAR GeckoView) référence java.beans.*,
# absent d'Android — code jamais exécuté sur l'appareil, warning seulement.
-dontwarn java.beans.BeanInfo
-dontwarn java.beans.FeatureDescriptor
-dontwarn java.beans.IntrospectionException
-dontwarn java.beans.Introspector
-dontwarn java.beans.PropertyDescriptor
