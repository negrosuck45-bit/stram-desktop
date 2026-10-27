# Stram Desktop

The official Windows desktop app for [stram.lol](https://stram.lol).

## Download

Get the latest release from the [Releases page](https://github.com/negrosuck45-bit/stram-desktop/releases/latest).

- **Windows 10/11 x64**
- Installer: `Stram-Setup-1.2.2.exe`
- Portable: `Stram-Portable-1.2.2.exe` (no install)
- The app loads the live site, so site updates appear without reinstalling.

## What's new in 1.2.2

- **Email sign-in now uses a 6-digit code you paste** — after your password, Stram emails a 6-digit code; type it in the boxes and you're in. No more "open this link to continue" screen.
- **Click Sign in → the actual sign-in page** — the browser opens straight onto the sign-in page, no extra "continue" card in between.
- **Sign-up on the same page** — "Don't have an account? Sign up" switches right there, and sign-up emails the same code.
- **Cleaner in-app sign-in screen** — just **Sign in**; the extra paragraphs and buttons are gone.
- Sign-up and sign-in both finish with the automatic **"Open Stram?"** return into the app, signed in and ready to chat.
- The handoff still uses PKCE, an encrypted 2-minute code, and a fresh 30-day `httpOnly` session cookie. The session token is never placed in a URL.
- Security hardening: HTTPS-only remote sites, navigation/redirect allow-listing, drag-and-drop navigation disabled, and all IPC handlers restricted to the app's local pages.
- Installer and portable builds.

## Install

1. Download `Stram-Setup-1.2.2.exe`.
2. Run it and choose an install folder.
3. The build is unsigned, so SmartScreen may say "Unknown publisher". Click **More info → Run anyway**. See [SIGNING.md](SIGNING.md) for how to remove the warning.

## Verify the download

Installer SHA256:

`b9c97c22a78c96bdcd5cdb544fdf0014d1a6bd4cc0031f88e7f7c5d227e76b76`

Portable SHA256:

`915e03bdb5f6c2925110c7788fc3acac14460f7addbfd9d5d4fcba88e3f25bda`

The release also includes `SHA256SUMS.txt`. Verify in PowerShell:

```powershell
Get-FileHash .\Stram-Setup-1.2.2.exe -Algorithm SHA256
```

## Links

- Website: https://stram.lol
- Issues: https://github.com/negrosuck45-bit/stram-desktop/issues
