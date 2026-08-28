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
        versionCode = 1
        versionName = "1.0.0"

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
}
