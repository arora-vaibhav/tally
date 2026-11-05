plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The release tag is the version: gradle assembleRelease -PtallyVersion=v1.7.0. Without it the
// build is "dev", which never updates itself.
val tallyVersion = (findProperty("tallyVersion") as String?)?.takeIf { it.isNotBlank() } ?: "dev"

// v1.7.0 -> 10700, so each release installs over the last. A dev build is 1.
// shortcut: a minor or patch above 99 would collide, revisit if versions ever get there.
fun versionCodeOf(v: String): Int {
    val m = Regex("""^v?(\d+)\.(\d+)(?:\.(\d+))?$""").find(v.trim()) ?: return 1
    val (a, b, c) = m.destructured
    return a.toInt() * 10000 + b.toInt() * 100 + (c.ifEmpty { "0" }).toInt()
}

// A release key from the environment (CI secrets, or the local keystore); without one the
// release build is signed with the debug key so it still installs for testing.
val keystore: String? = System.getenv("TALLY_KEYSTORE")?.takeIf { it.isNotBlank() }

android {
    namespace = "io.github.aroravaibhav.tally"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.aroravaibhav.tally"
        minSdk = 26
        targetSdk = 35
        versionName = tallyVersion
        versionCode = versionCodeOf(tallyVersion)
    }

    signingConfigs {
        create("release") {
            if (keystore != null) {
                storeFile = file(keystore)
                storePassword = System.getenv("TALLY_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TALLY_KEY_ALIAS")
                keyPassword = System.getenv("TALLY_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false // the page calls the bridge by name; nothing to gain from shrinking
            signingConfig = signingConfigs.getByName(if (keystore != null) "release" else "debug")
        }
    }

    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint { checkReleaseBuilds = false }

    // web/ at the repo root stays the one copy of the page; it is copied in at build time
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("web-assets"))
}

val copyWeb by tasks.registering(Sync::class) {
    from(rootDir.resolve("../web"))
    into(layout.buildDirectory.dir("web-assets/web"))
}
tasks.named("preBuild") { dependsOn(copyWeb) }

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.core:core-ktx:1.13.1")
    testImplementation("junit:junit:4.13.2")
}
