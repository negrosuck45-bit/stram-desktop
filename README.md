# Stram Desktop

The official Windows desktop app for [stram.lol](https://stram.lol).

## Download

Get the latest release from the [Releases page](https://github.com/negrosuck45-bit/stram-desktop/releases/latest).

- **Windows 10/11 x64**
- Installer: `Stram-Setup-1.2.0.exe`
- Portable: `Stram-Portable-1.2.0.exe` (no install)
- The app loads the live site, so site updates appear without reinstalling.

## What's new in 1.2.0

- **A proper sign-in screen** — when you are signed out, Stram shows a clean “Sign in to Stram” screen.
- **Click Sign in, finish in your browser** — Stram opens stram.lol in your default browser. When you are done, the browser asks **“Open Stram?”** and returns you to the app, already signed in.
- The return trip uses the registered `stram://auth/callback` protocol, with a loopback callback as an automatic fallback if Windows cannot register it.
- The handoff uses PKCE, an encrypted 2-minute code, and a fresh 30-day `httpOnly` session cookie. The session token is never placed in a URL.
- New **File → Sign In in Browser…** menu item.
- Security hardening: HTTPS-only remote sites, navigation/redirect allow-listing, drag-and-drop navigation disabled, and all IPC handlers restricted to the app's local pages.
- Installer and portable builds.

## Install

1. Download `Stram-Setup-1.2.0.exe`.
2. Run it and choose an install folder.
3. The build is unsigned, so SmartScreen may say "Unknown publisher". Click **More info → Run anyway**. See [SIGNING.md](SIGNING.md) for how to remove the warning.

## Verify the download

Installer SHA256:

`fc4e09737706c79e28f554b3ed9331f36e55c404de6a70d5da311affa2d8ece3`

Portable SHA256:

`720291bf7f107a2b97abadfc9c16ac17e3a51a4069dba501ac06c9d8af77c25a`

The release also includes `SHA256SUMS.txt`. Verify in PowerShell:

```powershell
Get-FileHash .\Stram-Setup-1.2.0.exe -Algorithm SHA256
```

## Links

- Website: https://stram.lol
- Issues: https://github.com/negrosuck45-bit/stram-desktop/issues
