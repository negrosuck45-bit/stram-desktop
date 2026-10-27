# Stram Desktop

The official Windows desktop app for [stram.lol](https://stram.lol).

## Download

Get the latest release from the [Releases page](https://github.com/negrosuck45-bit/stram-desktop/releases/latest).

- **Windows 10/11 x64**
- Installer: `Stram-Setup-1.2.1.exe`
- Portable: `Stram-Portable-1.2.1.exe` (no install)
- The app loads the live site, so site updates appear without reinstalling.

## What's new in 1.2.1

- **Pure black & white sign-in screen** — black background, white moon mark, white button. All the purple gradients are gone from the app sign-in screen and from the browser sign-in page.
- **Fixed the "This sign-in link is not valid" error** people could hit in the browser: stram.lol now accepts the `stram://auth/callback` return link, so the sign-in round-trip completes.
- **Click Sign in, finish in your browser** — when you are signed out, Stram shows a clean sign-in screen. Finish in your default browser and it asks **"Open Stram?"** to return you to the app, already signed in.
- The handoff uses PKCE, an encrypted 2-minute code, and a fresh 30-day `httpOnly` session cookie. The session token is never placed in a URL.
- Security hardening: HTTPS-only remote sites, navigation/redirect allow-listing, drag-and-drop navigation disabled, and all IPC handlers restricted to the app's local pages.
- Installer and portable builds.

## Install

1. Download `Stram-Setup-1.2.1.exe`.
2. Run it and choose an install folder.
3. The build is unsigned, so SmartScreen may say "Unknown publisher". Click **More info → Run anyway**. See [SIGNING.md](SIGNING.md) for how to remove the warning.

## Verify the download

Installer SHA256:

`8bf2dc5a43db3ba256a724790e313f2c86cee2f2de246f5b5d257550ab6932c2`

Portable SHA256:

`07af8eb9e5732a3d1d3e9308c840cef4456ff441d0d7017122016213d34580c2`

The release also includes `SHA256SUMS.txt`. Verify in PowerShell:

```powershell
Get-FileHash .\Stram-Setup-1.2.1.exe -Algorithm SHA256
```

## Links

- Website: https://stram.lol
- Issues: https://github.com/negrosuck45-bit/stram-desktop/issues
