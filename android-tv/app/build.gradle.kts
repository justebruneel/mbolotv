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

    buildTypes {
        release {
            // R8 + resource shrinking : APK minimal (~2 Mo), l'app n'embarque
            // qu'un WebView wrapper et ses deux écrans natifs.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
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
