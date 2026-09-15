plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "tv.mbolo.app"
    // compileSdk 35 requis par Media3 1.8 (targetSdk reste 34 : aucun changement
    // de comportement runtime, minSdk 23 inchangé pour les vieilles box).
    compileSdk = 35

    defaultConfig {
        applicationId = "tv.mbolo.app"
        minSdk = 23
        targetSdk = 34
        versionCode = 3
        versionName = "1.1.0"

        // Site embarqué à la compilation : modifiable ici sans toucher au code.
        buildConfigField("String", "MBOLTV_URL", "\"https://mbolotv-web.vercel.app\"")
        // API Mbolo consommée directement par l'UI native (Phase 5 : plus de
        // WebView pour l'interface principale). Inclut le suffixe /api.
        buildConfigField("String", "MBOLO_API_URL", "\"https://mbolo-tv-api.mbolo-tv-video-proxy.workers.dev/api\"")
    }

    // Keystore injecté par la CI (secret ANDROID_KEYSTORE via env) — sans ces
    // variables, builds locaux non signés. Le mot de passe ne traverse jamais
    // le build s'il n'est pas présent.
    if (System.getenv("MBOLO_KEYSTORE") != null) {
        signingConfigs.create("release") {
            storeFile = file(System.getenv("MBOLO_KEYSTORE")!!)
            storePassword = System.getenv("MBOLO_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("MBOLO_KEY_ALIAS")
            keyPassword = System.getenv("MBOLO_KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            // R8 + resource shrinking : APK minimal (~80 Ko), l'app n'embarque
            // qu'un WebView wrapper et ses deux écrans natifs.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (System.getenv("MBOLO_KEYSTORE") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        // UnsafeOptInUsageError est un faux positif avec AGP 8.5.2 + Kotlin 2.0 :
        // les usages @UnstableApi sont confinés à core/PlayerController.kt
        // (annoté @OptIn + flag -opt-in), le compilateur les valide (assemble OK).
        disable += "UnsafeOptInUsageError"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
        // Media3 déclare ses factories en @UnstableApi : opt-in module assumé
        // (PlayerController centralise tous les usages, annoté @OptIn).
        freeCompilerArgs += "-opt-in=androidx.media3.common.util.UnstableApi"
    }
}

dependencies {
    // Seule dépendance : insets/window compat (barres système) sur API 23+.
    // Pas d'AppCompat ni Material : thème plateforme + layouts XML purs.
    implementation("androidx.core:core-ktx:1.13.1")

    // ---- Phase 5 : UI native (Views + RecyclerView, pas de Compose en v1) ----
    // Versions épinglées : compatibles minSdk 23, vérifiées dans le cache local.
    implementation("androidx.recyclerview:recyclerview:1.3.1")
    implementation("androidx.activity:activity:1.8.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // Réseau natif : OkHttp direct vers l'API Mbolo (pas de WebView).
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Player natif : Media3/ExoPlayer (HLS + MP4 + TS progressif).
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-exoplayer-hls:1.8.0")
    implementation("androidx.media3:media3-ui:1.8.0")
    // Images : Coil 3, redimensionnées au composant + caches bornés.
    // coil-network-okhttp a été retiré (jamais utilisé : l'ImageLoader par
    // défaut de coil3 en Android se connecte via HttpURLConnection et on ne
    // passe pas d'OkHttp — 1 dépendance en moins sur les box 1 Go).
    implementation("io.coil-kt.coil3:coil:3.0.4")

    testImplementation("junit:junit:4.13.2")
    // org.json réel pour les tests JVM (android.jar ne fournit que des stubs).
    testImplementation("org.json:json:20240303")
}
