# Stram Desktop

The official Windows desktop app for [stram.lol](https://stram.lol).

## Download

Get the latest release from the [Releases page](https://github.com/negrosuck45-bit/stram-desktop/releases/latest).

- **Windows 10/11 x64**
- Installer: `Stram-Setup-1.1.0.exe`
- Portable: `Stram-Portable-1.1.0.exe` (no install)
- The app loads the live site, so site updates appear without reinstalling.

## What's new in 1.1.0

- **Secure browser sign-in handoff** — if Google or another provider blocks the embedded login, choose **Sign in in browser**. Stram opens a short-lived loopback callback, receives an encrypted 2-minute handoff code, and finishes signing in automatically.
- The handoff uses PKCE, an encrypted code, a loopback-only listener, and a fresh 30-day `httpOnly` session cookie. The session token is never placed in a URL.
- New **File → Sign In in Browser…** menu item.
- Security hardening: HTTPS-only remote sites, navigation/redirect allow-listing, drag-and-drop navigation disabled, and all IPC handlers restricted to the app's local pages.
- Installer and portable builds.

## Install

1. Download `Stram-Setup-1.1.0.exe`.
2. Run it and choose an install folder.
3. The build is unsigned, so SmartScreen may say "Unknown publisher". Click **More info → Run anyway**. See [SIGNING.md](SIGNING.md) for how to remove the warning.

## Verify the download

Installer SHA256:

`b0365a9f3725a63eaf5335c2ff026ed77dc1516ddf0686c4f5a834d1f9c81929`

Portable SHA256:

`ddbbff7d122d920f0d3a874bc72a8462e9b7a5749d2fbc46dc513d3905253ec6`

The release also includes `SHA256SUMS.txt`. Verify in PowerShell:

```powershell
Get-FileHash .\Stram-Setup-1.1.0.exe -Algorithm SHA256
```

## Links

- Website: https://stram.lol
- Issues: https://github.com/negrosuck45-bit/stram-desktop/issues
