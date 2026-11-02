plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.v2ptools.android"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.v2ptools.android"
        minSdk = 26
        targetSdk = 34
        versionCode = 6
        versionName = "1.0.5"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    // mihomo 内核以 libmihomo.so 命名放在 jniLibs，打包后仍保留可执行权限位
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // 可选：libcore.aar（VPN 模式）。存在才参与编译，不存在则自动降级为 Wi-Fi 代理模式
    val libcoreAar = file("libs/libcore.aar")
    if (libcoreAar.exists()) {
        implementation(files(libcoreAar))
    }
}
