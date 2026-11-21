# Budget Tracker

A free, installable budget app (in RM). Sign in with Google, log your spending,
and see monthly totals by category. Entries are stored in a Google Sheet and
receipts in Google Drive, with an Apps Script backend. Running cost: RM0.

> **Work in progress.** The full case study (problem, constraint, decisions,
> trade-offs) will be written here in Phase 5.

## Files

| File | What it's for |
| --- | --- |
| `Code.gs` | The backend. Paste it into Apps Script (it isn't served by GitHub Pages) |
| `index.html` | The page: sign-in, then the Add, History, Summary and Settings screens |
| `style.css` | The look |
| `app.js` | The logic: sign-in, talking to the script, saving entries, drawing the screens |
| `config.js` | Your Client ID and Script URL. The only file you edit |

## Run it locally

1. Do the Google setup in the manual (Sheet, Client ID, deploy `Code.gs`).
2. Put your Client ID and Script URL in `config.js`.
3. Open the folder in VS Code, right-click `index.html` → **Open with Live Server**
   (`http://localhost:5500`).
