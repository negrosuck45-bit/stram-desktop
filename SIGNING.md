# Signing Stram Desktop

Windows shows **"Unknown publisher"** because `Stram-Setup-*.exe` is not signed with a certificate that Windows trusts. The only real fix is to sign the installer and the app executable with a trusted code-signing certificate.

A self-signed certificate does **not** remove the warning. Windows does not trust it, and it can make the warning worse.

There are two paid practical options, plus limited free routes for open-source projects.

---

## Option A — Azure Trusted Signing (recommended)

Azure Trusted Signing (now also called **Azure Artifact Signing**) is Microsoft's managed signing service. It is much cheaper than a traditional certificate, does not need a USB token, and is trusted by Windows. At the time of writing it is about **$9.99/month** for the Basic tier.

It is available to individuals and organizations in supported regions (US, Canada, EU, UK). You need an Azure subscription and you must complete Microsoft's identity validation.

### 1. Create the signing identity

1. Sign in to the [Azure portal](https://portal.azure.com).
2. Search for **Trusted Signing** and create a **Trusted Signing account** in a supported region.
3. Open **Identity validations** and create a validation for yourself or your company. Enter your legal name, address, and contact details exactly as they appear on your documents. Microsoft reviews this.
4. After validation succeeds, open **Certificate profiles** and create a **Public Trust** profile. The subject name must match the validated identity. Use `Stram` as the profile name.
5. Note these three values:
   - **Endpoint** — for example `https://westus2.codesigning.azure.net`
   - **Code signing account name**
   - **Certificate profile name**

### 2. Give the build permission to sign

1. In Entra ID (Azure AD), create an **App registration**.
2. Create a **client secret** for it.
3. In the Trusted Signing account, add a role assignment for that app:
   - Role: **Trusted Signing Certificate Profile Signer**
   - Scope: the Trusted Signing account (or the certificate profile).
4. Note the **tenant ID**, **application (client) ID**, and **client secret**.

### 3. Configure electron-builder

Add this inside `build.win` in `package.json`. Do not commit the secret.

```json
"azureSignOptions": {
  "publisherName": "Your Legal Name or Company",
  "endpoint": "https://westus2.codesigning.azure.net",
  "certificateProfileName": "Stram",
  "codeSigningAccountName": "your-signing-account",
  "fileDigest": "SHA256",
  "timestampDigest": "SHA256"
}
```

`publisherName` must be exactly the name on the validated certificate profile.

Set the credentials in the terminal before building:

```powershell
$env:AZURE_TENANT_ID = "<tenant-id>"
$env:AZURE_CLIENT_ID = "<client-id>"
$env:AZURE_CLIENT_SECRET = "<client-secret>"

cd "C:\Users\gamin\OneDrive\Documents\Default Project\stram-desktop"
npm run dist
```

electron-builder installs the `TrustedSigning` PowerShell module and signs both the app executable and the installer. The first run can take a few minutes.

### 4. Verify the signature

```powershell
signtool verify /pa /v "dist\Stram-Setup-1.2.1.exe"
Get-AuthenticodeSignature "dist\Stram-Setup-1.2.1.exe" | Format-List Status, StatusMessage, SignerCertificate
```

`Status` should be `Valid`. The publisher in the file properties should now be your validated name instead of "Unknown publisher".

---

## Option B — Traditional OV/EV certificate

Buy a code-signing certificate from a public CA (DigiCert, Sectigo, SSL.com, GlobalSign, etc.).

Since June 2023, public CAs issue code-signing private keys on a **hardware token or cloud HSM**. You will need to complete identity verification and may need to install the CA's signing middleware.

### If you have a PFX file

```powershell
$env:CSC_LINK = "C:\path\to\certificate.pfx"
$env:CSC_KEY_PASSWORD = "<password>"
npm run dist
```

`CSC_LINK` can also be the base64-encoded PFX.

### If the key is on a hardware token

Use the CA's signing tool, or configure a custom `signtoolOptions.sign` hook in `package.json` that calls the token's signing command. Azure Trusted Signing is usually simpler.

### Reputation

- **EV certificates** usually get SmartScreen reputation immediately.
- **OV certificates** can still show a warning until Microsoft builds reputation for the file/publisher. Downloads and time help, but there is no guaranteed instant fix.
- **Azure Trusted Signing** provides a Microsoft-backed identity and is the easiest way to stop the "Unknown publisher" warning for a small app.

---

## Free options (open source or Store)

There is **no free certificate** that removes “Unknown publisher” for a closed-source app. These are the only realistic free/cheap routes:

- **SignPath Foundation** — free code signing for eligible open-source projects. The project must be public, use an accepted open-source licence, and pass an application review. Apply at [signpath.org](https://signpath.org/).
- **Certum Open Source Code Signing** — free certificate for eligible open-source projects, subject to Certum's review and terms.
- **Microsoft Store** — a one-time individual developer account (about $19) publishes an MSIX that Microsoft signs. This avoids the SmartScreen warning, but the app must pass Store review.

If you want to use SignPath or Certum, the desktop wrapper has to be open-sourced first. That does not require publishing the stram.lol site source; it only means publishing the Electron wrapper in `stram-desktop`.

---

## What signing does and does not do

Signing proves:

- The file came from the publisher named in the certificate.
- The file was not modified after it was signed.

Signing does **not** make the app itself safe. Stram Desktop is a thin Electron shell around `https://stram.lol`; the site's own security and your account security still matter.

## After signing

1. Recompute the checksum:
   ```powershell
   Get-FileHash "dist\Stram-Setup-1.2.1.exe" -Algorithm SHA256
   ```
2. Update `SHA256SUMS.txt` and the README.
3. Upload the signed installer and portable exe to the GitHub release.
4. Verify the downloaded file on a clean Windows machine.

Until then, the unsigned build works; users just have to click **More info → Run anyway** on the SmartScreen prompt.
