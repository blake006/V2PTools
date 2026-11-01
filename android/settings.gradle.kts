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
        // 可选：把 libcore.aar 放到 app/libs 即可启用 VPN 模式
        flatDir { dirs("app/libs") }
    }
}

rootProject.name = "V2PTools"
include(":app")
