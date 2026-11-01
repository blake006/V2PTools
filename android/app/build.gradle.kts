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
        versionCode = 1
        versionName = "1.0.0"
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

    // 可选：libcore.aar（VPN 模式）。存在才参与编译，不存在则自动降级为 Wi-Fi 代理模式
    if (file("libs/libcore.aar").exists()) {
        // 通过 flatDir 仓库按文件名引用，避免硬编码 group:name:version
        dependencies { implementation(files("libs/libcore.aar")) }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
