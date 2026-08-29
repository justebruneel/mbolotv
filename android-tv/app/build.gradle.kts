plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "tv.mbolo.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "tv.mbolo.tv"
        minSdk = 23
        targetSdk = 34
        versionCode = 3
        versionName = "1.1.0"

        // Site embarqué à la compilation : modifiable ici sans toucher au code.
        buildConfigField("String", "MBOLTV_URL", "\"https://mbolotv-web.vercel.app\"")
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

    // Un flavor par ABI : GeckoView ne publie qu'un artefact par architecture
    // (l'artefact universel pèse 600 Mo en debug). Les box TV réelles sont
    // arm64 (récentes) ou arm32 (vieilles box AOSP, celles justement sans
    // WebView à jour) ; x86 n'existe quasiment pas sur le terrain.
    flavorDimensions += "abi"
    productFlavors {
        create("arm64") {
            dimension = "abi"
            ndk { abiFilters += "arm64-v8a" }
        }
        create("arm32") {
            dimension = "abi"
            ndk { abiFilters += "armeabi-v7a" }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Seule dépendance : insets/window compat (barres système) sur API 23+.
    // Pas d'AppCompat ni Material : thème plateforme + layouts XML purs.
    implementation("androidx.core:core-ktx:1.13.1")

    // GeckoView = moteur Firefox autonome, utilisé en secours quand la box
    // n'a pas de provider WebView ou une version trop vieille pour le site
    // (box AOSP fréquentes). Dépendance par flavor : une seule ABI embarquée,
    // pas de conflit de capability Gradle.
    // 129 = dernière version exigeant compileSdk 34 (AGP 8.5 du projet).
    "arm64Implementation"("org.mozilla.geckoview:geckoview-arm64-v8a:129.0.20240819150008")
    "arm32Implementation"("org.mozilla.geckoview:geckoview-armeabi-v7a:129.0.20240819150008")
}
