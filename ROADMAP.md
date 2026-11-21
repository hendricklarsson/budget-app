# Roadmap

Where the project stands and what comes next. Phases follow the
*Budget Tracker PWA — Roadmap & Setup Manual*.

## Done

- [x] **Phase 1 — Google setup:** Sheet, Sign-In client, Apps Script deployed.
- [x] **Phase 2 — Build and test locally:** sign-in, Add, History, Summary,
      Settings, receipt photos, Delete my data.
- [x] **Phase 3 — Live on GitHub Pages:** installable on Android and iPhone,
      sign-in published, tested by a second user.
- [x] **Hardening:** daily limits (per user and overall), optional
      `ALLOWED_EMAILS` invite list, real deletes (row removed, photo trashed),
      photo uploads outside the lock, quiet sign-in renewal before expiry.

## Next, in this order

1. **Design** — prototype the screens in Claude Design (brief: every screen and
   state the app has, light and dark mode).
2. **Branding** — apply the design: restyle `style.css` and `index.html`
   (keeping `app.js` logic), update the icon, name and colours in
   `manifest.json`, and the screenshots.
3. **Move hosting to Netlify or Vercel** — see the checklist below.
4. **Phase 5 — Portfolio write-up** — README as a case study (problem, RM0
   constraint, decisions, trade-offs, problems found and fixed), with
   screenshots made from sample data and the new live link.
5. **Phase 6 — Learn by reverse engineering** — read, break, rebuild, extend
   (exercises in the manual).

## Checklist: moving from GitHub Pages to Netlify or Vercel

No code changes are needed: every path in the app is relative.

- [ ] Pick the host and the site name (e.g. `budget-tracker.netlify.app` or
      `budget-tracker.vercel.app`).
- [ ] Connect the host to this GitHub repository (branch `main`, no build
      command, publish directory = the repository root). Every push redeploys.
- [ ] Google Cloud → Google Auth Platform → Clients → your client →
      **Authorized JavaScript origins**: add the new address
      (`https://<name>.netlify.app` or `https://<name>.vercel.app`, no path).
- [ ] Google Auth Platform → **Branding**: update the home page, the privacy
      policy link (`…/privacy.html`) and the authorized domain.
- [ ] Sign in on the new address and add a test expense.
- [ ] Reinstall the app on phones from the new address (each address counts as
      a separate app; data is safe in the Sheet, users just sign in again).
- [ ] Update the live link in `README.md` and `privacy.html`.
- [ ] Turn off GitHub Pages (repository **Settings → Pages**), or leave it
      running until everyone has moved, then remove
      `https://hendricklarsson.github.io` from the authorized origins.
