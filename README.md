# Sen Tracker

A free, installable spending tracker (in RM). Sign in with Google, log your spending,
and see it by day, month and year. Running cost: RM0.

**Encrypted on your phone.** Each entry's amount, category, date, time and note,
and every receipt photo, are encrypted in the browser (Web Crypto: AES-GCM, with
the key locked by a passphrase via PBKDF2, plus a recovery code) before they are
sent. The backend, a Google Sheet and a Drive folder run by Apps Script, only
ever stores the scrambled result, so the developer can't read anyone's entries.

> **Work in progress.** The full case study (problem, constraint, decisions,
> trade-offs) will be written here in Phase 5.

## Files

| File | What it's for |
| --- | --- |
| `Code.gs` | The backend. Paste it into Apps Script (it isn't served by GitHub Pages) |
| `index.html` | The page: sign-in, then the Overview, History, Add/Edit and Settings screens |
| `style.css` | The look (layouts v9: dark, glowing glass) |
| `app.js` | The logic: sign-in, talking to the script, saving entries, drawing every screen |
| `crypto.js` | The encryption: the data key, the key box (passphrase + recovery code), entries and photos |
| `passphrase.js` | The screens around encryption: create passphrase, recovery code, unlock, recover, start fresh |
| `statement.js` | Makes the monthly PDF statement by hand, with no library (tagged for screen readers) |
| `config.js` | Your Client ID and Script URL. The only file you edit |
| `manifest.json` | Tells phones the app's name, icon and colours, so it can be installed |
| `sw.js` | The service worker: keeps a copy of the app's files so it opens offline |
| `privacy.html` | The privacy policy (Google requires it before publishing sign-in) |
| `fonts/` | Geist, and Doto for the dotted totals (SIL Open Font License, see `fonts/OFL.txt`) |
| `icons/` | App icons: 192px, 512px, a "maskable" 512px for Android, and 180px for iPhone |

## Run it locally

1. Do the Google setup in the manual (Sheet, Client ID, deploy `Code.gs`).
2. Put your Client ID and Script URL in `config.js`.
3. Open the folder in VS Code, right-click `index.html` → **Open with Live Server**
   (`http://localhost:5500`).
