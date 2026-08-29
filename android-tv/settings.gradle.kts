pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Cache local de secours (AAR pré-téléchargés à la main quand
        // maven.mozilla.org est instable) : MBOLO_MVN_LOCAL pointe vers un
        // dépôt Maven plat. Non défini en CI → aucun effet.
        maven { url = uri(System.getenv("MBOLO_MVN_LOCAL") ?: "file:///nonexistent-mbolo-local-mvn") }
        // GeckoView (moteur de secours pour les box AOSP sans WebView récente)
        maven { url = uri("https://maven.mozilla.org/maven2") }
    }
}

rootProject.name = "mbolo-tv-android-tv"
include(":app")
