# Builds the Android APK locally on Windows.
#
#   pwsh mobile/scripts/build-android.ps1            # release APK: arm64 phones + x86_64 emulator
#   pwsh mobile/scripts/build-android.ps1 -Install   # and install it on the connected device/emulator
#   pwsh mobile/scripts/build-android.ps1 -Dev -Install
#       # a debug APK for the emulator that loads JavaScript from Metro
#       # (`npx expo start`), so edits show without rebuilding
#
# JAVA_HOME and ANDROID_HOME are set for this build only, so nothing on the
# machine changes. The defaults are where mobile/README.md installs them.
#
# Why CMake 3.31: React Native's C++ builds nest each source's full path in its
# object path, which passes Windows' 260 characters from a folder as deep as
# C:\Users\<you>\source\repos\zentry. The ninja that comes with the SDK's
# default CMake (3.22) cannot open such paths; the one with 3.31 (ninja 1.12)
# can, as long as Windows long paths are on.

param(
  [switch]$Install,
  [switch]$Dev,
  [string]$JavaHome = "$env:USERPROFILE\.jdks\jdk-17.0.21+9",
  [string]$AndroidHome = "$env:USERPROFILE\Android\Sdk",
  [string]$CMakeVersion = "3.31.6"
)

$ErrorActionPreference = "Stop"

$cmake = "$AndroidHome\cmake\$CMakeVersion"

foreach ($required in @($JavaHome, $AndroidHome, $cmake)) {
  if (-not (Test-Path $required)) { throw "Not found: $required. See mobile/README.md, Android toolchain." }
}

$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $AndroidHome
$mobile = (Resolve-Path "$PSScriptRoot\..").Path

Push-Location $mobile
try {
  # android/ is generated from app.json and the config plugins; regenerate it
  # whenever they change (`npx expo prebuild --clean`).
  if (-not (Test-Path "android")) {
    npx expo prebuild --platform android --no-install
    if ($LASTEXITCODE -ne 0) { throw "expo prebuild failed ($LASTEXITCODE)" }
  }

  Set-Content -Path "android\local.properties" -Value @(
    "sdk.dir=$($AndroidHome -replace '\\', '/')",
    "cmake.dir=$($cmake -replace '\\', '/')"
  )

  Push-Location android
  try {
    # A dev build only runs on the emulator, so it skips the arm64 compile.
    if ($Dev) {
      .\gradlew.bat assembleDebug "-PreactNativeArchitectures=x86_64"
    } else {
      .\gradlew.bat assembleRelease "-PreactNativeArchitectures=arm64-v8a,x86_64"
    }
    if ($LASTEXITCODE -ne 0) { throw "gradle failed ($LASTEXITCODE)" }
  } finally { Pop-Location }

  $variant = if ($Dev) { "debug" } else { "release" }
  $apk = "$mobile\android\app\build\outputs\apk\$variant\app-$variant.apk"
  Write-Host "APK: $apk"

  if ($Install) {
    & "$AndroidHome\platform-tools\adb.exe" install -r $apk
    if ($LASTEXITCODE -ne 0) { throw "adb install failed ($LASTEXITCODE)" }
  }
} finally { Pop-Location }
