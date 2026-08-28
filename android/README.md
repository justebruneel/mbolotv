# Mbolo TV — enveloppe Android (mobile)

Enveloppe native **WebView** de [mbolotv-web.vercel.app](https://mbolotv-web.vercel.app).
Pas de React Native, pas de lecteur embarqué : le site (hls.js) tourne dans
un WebView système accéléré matériellement, entouré du strict nécessaire natif.

## Ce que fait l'enveloppe

- WebView système, accélération matérielle, cache HTTP `LOAD_DEFAULT`, DOM storage —
  le service worker du site (prod) fournit le shell hors ligne.
- Autoplay autorisé (`mediaPlaybackRequiresUserGesture = false`) : le direct démarre seul.
- Immersif sticky (barres statut + navigation masquées), écran maintenu allumé.
- Plein écran vidéo réel via `onShowCustomView` (le site appelle `requestFullscreen`).
- Rotation gérée par `configChanges` : jamais de rechargement de la lecture.
- Hors ligne : surveillance réseau → écran natif « Pas de connexion » + Réessayer,
  rechargement automatique au retour du réseau.
- Retour : plein écran → historique → **double appui** pour quitter.
- Liens externes (`wa.me`, YouTube, `mailto:`…) ouverts dans le navigateur.
- Pont JS v1 : `window.MboloNative` (`getPlatform`, `isOnline`, `vibrate`, `openExternal`,
  `exitApp`, `getAppVersion`) + suffixe UA `MboloTV/1.0 (Android; Mobile)`.

## Compilation

Prérequis : JDK 17, Android SDK (API 34). Créer `local.properties` si besoin :

```
sdk.dir=/chemin/vers/Android/Sdk
```

```bash
./gradlew assembleDebug          # APK de test : app/build/outputs/apk/debug/
./gradlew assembleRelease        # APK minifié (R8) : app/build/outputs/apk/release/
./gradlew bundleRelease          # AAB pour le Play Store
```

Sans wrapper : `gradle wrapper --gradle-version 8.9` génère `./gradlew`.

## Installation (sideload)

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

URL du site : modifiable dans `app/build.gradle.kts` (`MBOLTV_URL`).
