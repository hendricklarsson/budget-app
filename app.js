// app.js — Sen Tracker's logic: sign-in, talking to the script, every screen.
//
// Big picture:
//   1. Google Sign-In gives us an "ID token" (a signed text that says who the
//      user is). We keep it and send it with every request.
//   2. callApi() POSTs {action, idToken, ...} to the Apps Script URL.
//   3. The user's entries live in state.expenses and are cached in
//      localStorage, so screens draw instantly; the server is refreshed in the
//      background. Every screen is drawn from state by a render function.
//   4. New entries appear at once and save in the background. Deletes wait
//      until the "Undo" message is closed before they reach the server.
//
// Sections (search for the numbers):
//   1. Settings and state      9. Choose period pop-up
//   2. Icons and tiny helpers  10. Add and Edit expense
//   3. Start-up                11. History
//   4. Sign-in and session     12. Receipts
//   5. Talking to the script   13. Settings and Delete my data
//   6. Entries and the cache   14. PDF statement
//   7. Dates and money         15. Toast, banners and pop-ups
//   8. Navigation and Overview

'use strict';

// ===========================================================================
// 1. Settings and state
// ===========================================================================

// Must match the list in Code.gs, which re-checks every value.
const CATEGORIES = ['Food', 'Transport', 'Bills', 'Shopping', 'Health', 'Entertainment', 'Other'];
const MAX_AMOUNT = 1000000;
const MAX_NOTE_LENGTH = 200;

const TOKEN_KEY = 'budget.session';            // where the sign-in is kept
const CACHE_PREFIX = 'budget.expenses.';       // + email: one cache per user
const PENDING_DELETE_PREFIX = 'sen.pendingDelete.'; // + email: deletes not sent yet
const LAST_CATEGORY_KEY = 'sen.lastCategory';  // the category used last time
const EXPIRY_MARGIN_MS = 60 * 1000;            // treat tokens as expired 1 min early
const REFRESH_BEFORE_MS = 5 * 60 * 1000;       // try to renew the sign-in 5 min before it ends
const PHOTO_MAX_SIZE = 1280;                   // longest side of a receipt photo, in pixels
const PHOTO_QUALITY = 0.75;                    // JPEG quality: text stays readable, files ~150 KB

// Which mesh background each screen uses (see the design system).
const SCREEN_MESH = { overview: 'sky', history: 'lime', form: 'bloom', settings: 'bloom' };

// Everything the app currently knows, in one place.
const state = {
  idToken: null,        // the raw Google ID token, sent to the script
  user: null,           // {email, name, exp} read from the token, for display only
  // The user's entries. Each is
  // {id, date, amount, category, note, hasReceipt, createdAt, status?, error?, errorCode?, receipt?}
  // status is only set on entries not yet on the server: 'saving' or 'failed',
  // and receipt ({mimeType, data}) is a photo waiting to be uploaded.
  expenses: [],
  hasLoaded: false,     // true once the server (or the cache) has answered
  offline: false,       // true when the last refresh couldn't reach the server
  lastSync: null,       // when entries last came from the server (ms)
  deleting: new Set(),  // ids being deleted right now (a refresh won't bring them back)
  pendingDelete: null,  // {entries, serverIds} hidden but not deleted yet (Undo possible)
  recentlyEdited: new Set(), // ids edited this session ("Edited just now")
  receiptCache: new Map(),   // id → image already loaded, so opening it twice is instant

  screen: 'overview',   // 'overview' | 'history' | 'settings' | 'form'
  period: null,         // Overview's period: {type: 'day'|'month'|'year', value}
  weekDay: null,        // the day picked in Overview's "This week" strip
  historyMonth: null,   // 'yyyy-mm' shown in History
  expandedId: null,     // the History entry whose buttons are showing
  selecting: false,     // History's edit mode (choosing entries)
  selected: new Set(),  // ids chosen in edit mode
  form: null,           // the Add/Edit form: {mode, id?, original?, photo, saving}

  refreshTimer: null,   // renews the sign-in shortly before it expires
  expiryTimer: null,    // asks the user to sign in again if renewing didn't work
  toast: null,          // the message showing now: {onClose}
  focusKey: null,       // after a redraw, put keyboard focus back on [data-key="..."]
};

// ===========================================================================
// 2. Icons and tiny helpers
// ===========================================================================

// Icon outlines from the design (24 × 24 grid, drawn with round lines).
const ICONS = {
  home: 'M4 11l8-7 8 7v9H4zM10 20v-6h4v6',
  history: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM10 15a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  calendar: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4',
  next: 'M9 5l7 7-7 7',
  back: 'M15 5l-7 7 7 7',
  down: 'M6 9l6 6 6-6',
  up: 'M6 15l6-6 6 6',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  alert: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v6M12 16.5v.5',
  info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 11v6M12 7.5v.5',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v5l3 2',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  share: 'M12 15V4M8 8l4-4 4 4M5 13v7h14v-7',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  offline: 'M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0M12 19h.01M3 3l18 18',
  retry: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  signOut: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
};
const CATEGORY_ICONS = {
  Food: 'M4 11h16a8 8 0 0 1-16 0zM9 7.5c0-1.5 1-2 1-3.5M14 7.5c0-1.5 1-2 1-3.5',
  Transport: 'M5 17v-6l2-5h10l2 5v6zM5 11h14M7.5 14h1M15.5 14h1M6 17v2M18 17v2',
  Bills: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5',
  Shopping: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  Health: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z',
  Entertainment: 'M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4zM14 7v10',
  Other: 'M3 12V4h8l10 10-8 8zM7 8h1',
};

// Shortcut for document.getElementById.
const $ = (id) => document.getElementById(id);

/**
 * Makes an SVG icon. Icons are decoration (the text next to them says what
 * they mean), so screen readers skip them (aria-hidden).
 */
function icon(name, size = 20, strokeWidth = 2) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('stroke-width', strokeWidth);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || CATEGORY_ICONS[name]);
  svg.append(path);
  return svg;
}

/**
 * Builds an element in one line, e.g.
 *   h('button', {class: 'btn', onclick: save}, icon('check'), 'Save')
 * Props: class, text, on<event> handlers, anything else becomes an attribute
 * (true → present, false/null → left out). Children: elements or text.
 * Text always goes in as text, never as HTML, so a note like "<script>" is
 * shown as typed and never runs.
 */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/**
 * Redrawing replaces the buttons, which would drop keyboard and screen-reader
 * focus. Before a redraw we note the tapped button's data-key (keepFocus);
 * afterwards restoreFocus() puts focus back on the new button with that key.
 */
function keepFocus(key) {
  state.focusKey = key;
}
function restoreFocus(container) {
  if (!state.focusKey) return;
  const el = container.querySelector('[data-key="' + CSS.escape(state.focusKey) + '"]');
  state.focusKey = null;
  if (el) el.focus();
}

/**
 * Replaces an element's content. Like el.replaceChildren(), but skips empty
 * parts (null, undefined, false), so optional pieces can be written inline
 * as  condition ? part : null  without the word "null" appearing on screen.
 */
function setChildren(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

/** The coloured icon tile used in lists: category colour at 10%. */
function categoryTile(category) {
  return h('span', { class: 'tile', 'data-cat': category }, icon(category, 22));
}

/** plural(1, 'entry', 'entries') → "1 entry"; plural(3, ...) → "3 entries". */
function plural(count, one, many) {
  return count + ' ' + (count === 1 ? one : many);
}

/**
 * A random, unique id for a new entry. crypto.randomUUID() only exists on
 * secure pages (https or localhost); the fallback is just as unique.
 */
function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ===========================================================================
// 3. Start-up
// ===========================================================================

/**
 * Runs once when the page loads: wires up the fixed parts of the page, sets
 * up Google's sign-in, and restores a saved sign-in if it is still valid.
 */
function start() {
  registerServiceWorker();

  if (CLIENT_ID.startsWith('PASTE_') || SCRIPT_URL.startsWith('PASTE_')) {
    showSignIn('Setup needed: put your Client ID and Script URL in config.js.', 'error');
    return;
  }

  state.period = { type: 'month', value: currentMonth() };
  state.historyMonth = currentMonth();

  // Icons in the fixed HTML (tab bar, form rows).
  for (const slot of document.querySelectorAll('[data-icon]')) slot.replaceWith(icon(slot.dataset.icon, 22));
  $('date-icon').replaceWith(icon('calendar', 22));
  $('details-icon').replaceWith(icon('plus', 22));

  // Tab bar.
  for (const tab of document.querySelectorAll('[data-screen]')) {
    tab.addEventListener('click', () => (tab.dataset.screen === 'add' ? openAddForm() : showScreen(tab.dataset.screen)));
  }

  setUpForm();
  $('delete-selected').addEventListener('click', confirmDeleteSelected);

  // Phones pause timers while the app is in the background, so when it comes
  // back we check the sign-in again. When it goes to the background, we send
  // any delete that was waiting for its Undo message to close.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') commitPendingDelete();
    if (document.visibilityState === 'visible' && state.idToken) scheduleSessionTimers();
  });

  initGoogleSignIn();

  const saved = loadSession();
  if (saved) {
    state.idToken = saved.idToken;
    state.user = saved.user;
    scheduleSessionTimers();
    showApp();
  } else {
    showSignIn();
  }
}

/**
 * Registers sw.js, which keeps a copy of the app's files so the app opens
 * even offline, and is one of the things that makes it installable.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch((err) => {
    console.warn('Service worker not registered:', err);
  });
}

/**
 * Sets up "Sign in with Google" and draws its button. Google draws the
 * button itself (we can't restyle it), so we pick its black pill version,
 * the closest match to the design's primary button.
 */
function initGoogleSignIn() {
  if (typeof google === 'undefined' || !google.accounts) {
    showSignIn('Could not load Google Sign-In. Check your connection and reload.', 'error');
    return;
  }
  google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: handleCredential,
    auto_select: true,
  });
  const box = $('google-button');
  google.accounts.id.renderButton(box, {
    theme: 'filled_black',
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
    width: Math.min(400, Math.max(200, box.clientWidth || 320)),
  });
}

// ===========================================================================
// 4. Sign-in and session
// ===========================================================================

/**
 * Called by Google after a successful sign-in. response.credential is the
 * ID token. We read the name, email and expiry from it for display; the real
 * check happens on the server, which asks Google if it is genuine.
 */
function handleCredential(response) {
  const payload = decodeJwtPayload(response.credential);
  // A quiet renewal (see renewSignIn) for the person already using the app:
  // just swap in the new token and leave the screen exactly as it is.
  const isRenewal = Boolean(state.user) && state.user.email === payload.email && !$('app-screen').hidden;
  state.idToken = response.credential;
  state.user = { email: payload.email, name: payload.name, exp: payload.exp };
  saveSession();
  scheduleSessionTimers();
  if (!isRenewal) showApp();
}

/**
 * Reads the middle part of a JWT (header.payload.signature): base64url text
 * containing JSON. Decoded via bytes + TextDecoder so accented names work.
 * This does NOT check the signature: never trust it for security.
 */
function decodeJwtPayload(token) {
  const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** True while the token has more than a minute left (Google tokens last ~1 hour). */
function isSessionValid(user) {
  return Boolean(user && user.exp * 1000 - EXPIRY_MARGIN_MS > Date.now());
}

/** Keeps the sign-in across reloads until it expires. */
function saveSession() {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ idToken: state.idToken, user: state.user }));
}

/** Returns the saved session if it is still valid, otherwise null. */
function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY));
    return saved && isSessionValid(saved.user) ? saved : null;
  } catch (err) {
    return null;
  }
}

/**
 * Sets two timers based on when the token expires:
 *   - 5 minutes before: try to renew the sign-in quietly (renewSignIn);
 *   - 1 minute before: if it still wasn't renewed, ask the user to sign in.
 */
function scheduleSessionTimers() {
  clearTimeout(state.refreshTimer);
  clearTimeout(state.expiryTimer);
  if (!state.user) return;
  const msLeft = state.user.exp * 1000 - Date.now();
  if (msLeft <= EXPIRY_MARGIN_MS) {
    handleExpiredSession();
    return;
  }
  state.refreshTimer = setTimeout(renewSignIn, Math.max(0, msLeft - REFRESH_BEFORE_MS));
  state.expiryTimer = setTimeout(handleExpiredSession, msLeft - EXPIRY_MARGIN_MS);
}

/**
 * Asks Google for a fresh token without interrupting the user. With
 * auto_select, Google signs a returning user straight back in and calls
 * handleCredential. If Google skips it, the expiry timer takes over.
 */
function renewSignIn() {
  if (typeof google !== 'undefined' && google.accounts) google.accounts.id.prompt();
}

/**
 * Called when the token has expired (or the server says it is invalid).
 * Keeps the cached entries (they show again after sign-in) and asks the user
 * to sign in again; Google's One Tap prompt makes it quick.
 */
function handleExpiredSession() {
  clearTimeout(state.refreshTimer);
  clearTimeout(state.expiryTimer);
  state.idToken = null;
  localStorage.removeItem(TOKEN_KEY);
  showSignIn('Your sign-in has expired. Please sign in again. Your entries are safe.', 'warning');
  if (typeof google !== 'undefined' && google.accounts) google.accounts.id.prompt();
}

/**
 * Signs out: forgets the token AND this user's cached entries, so the next
 * person using this phone can't see them.
 */
async function signOut() {
  const unsaved = state.expenses.filter((e) => e.status).length;
  if (unsaved && !confirm(plural(unsaved, 'entry is', 'entries are') + ' not saved yet and will be lost. Sign out anyway?')) {
    return;
  }
  await commitPendingDelete();
  clearUserData();
  showSignIn('You have signed out.', 'info');
}

/** Forgets everything about the current user on this device. */
function clearUserData() {
  if (state.user) {
    localStorage.removeItem(CACHE_PREFIX + state.user.email);
    localStorage.removeItem(PENDING_DELETE_PREFIX + state.user.email);
  }
  localStorage.removeItem(TOKEN_KEY);
  clearTimeout(state.refreshTimer);
  clearTimeout(state.expiryTimer);
  Object.assign(state, {
    idToken: null, user: null, expenses: [], hasLoaded: false, offline: false, lastSync: null,
    pendingDelete: null, selecting: false, expandedId: null, form: null,
  });
  state.selected.clear();
  state.recentlyEdited.clear();
  state.receiptCache.clear();
  if (typeof google !== 'undefined' && google.accounts) google.accounts.id.disableAutoSelect();
}

// ===========================================================================
// 5. Talking to the script
// ===========================================================================

/**
 * Sends one request to the Apps Script backend and returns its JSON answer.
 *
 * Why text/plain: a JSON content type would make the browser send a CORS
 * "preflight" request first, which Apps Script can't answer. text/plain is a
 * "simple" request, so it goes straight through. The body is still JSON.
 *
 * options.keepalive lets a request finish even if the page is closing (used
 * for deletes sent when the app goes to the background).
 * Throws an Error with .code: the server's code, or 'NETWORK'.
 */
async function callApi(action, data = {}, options = {}) {
  if (!isSessionValid(state.user)) {
    handleExpiredSession();
    throw Object.assign(new Error('Please sign in again.'), { code: 'AUTH' });
  }

  let response;
  try {
    response = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, idToken: state.idToken, ...data }),
      keepalive: Boolean(options.keepalive),
    });
  } catch (err) {
    throw Object.assign(new Error('No internet connection.'), { code: 'NETWORK' });
  }
  if (!response.ok) {
    throw Object.assign(new Error('The server had a problem (' + response.status + ').'), { code: 'NETWORK' });
  }

  const result = await response.json();
  if (!result.ok) {
    if (result.code === 'AUTH') handleExpiredSession();
    throw Object.assign(new Error(result.error), { code: result.code });
  }
  return result;
}

// ===========================================================================
// 6. Entries and the cache
// ===========================================================================

/**
 * Fetches the user's entries from the script, then redraws.
 * Entries not on the server yet (saving or failed) are kept, and entries
 * being deleted (or waiting for Undo) are left out, so a refresh never
 * undoes the user's most recent actions.
 */
async function loadExpenses() {
  try {
    const result = await callApi('list');
    const serverIds = new Set(result.expenses.map((e) => e.id));
    const hidden = new Set([...state.deleting, ...(state.pendingDelete ? state.pendingDelete.serverIds : [])]);
    const notOnServerYet = state.expenses.filter((e) => e.status && !serverIds.has(e.id));
    state.expenses = result.expenses.filter((e) => !hidden.has(e.id)).concat(notOnServerYet);
    state.offline = false;
    state.lastSync = Date.now();
    sortExpenses();
    saveCache();
  } catch (err) {
    if (err.code === 'AUTH') return;
    state.offline = true;
    if (err.code !== 'NETWORK') showToast('Could not refresh: ' + err.message, { isError: true });
  }
  state.hasLoaded = true;
  renderAll();
}

/**
 * Saves this user's entries in localStorage, under a key with their email.
 * Unsaved entries include their photo, so a retry still has it after the app
 * is closed. If storage is full we just skip caching; the app still works.
 */
function saveCache() {
  try {
    localStorage.setItem(CACHE_PREFIX + state.user.email,
      JSON.stringify({ v: 2, expenses: state.expenses, lastSync: state.lastSync }));
  } catch (err) {
    console.warn('Could not cache entries:', err);
  }
}

/**
 * Loads this user's cached entries. An entry cached as "saving" was cut off
 * (the app closed mid-save), so it becomes "failed" for the user to retry.
 * Older versions stored a plain list; both shapes are understood.
 */
function loadCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_PREFIX + state.user.email));
    const expenses = Array.isArray(cached) ? cached : (cached && cached.expenses) || [];
    state.lastSync = cached && cached.lastSync ? cached.lastSync : null;
    for (const e of expenses) {
      if (e.status === 'saving') {
        e.status = 'failed';
        e.error = 'The app closed before it saved.';
      }
    }
    return expenses;
  } catch (err) {
    return [];
  }
}

/** Newest date first; on the same day, the most recently added first. */
function sortExpenses() {
  state.expenses.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
}

/** Finds an entry by id, or undefined. */
function findExpense(id) {
  return state.expenses.find((e) => e.id === id);
}

/** Entries saved on the server (not waiting or failed). */
function savedExpenses() {
  return state.expenses.filter((e) => !e.status);
}

/** Adds up amounts in whole sen (cents), avoiding 0.1 + 0.2 = 0.30000000000000004. */
function sumAmounts(entries) {
  return entries.reduce((sen, e) => sen + Math.round(e.amount * 100), 0) / 100;
}

/**
 * Sends one not-yet-saved entry to the server. On success the local copy is
 * replaced by the server's copy (which has no status). On failure it is
 * marked "failed" with the reason, and History shows "Try Again".
 */
async function saveExpense(id) {
  const expense = findExpense(id);
  if (!expense) return;
  expense.status = 'saving';
  delete expense.error;
  delete expense.errorCode;
  renderAll();

  try {
    const { id: expenseId, date, amount, category, note, receipt } = expense;
    const result = await callApi('add', { expense: { id: expenseId, date, amount, category, note, receipt } });
    if (receipt) state.receiptCache.set(id, 'data:image/jpeg;base64,' + receipt.data);
    const index = state.expenses.findIndex((e) => e.id === id);
    if (index !== -1) state.expenses[index] = result.expense;
  } catch (err) {
    const current = findExpense(id);
    if (current) {
      current.status = 'failed';
      current.error = err.message;
      current.errorCode = err.code;
    }
    if (err.code !== 'AUTH') showToast("Couldn't save: " + err.message, { isError: true });
  }
  sortExpenses();
  saveCache();
  renderAll();
}

/**
 * Hides entries straight away and shows "Deleted · Undo". The delete is only
 * sent to the server when that message goes away (closed, replaced, the
 * screen changes, or the app goes to the background), so Undo is instant
 * and needs no server. The waiting ids are also stored, so a delete is still
 * sent if the app is closed while the message is up.
 */
function deleteWithUndo(ids, message) {
  hideToast();           // closing the current message sends an older waiting delete
  commitPendingDelete(); // (and in case there was no message)
  const idSet = new Set(ids);
  const entries = state.expenses.filter((e) => idSet.has(e.id));
  if (!entries.length) return;
  state.expenses = state.expenses.filter((e) => !idSet.has(e.id));
  // Entries that never reached the server only need removing here.
  const serverIds = entries.filter((e) => !e.status).map((e) => e.id);
  state.pendingDelete = { entries, serverIds };
  storePendingDelete(serverIds);
  state.expandedId = null;
  saveCache();
  renderAll();
  showToast(message, { undo: undoDelete, onClose: commitPendingDelete });
}

/** Undo: puts the hidden entries back. Nothing was sent, so nothing to reverse. */
function undoDelete() {
  const pending = state.pendingDelete;
  if (!pending) return;
  state.pendingDelete = null;
  storePendingDelete([]);
  state.expenses.push(...pending.entries);
  sortExpenses();
  saveCache();
  renderAll();
  hideToast();
}

/**
 * Sends the waiting delete to the server, if there is one. If it fails, the
 * entries come back and the user is told, so nothing disappears silently.
 */
async function commitPendingDelete() {
  const pending = state.pendingDelete;
  if (!pending) return;
  state.pendingDelete = null;
  if (!pending.serverIds.length) {
    storePendingDelete([]);
    return;
  }
  pending.serverIds.forEach((id) => state.deleting.add(id));
  try {
    await callApi('deleteMany', { ids: pending.serverIds }, { keepalive: true });
    storePendingDelete([]);
  } catch (err) {
    if (err.code === 'AUTH') return; // stays stored: sent after signing in again
    storePendingDelete([]);
    state.expenses.push(...pending.entries.filter((e) => !findExpense(e.id)));
    sortExpenses();
    saveCache();
    renderAll();
    showToast("Couldn't delete: " + err.message + ' Your entries are back.', { isError: true });
  } finally {
    pending.serverIds.forEach((id) => state.deleting.delete(id));
  }
}

/** Remembers (or forgets, with []) ids whose delete hasn't been sent yet. */
function storePendingDelete(ids) {
  if (!state.user) return;
  const key = PENDING_DELETE_PREFIX + state.user.email;
  if (ids.length) localStorage.setItem(key, JSON.stringify(ids));
  else localStorage.removeItem(key);
}

/**
 * After a restart: if the app was closed while a delete waited for Undo,
 * send it now (the user had not pressed Undo).
 */
function sendLeftoverDelete() {
  let ids = [];
  try {
    ids = JSON.parse(localStorage.getItem(PENDING_DELETE_PREFIX + state.user.email)) || [];
  } catch (err) {
    ids = [];
  }
  if (!ids.length) return;
  const idSet = new Set(ids);
  const entries = state.expenses.filter((e) => idSet.has(e.id));
  state.expenses = state.expenses.filter((e) => !idSet.has(e.id));
  state.pendingDelete = { entries, serverIds: ids };
  commitPendingDelete();
}

// ===========================================================================
// 7. Dates and money
// ===========================================================================

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                'September', 'October', 'November', 'December'];
const numberFormat = new Intl.NumberFormat('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 12.5 → "RM 12.50". */
function rm(amount) {
  return 'RM ' + numberFormat.format(amount);
}

/** 12.5 → "12.50" (for the big amounts, where "RM" is styled separately). */
function amountNumber(amount) {
  return numberFormat.format(amount);
}

/** "5" → "05". */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** A Date → "2026-11-21", in the phone's own time zone. */
function toDateText(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** "2026-11-21" → a Date at local midnight (built from parts, so no time-zone shift). */
function parseDate(text) {
  const [y, m, d] = text.split('-').map(Number);
  return new Date(y, m - 1, d || 1);
}

/**
 * Today as yyyy-mm-dd in the phone's time zone. (new Date().toISOString()
 * would give UTC, which in Malaysia is the wrong day until 8 am.)
 */
function today() {
  return toDateText(new Date());
}

/** This month as yyyy-mm. */
function currentMonth() {
  return today().slice(0, 7);
}

/** Adds days to a yyyy-mm-dd date. */
function addDays(text, days) {
  const d = parseDate(text);
  d.setDate(d.getDate() + days);
  return toDateText(d);
}

/** Adds months to a yyyy-mm month (Date handles the year roll-over). */
function addMonths(month, delta) {
  const d = parseDate(month + '-01');
  d.setMonth(d.getMonth() + delta);
  return toDateText(d).slice(0, 7);
}

/** Number of days in a yyyy-mm month. */
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** "2026-11-21" → "Sat, 21 Nov" (+ year when it isn't this year, or if asked). */
function formatDay(text, withYear) {
  const d = parseDate(text);
  const showYear = withYear || d.getFullYear() !== new Date().getFullYear();
  return WEEKDAYS[d.getDay()].slice(0, 3) + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) +
    (showYear ? ' ' + d.getFullYear() : '');
}

/** "2026-11-21" → "Saturday, 21 Nov". */
function formatDayLong(text) {
  const d = parseDate(text);
  return WEEKDAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3);
}

/** "2026-11" → "November 2026". */
function formatMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return MONTHS[m - 1] + ' ' + y;
}

/** "2026-11" → "November", or "August 2025" when it isn't this year. */
function formatMonthShort(month) {
  const [y, m] = month.split('-').map(Number);
  return y === new Date().getFullYear() ? MONTHS[m - 1] : MONTHS[m - 1] + ' ' + y;
}

/** The words for a period: "November 2026", "Sat, 21 Nov 2026" or "2026". */
function periodLabel(period) {
  if (period.type === 'day') return formatDay(period.value, true);
  if (period.type === 'year') return period.value;
  return formatMonth(period.value);
}

/** True if a yyyy-mm-dd date falls inside the period. */
function inPeriod(dateText, period) {
  if (period.type === 'day') return dateText === period.value;
  return dateText.startsWith(period.value + '-');
}

/** The period just before: the previous day, month or year. */
function previousPeriod(period) {
  if (period.type === 'day') return { type: 'day', value: addDays(period.value, -1) };
  if (period.type === 'year') return { type: 'year', value: String(Number(period.value) - 1) };
  return { type: 'month', value: addMonths(period.value, -1) };
}

/** The period of this type that contains today. */
function currentPeriod(type) {
  if (type === 'day') return { type, value: today() };
  if (type === 'year') return { type, value: today().slice(0, 4) };
  return { type: 'month', value: currentMonth() };
}

/** True if the period contains today. */
function periodHasToday(period) {
  return inPeriod(today(), period);
}

// ===========================================================================
// 8. Navigation and Overview
// ===========================================================================

/** Shows the sign-in screen with an optional message ('warning', 'error' or 'info'). */
function showSignIn(message = '', kind = 'info') {
  closeSheet();
  hideToast();
  document.body.dataset.mesh = 'sunrise';
  $('app-screen').hidden = true;
  $('signin-screen').hidden = false;
  const box = $('signin-message');
  setChildren(box);
  box.hidden = !message;
  if (message) {
    box.className = 'banner banner-' + kind;
    box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    box.append(icon(kind === 'info' ? 'info' : 'alert', 20), h('span', { class: 'banner-text' }, message));
  }
}

/**
 * Shows the app for the signed-in user: draws the cached entries at once,
 * then refreshes from the server in the background.
 */
function showApp() {
  $('signin-screen').hidden = true;
  $('app-screen').hidden = false;
  state.expenses = loadCache();
  state.hasLoaded = state.expenses.length > 0 || state.lastSync !== null;
  sortExpenses();
  sendLeftoverDelete();
  showScreen(state.screen === 'form' ? 'overview' : state.screen);
  loadExpenses();
  // Entries that failed only because the sign-in had expired: retry them now.
  for (const e of state.expenses) {
    if (e.status === 'failed' && e.errorCode === 'AUTH') saveExpense(e.id);
  }
}

/**
 * Shows one screen ('overview', 'history', 'settings' or 'form'), sets its
 * mesh background, highlights its tab, and closes any message from the
 * screen before ("stays up until you leave the screen").
 */
function showScreen(name) {
  if (name !== state.screen) hideToast();
  if (name !== 'history') stopSelecting();
  state.screen = name;
  for (const section of document.querySelectorAll('#app-main > .screen')) {
    section.hidden = section.id !== 'screen-' + name;
  }
  document.body.dataset.mesh = SCREEN_MESH[name];
  updateNav();
  renderScreen(name);
  window.scrollTo(0, 0);
  const title = document.querySelector('#screen-' + name + ' h1');
  if (title) title.setAttribute('tabindex', '-1');
}

/**
 * Shows the right bottom bar: the tabs normally, the selection bar in
 * History's edit mode, and nothing while editing (a full-screen task).
 */
function updateNav() {
  const editing = state.screen === 'form' && state.form && state.form.mode === 'edit';
  const current = state.screen === 'form' ? (editing ? '' : 'add') : state.screen;
  $('tabbar').hidden = editing || state.selecting;
  $('selectbar').hidden = !state.selecting;
  $('app-main').classList.toggle('no-nav', editing);
  $('toast').classList.toggle('no-nav', editing);
  for (const tab of document.querySelectorAll('[data-screen]')) {
    if (tab.dataset.screen === current) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
}

/** Redraws every screen that shows entries (cheap at this app's size). */
function renderAll() {
  renderScreen(state.screen);
}

/** Draws one screen from state. */
function renderScreen(name) {
  if (name === 'overview') renderOverview();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
}

/**
 * The offline banner: "No internet. Showing saved data." with Try Again.
 * Shown on Overview and History when the last refresh failed.
 */
function offlineBanner() {
  if (!state.offline) return null;
  return h('div', { class: 'banner banner-warning screen-banner', role: 'status' },
    icon('offline', 20),
    h('span', { class: 'banner-text' }, 'No internet. Showing saved data.'),
    h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: () => loadExpenses() }, 'Try Again'));
}

/** "Last updated 8:15 today" (or with the date), from state.lastSync. */
function lastUpdatedText() {
  if (!state.lastSync) return 'Not updated yet';
  const d = new Date(state.lastSync);
  const time = d.getHours() + ':' + pad2(d.getMinutes());
  const day = toDateText(d) === today() ? 'today' : formatDay(toDateText(d));
  return 'Last updated ' + time + ' ' + day;
}

/**
 * Draws Overview for state.period (a day, month or year):
 * a comparison with the period before, the total with averages, the biggest
 * day, the "This week" strip, spending by category, recent entries, and
 * Download Statement. Also its empty, loading and offline states.
 * Everything is calculated on the phone from entries already loaded.
 */
function renderOverview() {
  const screen = $('screen-overview');
  const period = state.period;
  const all = state.expenses;
  const entries = all.filter((e) => inPeriod(e.date, period));

  const head = h('div', { class: 'screen-head' },
    h('h1', { class: 'title', id: 'overview-title' }, 'Overview',
      all.length ? h('span', { class: 'sub' }, periodLabel(period)) : null),
    all.length ? h('button', {
      type: 'button', class: 'btn btn-secondary btn-icon head-button',
      'aria-label': 'Choose period. Showing ' + periodLabel(period),
      onclick: () => openPeriodSheet({ types: ['day', 'month', 'year'], value: period, onChoose: setOverviewPeriod }),
    }, icon('calendar', 22)) : null);

  // Loading: placeholder shapes in the same layout as the real cards,
  // so nothing jumps when the data arrives.
  if (!state.hasLoaded) {
    setChildren(screen, head,
      h('p', { class: 'visually-hidden', role: 'status' }, 'Loading your spending'),
      h('div', { class: 'skeleton', style: 'height:300px;margin:0 14px 20px', 'aria-hidden': 'true' }),
      h('div', { class: 'skeleton', style: 'height:230px;margin:0 14px 20px', 'aria-hidden': 'true' }),
      h('div', { class: 'skeleton', style: 'height:180px;margin:0 14px', 'aria-hidden': 'true' }));
    return;
  }

  // New user: nothing added yet.
  if (!all.length) {
    setChildren(screen, head, offlineBanner(),
      h('div', { class: 'empty' },
        h('h2', { class: 'title' }, 'Your overview', h('span', { class: 'sub' }, 'starts here.')),
        h('p', { class: 'caption' }, 'Add your first expense to see charts.'),
        h('button', { type: 'button', class: 'btn btn-primary btn-medium', onclick: openAddForm },
          icon('plus', 20, 2.4), 'Add Expense')));
    return;
  }

  // A period with no entries.
  if (!entries.length) {
    const words = period.type === 'day' ? 'on ' + formatDay(period.value) :
      period.type === 'year' ? 'in ' + period.value : 'in ' + formatMonthShort(period.value) + '.';
    const current = currentPeriod(period.type);
    setChildren(screen, head, offlineBanner(),
      h('div', { class: 'empty' },
        h('div', { class: 'empty-icon glass' }, icon('calendar', 40, 1.8)),
        h('h2', { class: 'title' }, 'No spending', h('span', { class: 'sub' }, words)),
        periodHasToday(period) ? null : h('button', {
          type: 'button', class: 'btn btn-secondary btn-medium',
          onclick: () => setOverviewPeriod(current),
        }, 'Go to This ' + (period.type === 'day' ? 'Day' : period.type === 'year' ? 'Year' : 'Month'))));
    return;
  }

  setChildren(screen, head, offlineBanner(), overviewHero(entries), overviewWeek(),
    overviewCategories(entries), overviewRecent(entries),
    h('button', { type: 'button', class: 'btn btn-secondary statement-button', onclick: () => openStatementSheet(statementMonthFor(period)) },
      icon('download', 20, 2.2), 'Download Statement'));
  restoreFocus(screen);
}

/** Sets Overview's period (from the Choose period pop-up) and redraws. */
function setOverviewPeriod(period) {
  state.period = period;
  state.weekDay = null;
  renderOverview();
}

/**
 * The stacked cards at the top: the comparison peeks out behind the total.
 * Offline, the comparison is replaced by when the data was last updated.
 */
function overviewHero(entries) {
  const period = state.period;
  const total = sumAmounts(entries);
  const stack = h('div', { class: 'hero-stack' });

  // Comparison with the period before.
  const before = previousPeriod(period);
  const beforeTotal = sumAmounts(state.expenses.filter((e) => inPeriod(e.date, before)));
  let compare = null;
  if (state.offline) {
    compare = h('div', { class: 'compare glass' }, h('span', null, lastUpdatedText()));
  } else if (beforeTotal > 0) {
    const diff = Math.round((total - beforeTotal) * 100) / 100;
    const name = period.type === 'month' ? MONTHS[parseDate(before.value + '-01').getMonth()] :
      period.type === 'day' ? (before.value === addDays(today(), -1) ? 'yesterday' : formatDay(before.value)) : before.value;
    compare = h('div', { class: 'compare glass' },
      h('span', null, 'Compared with ' + name),
      diff === 0 ? h('span', { class: 'change' }, 'The same') :
        h('span', { class: 'change' }, icon(diff < 0 ? 'arrowDown' : 'arrowUp', 18, 2.4),
          rm(Math.abs(diff)) + (diff < 0 ? ' less' : ' more')));
  }
  if (compare) stack.append(compare);

  // The total, with averages and the Add Expense button.
  const label = period.type === 'day' ? 'Spent on ' + formatDay(period.value) :
    period.type === 'year' ? 'Spent in ' + period.value : 'Spent this month';
  const stats = [];
  if (period.type === 'month') {
    const days = periodHasToday(period) ? parseDate(today()).getDate() : daysInMonth(period.value);
    stats.push(['Daily average', rm(total / days)]);
  } else if (period.type === 'year') {
    const months = period.value === today().slice(0, 4) ? new Date().getMonth() + 1 : 12;
    stats.push(['Monthly average', rm(total / months)]);
  } else {
    stats.push(['Largest', rm(Math.max(...entries.map((e) => e.amount)))]);
  }
  stats.push(['Entries', String(entries.length)]);

  const todayTotal = sumAmounts(state.expenses.filter((e) => e.date === today()));
  const showToday = period.type !== 'day' && periodHasToday(period);
  const hero = h('div', { class: 'hero' + (compare ? '' : ' alone') },
    h('div', null,
      h('p', { class: 'hero-label' }, label),
      h('p', { class: 'big-amount' }, h('span', { class: 'currency' }, 'RM'), amountNumber(total))),
    h('div', { class: 'hero-stats' }, stats.map(([k, v]) =>
      h('div', null, h('p', { class: 'stat-label' }, k), h('p', { class: 'stat-value' }, v)))),
    h('div', { class: 'hero-foot' },
      h('button', { type: 'button', class: 'btn btn-primary btn-medium', onclick: openAddForm }, icon('plus', 20, 2.4), 'Add Expense'),
      showToday ? h('div', { class: 'today' }, h('p', { class: 'stat-label' }, 'Today'), h('p', { class: 'stat-value' }, rm(todayTotal))) : null));
  stack.append(hero);

  // The biggest day of the month or year.
  if (period.type !== 'day') {
    const byDay = totalsByDay(entries);
    const days = Object.keys(byDay);
    if (days.length > 1) {
      const biggest = days.reduce((a, b) => (byDay[b] > byDay[a] ? b : a));
      stack.append(h('div', { class: 'biggest glass' }, 'Biggest day',
        h('strong', null, formatDay(biggest) + ', ' + rm(byDay[biggest]))));
    }
  }
  return stack;
}

/** {'2026-11-21': 46.3, ...}: the total for each day that has entries. */
function totalsByDay(entries) {
  const sen = {};
  for (const e of entries) sen[e.date] = (sen[e.date] || 0) + Math.round(e.amount * 100);
  for (const day of Object.keys(sen)) sen[day] /= 100;
  return sen;
}

/**
 * "This week": seven tall day buttons, Monday to Sunday, each with a bar as
 * tall as that day's spending. Tap a day to see its total underneath.
 * Shown for a month (the week of today, or the month's last week) or a day.
 */
function overviewWeek() {
  const period = state.period;
  if (period.type === 'year') return null;
  const focus = period.type === 'day' ? period.value :
    periodHasToday(period) ? today() : period.value + '-' + pad2(daysInMonth(period.value));
  const chosen = state.weekDay || focus;
  const monday = addDays(chosen, -((parseDate(chosen).getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const byDay = totalsByDay(state.expenses.filter((e) => e.date >= days[0] && e.date <= days[6]));
  const max = Math.max(0, ...days.map((d) => byDay[d] || 0));

  const buttons = days.map((day) => {
    const total = byDay[day] || 0;
    const future = day > today();
    const height = total > 0 ? Math.round(8 + (total / max) * 64) : 0;
    const d = parseDate(day);
    return h('button', {
      type: 'button',
      class: 'day',
      'aria-pressed': String(day === chosen),
      'aria-label': WEEKDAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' +
        (future ? 'not yet' : rm(total)),
      disabled: future,
      'data-key': 'day-' + day,
      onclick: () => { state.weekDay = day; keepFocus('day-' + day); renderOverview(); },
    },
    h('span', { class: 'bar-area' }, h('span', { class: 'bar' + (total > 0 ? '' : ' is-zero'), style: total > 0 ? 'height:' + height + 'px' : null })),
    h('span', { class: 'wd' }, WEEKDAYS[d.getDay()].slice(0, 3)),
    h('span', { class: 'n' }, d.getDate()));
  });

  const first = parseDate(days[0]);
  const last = parseDate(days[6]);
  const range = first.getMonth() === last.getMonth()
    ? first.getDate() + ' to ' + last.getDate() + ' ' + MONTHS[last.getMonth()].slice(0, 3)
    : first.getDate() + ' ' + MONTHS[first.getMonth()].slice(0, 3) + ' to ' + last.getDate() + ' ' + MONTHS[last.getMonth()].slice(0, 3);

  return h('section', { class: 'week glass', 'aria-labelledby': 'week-title' },
    h('div', { class: 'week-head' }, h('h2', { class: 'section-title', id: 'week-title' }, 'This week'), h('span', { class: 'caption' }, range)),
    h('div', { class: 'week-days' }, buttons),
    h('div', { class: 'week-foot', 'aria-live': 'polite' },
      h('span', null, formatDayLong(chosen)), h('span', { class: 'amount' }, rm(byDay[chosen] || 0))));
}

/**
 * "Where it went": the three biggest categories as coloured tiles (the
 * largest one tall), then the rest as a list. Each shows its share as a
 * number, so nothing depends on colour alone.
 */
function overviewCategories(entries) {
  const total = sumAmounts(entries);
  const rows = CATEGORIES
    .map((name) => ({ name, amount: sumAmounts(entries.filter((e) => e.category === name)) }))
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const pct = (amount) => Math.round((amount / total) * 100) + '%';

  const tiles = rows.slice(0, 3).map((row, i) =>
    h('div', { class: 'cat-tile' + (i === 0 && rows.length > 2 ? ' is-first' : ''), 'data-cat': row.name },
      h('p', { class: 'name' }, row.name),
      h('div', null, h('p', { class: 'pct' }, pct(row.amount)), h('p', { class: 'amt' }, rm(row.amount)))));
  const rest = rows.slice(3);

  return h('section', { 'aria-labelledby': 'cat-title' },
    h('h2', { class: 'block-title', id: 'cat-title' }, 'Where it went', h('span', { class: 'sub' }, 'by category')),
    h('div', { class: 'tiles' }, tiles),
    rest.length ? h('div', { class: 'card glass' }, h('div', { class: 'panel' },
      rest.map((row) => h('div', { class: 'cat-row', 'data-cat': row.name },
        h('span', { class: 'dot' }), h('span', { class: 'name' }, row.name),
        h('span', { class: 'pct' }, pct(row.amount)))))) : null);
}

/** "Recent": the latest five entries in the period, with See All. */
function overviewRecent(entries) {
  const month = statementMonthFor(state.period);
  return h('section', { 'aria-labelledby': 'recent-title' },
    h('div', { class: 'block-head' },
      h('h2', { class: 'section-title', id: 'recent-title' }, 'Recent'),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: () => { state.historyMonth = month; showScreen('history'); } }, 'See All')),
    h('div', { class: 'card glass' }, h('ul', { class: 'panel rows' },
      entries.slice(0, 5).map((e) => h('li', { class: 'row' },
        categoryTile(e.category),
        h('div', { class: 'row-main' }, h('p', { class: 'row-title' }, e.category),
          h('p', { class: 'row-note' }, e.note || formatDay(e.date))),
        h('span', { class: 'row-amount' }, rm(e.amount)))))));
}

/** The month a statement or History should open on for a period. */
function statementMonthFor(period) {
  if (period.type === 'year') return period.value === today().slice(0, 4) ? currentMonth() : period.value + '-12';
  return period.value.slice(0, 7);
}

// ===========================================================================
// 9. Choose period pop-up
// ===========================================================================

/**
 * Opens "Choose period". options.types lists the tabs to offer ('day',
 * 'month', 'year'); options.value is the current period; options.onChoose
 * gets the chosen period. Future dates are dashed and can't be chosen, and
 * the confirm button names exactly what will show.
 */
function openPeriodSheet(options) {
  const picker = {
    ...options,
    type: options.types.includes(options.value.type) ? options.value.type : options.types[0],
    selection: { ...options.value },
    cursor: (options.value.value + '-01-01').slice(0, 10), // the month/year being browsed
  };
  if (picker.selection.type !== picker.type) picker.selection = { type: picker.type, value: currentPeriod(picker.type).value };
  renderPeriodSheet(picker);
  openSheet();
}

/** Draws the Choose period pop-up for the picker's current tab. */
function renderPeriodSheet(picker) {
  const redraw = () => renderPeriodSheet(picker);
  const nowYear = Number(today().slice(0, 4));
  const firstYear = Math.min(nowYear - 1, ...state.expenses.map((e) => Number(e.date.slice(0, 4))));
  const cursorYear = Number(picker.cursor.slice(0, 4));
  const cursorMonth = picker.cursor.slice(0, 7);
  const spentDays = new Set(state.expenses.map((e) => e.date));
  let body;

  if (picker.type === 'month') {
    body = [
      pickerNav(String(cursorYear), cursorYear > firstYear, cursorYear < nowYear,
        (delta) => { picker.cursor = (cursorYear + delta) + '-01-01'; redraw(); }, 'Year'),
      h('div', { class: 'picker-grid' }, MONTHS.map((name, i) => {
        const value = cursorYear + '-' + pad2(i + 1);
        return h('button', {
          type: 'button', class: 'pick', 'aria-label': MONTHS[i] + ' ' + cursorYear, 'data-key': value,
          'aria-pressed': String(picker.selection.value === value), disabled: value > currentMonth(),
          onclick: () => { picker.selection = { type: 'month', value }; keepFocus(value); redraw(); },
        }, name.slice(0, 3));
      })),
    ];
  } else if (picker.type === 'day') {
    const blanks = (parseDate(cursorMonth + '-01').getDay() + 6) % 7; // Monday first
    const days = [];
    for (let i = 0; i < blanks; i++) days.push(h('span', { 'aria-hidden': 'true' }));
    for (let d = 1; d <= daysInMonth(cursorMonth); d++) {
      const value = cursorMonth + '-' + pad2(d);
      days.push(h('button', {
        type: 'button', class: 'pick' + (spentDays.has(value) ? ' has-spend' : ''),
        'aria-label': formatDayLong(value) + (spentDays.has(value) ? ', has spending' : ''),
        'aria-pressed': String(picker.selection.value === value), disabled: value > today(), 'data-key': value,
        onclick: () => { picker.selection = { type: 'day', value }; keepFocus(value); redraw(); },
      }, d));
    }
    body = [
      pickerNav(formatMonth(cursorMonth), cursorYear > firstYear || cursorMonth.slice(5) !== '01', cursorMonth < currentMonth(),
        (delta) => { picker.cursor = addMonths(cursorMonth, delta) + '-01'; redraw(); }, 'Month'),
      h('div', { class: 'weekday-row', 'aria-hidden': 'true' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h('span', null, d))),
      h('div', { class: 'picker-grid days' }, days),
    ];
  } else {
    const years = [];
    for (let y = firstYear; y <= nowYear; y++) years.push(String(y));
    body = [h('div', { class: 'picker-grid' }, years.map((y) => h('button', {
      type: 'button', class: 'pick', 'aria-pressed': String(picker.selection.value === y), 'data-key': y,
      onclick: () => { picker.selection = { type: 'year', value: y }; keepFocus(y); redraw(); },
    }, y)))];
  }

  const tabs = picker.types.length > 1 ? h('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Period' },
    picker.types.map((type) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(picker.type === type), 'data-key': 'tab-' + type,
      onclick: () => {
        keepFocus('tab-' + type);
        picker.type = type;
        if (picker.selection.type !== type) {
          // Keep roughly the same time when switching tabs.
          const base = picker.selection.value;
          picker.selection = type === 'year' ? { type, value: base.slice(0, 4) } :
            type === 'month' ? { type, value: (base.length >= 7 ? base.slice(0, 7) : base + '-' + (base === today().slice(0, 4) ? currentMonth().slice(5) : '12')) } :
            currentPeriod('day');
        }
        picker.cursor = (picker.selection.value + '-01-01').slice(0, 10); // browse where the choice is
        redraw();
      },
    }, type[0].toUpperCase() + type.slice(1)))) : null;

  fillSheet(
    sheetHead('Choose', 'period'),
    tabs, ...body,
    h('button', {
      type: 'button', class: 'btn btn-primary btn-block',
      onclick: () => { closeSheet(); picker.onChoose(picker.selection); },
    }, 'Show ' + periodLabel(picker.selection)));
  restoreFocus($('sheet'));
}

/** The "‹ 2026 ›" row at the top of a picker. */
function pickerNav(label, canGoBack, canGoForward, move, unit) {
  return h('div', { class: 'picker-nav' },
    h('button', { type: 'button', class: 'btn btn-secondary btn-icon btn-small', 'aria-label': 'Previous ' + unit, disabled: !canGoBack, 'data-key': 'prev', onclick: () => { keepFocus('prev'); move(-1); } }, icon('back', 20, 2.4)),
    h('span', { class: 'label', 'aria-live': 'polite' }, label),
    h('button', { type: 'button', class: 'btn btn-secondary btn-icon btn-small', 'aria-label': 'Next ' + unit, disabled: !canGoForward, 'data-key': 'next', onclick: () => { keepFocus('next'); move(1); } }, icon('next', 20, 2.4)));
}

// ===========================================================================
// 10. Add and Edit expense
// ===========================================================================

/** Wires up the form's fixed parts once: chips, date, note, photo, buttons. */
function setUpForm() {
  const chips = $('category-chips');
  for (const name of CATEGORIES) {
    chips.append(h('button', {
      type: 'button', class: 'chip', role: 'radio', 'aria-checked': 'false', 'data-cat': name, 'data-value': name,
      tabindex: '-1', onclick: () => selectCategory(name, true),
    }, icon(name, 20), name));
  }
  // Arrow keys move between chips, as in any radio group.
  chips.addEventListener('keydown', (event) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const current = CATEGORIES.indexOf(formCategory());
    selectCategory(CATEGORIES[(current + keys[event.key] + CATEGORIES.length) % CATEGORIES.length], true);
  });

  $('amount').addEventListener('input', () => { setAmountError(false); updateSaveLabel(); });
  $('note').addEventListener('input', updateNoteCount);
  $('date').addEventListener('change', updateDateLabel);
  $('date-change').addEventListener('click', openDatePicker);
  $('details-toggle').addEventListener('click', () => setDetailsOpen($('details-open').hidden));
  $('photo-add').addEventListener('click', () => $('photo-input').click());
  $('photo-replace').addEventListener('click', () => $('photo-input').click());
  $('photo-remove').addEventListener('click', removeFormPhoto);
  $('photo-input').addEventListener('change', handlePhotoChosen);
  $('form-cancel').addEventListener('click', cancelEdit);
  $('expense-form').addEventListener('submit', (event) => {
    event.preventDefault(); // stop the browser reloading the page
    if (state.form.mode === 'edit') saveEdit();
    else saveNewExpense();
  });
}

/** Opens Add Expense, empty, dated today, with the last category used. */
function openAddForm() {
  state.form = { mode: 'add', photo: null, saving: false };
  let last = 'Food';
  try { last = localStorage.getItem(LAST_CATEGORY_KEY) || 'Food'; } catch (err) { /* ignore */ }
  fillForm({ amount: '', category: CATEGORIES.includes(last) ? last : 'Food', date: today(), note: '' });
  $('form-top').hidden = true;
  $('form-title').firstChild.textContent = 'Add Expense ';
  $('details-toggle').hidden = false;
  setDetailsOpen(false);
  showPhoto(null);
  showScreen('form');
  $('amount').focus();
}

/**
 * Opens Edit Expense for a saved entry: a full-screen form with no tab bar,
 * so it's clear you're in the middle of a task. Delete stays in History,
 * away from Save.
 */
function openEditForm(id) {
  const expense = findExpense(id);
  if (!expense || expense.status) return;
  state.form = { mode: 'edit', id, original: { ...expense }, photo: { state: 'keep' }, saving: false };
  fillForm({ amount: amountNumber(expense.amount).replace(/,/g, ''), category: expense.category, date: expense.date, note: expense.note });
  $('form-top').hidden = false;
  $('form-title').firstChild.textContent = 'Edit Expense ';
  $('form-subtitle').textContent = expense.category + ', ' + formatDay(expense.date);
  $('details-toggle').hidden = true;
  setDetailsOpen(true);
  showPhoto(null);
  if (expense.hasReceipt) {
    getReceiptSrc(id).then((src) => {
      if (state.form && state.form.id === id && state.form.photo.state === 'keep') showPhoto(src);
    }).catch(() => { /* the thumbnail stays a placeholder */ });
    showPhoto('');
  }
  showScreen('form');
}

/** Puts values into the form and resets messages. */
function fillForm(values) {
  $('amount').value = values.amount;
  $('note').value = values.note || '';
  $('date').value = values.date;
  $('date').max = today();
  selectCategory(values.category, false);
  setAmountError(false);
  $('form-banner').hidden = true;
  $('photo-input').value = '';
  $('save-button').disabled = false;
  updateNoteCount();
  updateDateLabel();
  updateSaveLabel();
}

/** Marks one chip as chosen (aria-checked) and makes it the one Tab reaches. */
function selectCategory(name, focus) {
  for (const chip of $('category-chips').children) {
    const on = chip.dataset.value === name;
    chip.setAttribute('aria-checked', String(on));
    chip.tabIndex = on ? 0 : -1;
    if (on && focus) chip.focus();
  }
  updateSaveLabel();
}

/** The category chosen in the form. */
function formCategory() {
  const chip = $('category-chips').querySelector('[aria-checked="true"]');
  return chip ? chip.dataset.value : '';
}

/**
 * Reads the amount box: accepts "8.4", "8.40" or "1,234.50". Returns the
 * amount rounded to sen, or null if it isn't a usable amount.
 */
function readAmount() {
  const text = $('amount').value.replace(/[,\s]/g, '').replace(/^RM/i, '');
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(text)) return null;
  const amount = Math.round(Number(text) * 100) / 100;
  return amount > 0 && amount <= MAX_AMOUNT ? amount : null;
}

/** The Save button says exactly what happens: "Save RM 8.40". */
function updateSaveLabel() {
  const button = $('save-button');
  if (!state.form) return;
  setChildren(button);
  if (state.form.saving) {
    button.append('Saving…');
  } else if (state.form.mode === 'edit') {
    button.append(icon('check', 20, 2.6), 'Save Changes');
  } else {
    const amount = readAmount();
    button.append(amount ? 'Save ' + rm(amount) : 'Save');
  }
}

/** Shows or hides "Type an amount first." with the red outline. */
function setAmountError(on, message) {
  $('amount-panel').classList.toggle('is-invalid', on);
  $('amount').setAttribute('aria-invalid', String(on));
  $('amount-error').hidden = !on;
  if (message) $('amount-error').textContent = message;
}

/** "12 of 200" under the note. */
function updateNoteCount() {
  $('note-count').textContent = $('note').value.length + ' of ' + MAX_NOTE_LENGTH;
}

/** "Today", "Yesterday" or "Sat, 21 Nov", plus the long date under the title. */
function updateDateLabel() {
  const value = $('date').value || today();
  $('date-label').textContent = value === today() ? 'Today' : value === addDays(today(), -1) ? 'Yesterday' : formatDay(value);
  if (state.form && state.form.mode === 'add') $('form-subtitle').textContent = formatDayLong(value);
}

/** Opens the phone's date picker; older browsers show the date box instead. */
function openDatePicker() {
  const input = $('date');
  try {
    input.showPicker();
  } catch (err) {
    input.classList.remove('visually-hidden');
    input.classList.add('text-input');
    input.tabIndex = 0;
    input.focus();
  }
}

/** Opens or closes the "Note or Photo" part of the Add form. */
function setDetailsOpen(open) {
  $('details-open').hidden = !open;
  $('details-toggle').setAttribute('aria-expanded', String(open));
  setChildren($('details-chevron'), icon(open ? 'up' : 'down', 20));
}

/**
 * Checks the form. Returns the values, or null after showing what's wrong.
 * The server checks everything again; this just gives instant feedback.
 */
function readForm() {
  const amount = readAmount();
  if (!amount) {
    const typed = $('amount').value.trim();
    setAmountError(true, !typed ? 'Type an amount first.' :
      Number(typed.replace(/,/g, '')) > MAX_AMOUNT ? 'The amount can be at most RM 1,000,000.' : 'Type the amount in numbers, like 8.40.');
    $('amount').focus();
    return null;
  }
  const category = formCategory();
  const date = $('date').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) {
    showFormBanner('Choose a date that is today or earlier.');
    return null;
  }
  const note = $('note').value.trim().slice(0, MAX_NOTE_LENGTH);
  return { amount, category, date, note };
}

/** Shows a red message at the top of the form, optionally with Try Again. */
function showFormBanner(message, retry) {
  const banner = $('form-banner');
  setChildren(banner, icon('alert', 20), h('span', { class: 'banner-text' }, message),
    retry ? h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: retry }, 'Try Again') : null);
  banner.hidden = false;
  banner.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/**
 * Add Expense → Save: the entry shows at once and saves in the background
 * (see saveExpense). The id is made here, so a retry can't make a duplicate.
 */
function saveNewExpense() {
  if (state.form.preparingPhoto) return showFormBanner('Wait a moment, the photo is still being prepared.');
  const values = readForm();
  if (!values) return;
  const expense = {
    ...values,
    id: makeId(),
    hasReceipt: Boolean(state.form.photo),
    createdAt: new Date().toISOString(),
    status: 'saving',
  };
  if (state.form.photo) expense.receipt = state.form.photo;
  try { localStorage.setItem(LAST_CATEGORY_KEY, values.category); } catch (err) { /* ignore */ }

  state.expenses.push(expense);
  sortExpenses();
  saveCache();
  saveExpense(expense.id);

  // Ready for the next one: same category and date, empty amount and note.
  state.form.photo = null;
  $('amount').value = '';
  $('note').value = '';
  showPhoto(null);
  setDetailsOpen(false);
  updateNoteCount();
  updateSaveLabel();
  showToast('Saved ' + rm(expense.amount) + ' · ' + expense.category);
}

/** The edit form's current values, for comparing with the original. */
function editChanges() {
  const original = state.form.original;
  const amount = readAmount();
  const now = { amount, category: formCategory(), date: $('date').value, note: $('note').value.trim() };
  const changes = [];
  if (amount !== original.amount) changes.push(['Amount', rm(original.amount), amount ? rm(amount) : '—']);
  if (now.category !== original.category) changes.push(['Category', original.category, now.category]);
  if (now.date !== original.date) changes.push(['Date', formatDay(original.date), formatDay(now.date)]);
  if (now.note !== (original.note || '')) changes.push(['Note', original.note || '—', now.note || '—']);
  if (state.form.photo.state !== 'keep') changes.push(['Photo', original.hasReceipt ? 'Photo' : 'None', state.form.photo.state === 'remove' ? 'Removed' : 'New photo']);
  return changes;
}

/**
 * Edit → Cancel. With unsaved changes, asks first and shows exactly what
 * changed; "Keep Editing" is the raised button, "Discard" a red glass pill.
 */
function cancelEdit() {
  const changes = editChanges();
  if (!changes.length) return leaveEdit();
  fillSheet(
    h('h2', { class: 'sheet-title', id: 'sheet-title' }, 'Discard', h('span', { class: 'sub' }, 'changes?')),
    h('div', { class: 'panel' }, changes.map(([field, before, now]) => h('div', null,
      h('div', { class: 'kv' }, h('span', { class: 'k' }, field + ' before'), h('span', { class: 'v' }, before)),
      h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Now'), h('span', { class: 'v' }, now))))),
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: closeSheet }, 'Keep Editing'),
      h('button', { type: 'button', class: 'btn btn-secondary is-danger btn-block', onclick: () => { closeSheet(); leaveEdit(); } }, 'Discard')));
  openSheet();
}

/** Leaves the edit form for History. */
function leaveEdit() {
  state.form = null;
  showScreen('history');
}

/**
 * Edit → Save Changes. Unlike adding, this waits for the server, so if it
 * fails the user stays on the form with their changes kept and Try Again.
 * Afterwards, "Changes saved · Undo" (Undo is offered when the photo didn't
 * change, since a replaced photo is already in the trash).
 */
async function saveEdit() {
  const form = state.form;
  if (form.saving) return;
  if (form.preparingPhoto) return showFormBanner('Wait a moment, the photo is still being prepared.');
  const values = readForm();
  if (!values) return;
  if (!editChanges().length) return leaveEdit();

  form.saving = true;
  $('save-button').disabled = true;
  $('form-banner').hidden = true;
  updateSaveLabel();
  const photo = form.photo.state === 'new' ? form.photo.data : form.photo.state === 'remove' ? 'remove' : undefined;
  try {
    const result = await callApi('update', { expense: { id: form.id, ...values, photo } });
    const index = state.expenses.findIndex((e) => e.id === form.id);
    if (index !== -1) state.expenses[index] = result.expense;
    if (form.photo.state === 'new') state.receiptCache.set(form.id, 'data:image/jpeg;base64,' + form.photo.data.data);
    if (form.photo.state === 'remove') state.receiptCache.delete(form.id);
    state.recentlyEdited.add(form.id);
    sortExpenses();
    saveCache();
    const original = form.original;
    state.historyMonth = values.date.slice(0, 7);
    leaveEdit();
    showToast('Changes saved', form.photo.state === 'keep' ? { undo: () => undoEdit(original) } : {});
  } catch (err) {
    form.saving = false;
    $('save-button').disabled = false;
    updateSaveLabel();
    if (err.code === 'AUTH') return; // the sign-in screen is showing; the form is kept
    showFormBanner(err.code === 'NETWORK' ? "Couldn't save. Your changes are kept here." : "Couldn't save: " + err.message, saveEdit);
  }
}

/** Undo for an edit: sends the original values back. */
async function undoEdit(original) {
  hideToast();
  try {
    const { id, date, amount, category, note } = original;
    const result = await callApi('update', { expense: { id, date, amount, category, note } });
    const index = state.expenses.findIndex((e) => e.id === id);
    if (index !== -1) state.expenses[index] = result.expense;
    state.recentlyEdited.delete(id);
    sortExpenses();
    saveCache();
    renderAll();
    showToast('Changes undone');
  } catch (err) {
    if (err.code !== 'AUTH') showToast("Couldn't undo: " + err.message, { isError: true });
  }
}

// ===========================================================================
// 11. History
// ===========================================================================

/**
 * Draws History for state.historyMonth: entries grouped under each day with
 * the day's total. Tap an entry for Receipt, Edit and Delete. "Edit" in the
 * header switches to edit mode, where entries are chosen with checkboxes.
 */
function renderHistory() {
  const screen = $('screen-history');
  const month = state.historyMonth;
  const entries = state.expenses.filter((e) => e.date.startsWith(month + '-'));
  const parts = [];

  if (state.selecting) {
    const allChosen = entries.length > 0 && entries.every((e) => state.selected.has(e.id));
    parts.push(h('div', { class: 'select-head' },
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: stopSelecting }, 'Done'),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: () => toggleSelectAll(entries, allChosen) },
        allChosen ? 'Select None' : 'Select All')),
    h('div', { class: 'screen-head' },
      h('h1', { class: 'title', id: 'history-title', 'aria-live': 'polite' }, state.selected.size + ' selected',
        h('span', { class: 'sub' }, 'Tap to choose'))));
  } else {
    parts.push(h('div', { class: 'screen-head' },
      h('h1', { class: 'title', id: 'history-title' }, 'History',
        h('span', { class: 'sub' }, h('button', {
          type: 'button', class: 'month-button', 'aria-label': 'Choose month. Showing ' + formatMonth(month),
          onclick: () => openPeriodSheet({ types: ['month'], value: { type: 'month', value: month }, onChoose: (p) => { state.historyMonth = p.value; renderHistory(); } }),
        }, formatMonthShort(month), icon('down', 26, 2.4)))),
      entries.some((e) => !e.status) ? h('button', { type: 'button', class: 'btn btn-secondary btn-small head-button', onclick: startSelecting },
        icon('edit', 18, 2.2), 'Edit') : null));
  }
  parts.push(offlineBanner());

  if (!state.hasLoaded) {
    parts.push(h('p', { class: 'visually-hidden', role: 'status' }, 'Loading your entries'),
      h('div', { class: 'skeleton', style: 'height:220px;margin:0 14px 16px', 'aria-hidden': 'true' }),
      h('div', { class: 'skeleton', style: 'height:150px;margin:0 14px', 'aria-hidden': 'true' }));
  } else if (!entries.length) {
    const isNow = month === currentMonth();
    parts.push(h('div', { class: 'empty' },
      h('div', { class: 'empty-icon glass' }, icon('receipt', 40, 1.8)),
      h('h2', { class: 'title' }, 'No entries', h('span', { class: 'sub' }, isNow ? 'yet this month.' : 'in ' + formatMonthShort(month) + '.')),
      isNow ? h('button', { type: 'button', class: 'btn btn-primary btn-medium', onclick: openAddForm }, icon('plus', 20, 2.4), 'Add Expense')
        : h('button', { type: 'button', class: 'btn btn-secondary btn-medium', onclick: () => { state.historyMonth = currentMonth(); renderHistory(); } }, 'Go to This Month')));
  } else {
    const days = [...new Set(entries.map((e) => e.date))];
    for (const day of days) {
      const dayEntries = entries.filter((e) => e.date === day);
      parts.push(h('div', { class: 'day-head' },
        h('h2', null, formatDay(day)), h('span', { class: 'amount' }, rm(sumAmounts(dayEntries)))));
      parts.push(h('div', { class: 'card glass' }, h('ul', { class: 'panel rows', 'aria-label': formatDayLong(day) },
        dayEntries.map((e) => (state.selecting ? historySelectRow(e) : historyRow(e))))));
    }
  }
  setChildren(screen, ...parts.filter(Boolean));
  updateSelectBar();
  restoreFocus(screen);
}

/** One entry in History: tap to show its buttons; status underneath. */
function historyRow(expense) {
  const open = state.expandedId === expense.id;
  const item = h('li', null,
    h('button', {
      type: 'button', class: 'row row-button', 'aria-expanded': String(open), 'data-key': 'row-' + expense.id,
      onclick: () => { state.expandedId = open ? null : expense.id; keepFocus('row-' + expense.id); renderHistory(); },
    },
    categoryTile(expense.category),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title', style: 'display:block' }, expense.category),
      expense.note ? h('span', { class: 'row-note', style: 'display:block' }, expense.note) : null,
      state.recentlyEdited.has(expense.id) ? h('span', { class: 'tag' }, icon('edit', 14, 2.4), 'Edited just now') : null),
    h('span', { class: 'row-amount' }, rm(expense.amount))));

  if (expense.status === 'saving') {
    item.append(h('p', { class: 'row-status', style: 'padding:0 16px 12px 72px;margin:0' }, icon('clock', 18), 'Saving'));
  } else if (expense.status === 'failed') {
    item.append(h('div', { class: 'row-status is-failed', style: 'padding:0 16px 12px 72px;margin:0' },
      icon('alert', 18), h('span', { style: 'flex:1' }, 'Not saved. ' + (expense.error || '')),
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: () => saveExpense(expense.id) }, icon('retry', 18), 'Try Again')));
  }

  if (open) {
    item.append(h('div', { class: 'row-actions' },
      expense.hasReceipt ? h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: () => viewReceipt(expense.id) }, icon('receipt', 18), 'Receipt') : null,
      expense.status ? null : h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: () => openEditForm(expense.id) }, icon('edit', 18), 'Edit'),
      expense.status === 'saving' ? null : h('button', {
        type: 'button', class: 'btn btn-secondary btn-small is-danger',
        onclick: () => deleteWithUndo([expense.id], expense.category + ' ' + rm(expense.amount) + ' deleted'),
      }, icon('trash', 18), 'Delete')));
  }
  return item;
}

/** One entry in edit mode: a checkbox you tap to choose it. */
function historySelectRow(expense) {
  const on = state.selected.has(expense.id);
  const unsaved = Boolean(expense.status);
  return h('li', null, h('button', {
    type: 'button', class: 'row row-button', role: 'checkbox', 'aria-checked': String(on), disabled: unsaved,
    'data-key': 'pick-' + expense.id,
    onclick: () => { if (on) state.selected.delete(expense.id); else state.selected.add(expense.id); keepFocus('pick-' + expense.id); renderHistory(); },
  },
  h('span', { class: 'check' + (on ? ' is-on' : ''), style: 'margin-top:8px' }, on ? icon('check', 18, 3) : null),
  categoryTile(expense.category),
  h('span', { class: 'row-main' },
    h('span', { class: 'row-title', style: 'display:block' }, expense.category),
    h('span', { class: 'row-note', style: 'display:block' }, expense.note || (unsaved ? 'Not saved yet' : ''))),
  h('span', { class: 'row-amount' }, rm(expense.amount))));
}

/** Enters edit mode: the tab bar becomes one glass action bar. */
function startSelecting() {
  hideToast();
  state.selecting = true;
  state.selected.clear();
  state.expandedId = null;
  updateNav();
  renderHistory();
}

/** Leaves edit mode. */
function stopSelecting() {
  if (!state.selecting) return;
  state.selecting = false;
  state.selected.clear();
  updateNav();
  if (state.screen === 'history') renderHistory();
}

/** Select All / Select None for the month's saved entries. */
function toggleSelectAll(entries, allChosen) {
  for (const e of entries) {
    if (e.status) continue;
    if (allChosen) state.selected.delete(e.id);
    else state.selected.add(e.id);
  }
  renderHistory();
}

/** The action bar repeats the count, and turns dashed when nothing is chosen. */
function updateSelectBar() {
  const button = $('delete-selected');
  const n = state.selected.size;
  button.disabled = n === 0;
  setChildren(button, n ? icon('trash', 20, 2.2) : '', n ? 'Delete ' + plural(n, 'Entry', 'Entries') : 'Select Entries First');
}

/** Asks before deleting the chosen entries, listing them. */
function confirmDeleteSelected() {
  const chosen = state.expenses.filter((e) => state.selected.has(e.id));
  if (!chosen.length) return;
  const n = chosen.length;
  fillSheet(
    h('h2', { class: 'sheet-title', id: 'sheet-title' }, 'Delete', h('span', { class: 'sub' }, plural(n, 'entry', 'entries') + '?')),
    h('div', { class: 'panel' },
      chosen.slice(0, 6).map((e) => h('div', { class: 'kv' },
        h('span', { class: 'k' }, e.category + ', ' + formatDay(e.date)), h('span', { class: 'v' }, rm(e.amount)))),
      n > 6 ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'and ' + plural(n - 6, 'more entry', 'more entries'))) : null),
    h('div', { class: 'sheet-actions' },
      h('button', {
        type: 'button', class: 'btn btn-danger btn-block',
        onclick: () => {
          closeSheet();
          const ids = chosen.map((e) => e.id);
          stopSelecting();
          deleteWithUndo(ids, plural(n, 'entry', 'entries') + ' deleted');
        },
      }, 'Delete ' + plural(n, 'Entry', 'Entries')),
      h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: closeSheet }, 'Cancel')));
  openSheet();
}

// ===========================================================================
// 12. Receipts
// ===========================================================================

/**
 * Runs when the user picks or takes a photo. Phone photos are often 3–8 MB,
 * so we shrink it first (compressImage), then keep it with the form until
 * Save. Saving waits while this runs.
 */
async function handlePhotoChosen() {
  const file = $('photo-input').files[0];
  if (!file) return;
  state.form.preparingPhoto = true;
  $('save-button').disabled = true;
  $('form-banner').hidden = true;
  try {
    const blob = await compressImage(file);
    const data = await blobToBase64(blob);
    const photo = { mimeType: 'image/jpeg', data };
    if (state.form.mode === 'edit') state.form.photo = { state: 'new', data: photo };
    else state.form.photo = photo;
    showPhoto('data:image/jpeg;base64,' + data);
  } catch (err) {
    showFormBanner(err.message);
  } finally {
    $('photo-input').value = '';
    if (state.form) {
      state.form.preparingPhoto = false;
      $('save-button').disabled = false;
    }
  }
}

/** Remove Photo: in Add, forget it; in Edit, mark it to be removed on save. */
function removeFormPhoto() {
  if (state.form.mode === 'edit') state.form.photo = state.form.original.hasReceipt ? { state: 'remove' } : { state: 'keep' };
  else state.form.photo = null;
  showPhoto(null);
}

/**
 * Shows the photo area: src = an image to show, '' = a placeholder while
 * loading, null = no photo. Buttons change to match (Add / Replace + Remove).
 */
function showPhoto(src) {
  const thumb = $('photo-thumb');
  const has = src !== null;
  thumb.hidden = !has;
  if (src) thumb.src = src;
  else thumb.removeAttribute('src');
  $('photo-add').hidden = has;
  $('photo-replace').hidden = !has || state.form.mode !== 'edit';
  $('photo-remove').hidden = !has;
}

/**
 * Shrinks a photo so its longest side is at most PHOTO_MAX_SIZE pixels and
 * saves it as a JPEG: load it into an <img>, draw it smaller on a <canvas>,
 * then ask the canvas for a JPEG. Browsers turn phone photos the right way up.
 */
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, PHOTO_MAX_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // JPEG has no transparency: use white, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY));
    if (!blob) throw new Error('Could not prepare the photo. Try another one.');
    if (blob.size > 2 * 1024 * 1024) throw new Error('This photo is too large. Try another one.');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Loads an image from a URL and waits until it is ready to draw. */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This file is not a photo the browser can open.'));
    img.src = url;
  });
}

/** Turns a file into base64 text (the part after "data:image/jpeg;base64,"). */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * The photo for an entry, as an image address: from the entry itself (not
 * uploaded yet), the memory cache, or the server (which only gives it to
 * the entry's owner).
 */
async function getReceiptSrc(id) {
  const expense = findExpense(id);
  if (expense && expense.receipt) return 'data:image/jpeg;base64,' + expense.receipt.data;
  if (state.receiptCache.has(id)) return state.receiptCache.get(id);
  const result = await callApi('getReceipt', { id });
  const src = 'data:image/jpeg;base64,' + result.data;
  state.receiptCache.set(id, src);
  return src;
}

/** Opens the receipt viewer: the photo on the Night mesh, full screen. */
async function viewReceipt(id) {
  const expense = findExpense(id);
  if (!expense) return;
  const viewer = $('receipt-viewer');
  const status = h('p', { class: 'caption', role: 'status' }, 'Loading receipt…');
  const wrap = h('div', { class: 'viewer-image-wrap' }, status);
  viewer.dataset.id = id;
  setChildren(viewer, 
    h('h2', { class: 'visually-hidden', id: 'viewer-title' }, 'Receipt'),
    wrap,
    h('div', null,
      h('p', { class: 'viewer-title' }, expense.category + ', ' + rm(expense.amount)),
      h('p', { class: 'caption' }, formatDay(expense.date, true))),
    h('button', { type: 'button', class: 'btn btn-secondary btn-block', style: 'background:#fff;color:#0b0d12', onclick: () => viewer.close() }, 'Close'));
  viewer.showModal();
  try {
    const src = await getReceiptSrc(id);
    if (viewer.open && viewer.dataset.id === id) {
      setChildren(wrap, h('img', { src, alt: 'Receipt photo for ' + expense.category + ', ' + rm(expense.amount) }));
    }
  } catch (err) {
    status.textContent = 'Could not load the receipt: ' + err.message;
  }
}

// ===========================================================================
// 13. Settings and Delete my data
// ===========================================================================

/** Draws Settings: who is signed in, then Sign Out, Statement, Privacy, Delete. */
function renderSettings() {
  const user = state.user || {};
  const name = user.name || user.email || '';
  setChildren($('screen-settings'), 
    h('div', { class: 'screen-head' }, h('h1', { class: 'title', id: 'settings-title' }, 'Settings')),
    h('div', { class: 'card glass' }, h('div', { class: 'panel profile' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, (name[0] || '?').toUpperCase()),
      h('div', { style: 'min-width:0' }, h('p', { class: 'name' }, user.name || 'Signed in'), h('p', { class: 'email' }, user.email)))),
    h('div', { class: 'card glass' }, h('div', { class: 'panel' },
      h('button', { type: 'button', class: 'settings-row', onclick: signOut }, icon('signOut', 22), h('span', { class: 'grow' }, 'Sign Out')),
      h('button', { type: 'button', class: 'settings-row', onclick: () => openStatementSheet(currentMonth()) }, icon('download', 22), h('span', { class: 'grow' }, 'Download Statement'), icon('next', 18)),
      h('a', { class: 'settings-row', href: 'privacy.html' }, icon('shield', 22), h('span', { class: 'grow' }, 'Privacy Policy'), icon('next', 18)))),
    h('div', { class: 'card glass' }, h('div', { class: 'panel' },
      h('button', { type: 'button', class: 'settings-row is-danger', onclick: openDeleteDataSheet }, icon('trash', 22), h('span', { class: 'grow' }, 'Delete My Data')))));
}

/**
 * "Delete everything?" — says exactly how much will go, and only allows the
 * red button once DELETE is typed (it shows "Ready" when it is).
 */
function openDeleteDataSheet() {
  const saved = savedExpenses();
  const photos = saved.filter((e) => e.hasReceipt).length;
  const input = h('input', { id: 'delete-confirm-input', class: 'text-input', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
  const ready = h('span', { class: 'ready', hidden: true }, icon('check', 16, 2.6), 'Ready');
  const error = h('div', { class: 'banner banner-error', role: 'alert', hidden: true });
  const button = h('button', { type: 'button', class: 'btn btn-danger btn-block', disabled: true }, 'Delete All');
  input.addEventListener('input', () => {
    const ok = input.value.trim().toUpperCase() === 'DELETE';
    button.disabled = !ok;
    ready.hidden = !ok;
  });
  button.addEventListener('click', async () => {
    if (state.expenses.some((e) => e.status === 'saving')) {
      setChildren(error, icon('alert', 20), h('span', { class: 'banner-text' }, 'Some entries are still saving. Wait a few seconds and try again.'));
      error.hidden = false;
      return;
    }
    button.disabled = true;
    button.textContent = 'Deleting…';
    try {
      await commitPendingDelete();
      const result = await callApi('deleteMyData');
      closeSheet();
      clearUserData();
      showSignIn('Your data was deleted: ' + plural(result.deletedRows, 'entry', 'entries') + ' and ' +
        plural(result.deletedReceipts, 'photo', 'photos') + '.', 'info');
    } catch (err) {
      setChildren(error, icon('alert', 20), h('span', { class: 'banner-text' }, "Couldn't delete your data: " + err.message));
      error.hidden = false;
      button.disabled = false;
      button.textContent = 'Delete All';
    }
  });
  fillSheet(
    h('h2', { class: 'sheet-title', id: 'sheet-title' }, 'Delete', h('span', { class: 'sub' }, 'everything?')),
    h('p', { class: 'sheet-message' }, plural(saved.length, 'entry', 'entries') + ' and ' + plural(photos, 'photo', 'photos') + ". You can't get them back."),
    h('div', null, h('label', { class: 'field-label', for: 'delete-confirm-input' }, 'Type DELETE to confirm', ready), input),
    error,
    h('div', { class: 'sheet-actions' }, button,
      h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: closeSheet }, 'Keep My Data')));
  openSheet();
  input.focus();
}

// ===========================================================================
// 14. PDF statement
// ===========================================================================

/**
 * "Download statement" for a month. Shows the month (tap to change), how many
 * entries it has, and what the PDF contains. With no entries, the button is
 * dashed and says why: "Nothing to Download".
 */
function openStatementSheet(month) {
  const entries = savedExpenses().filter((e) => e.date.startsWith(month + '-'));
  const unsaved = state.expenses.some((e) => e.status && e.date.startsWith(month + '-'));
  const monthName = MONTHS[Number(month.slice(5)) - 1];
  fillSheet(
    sheetHead('Download', 'statement'),
    h('div', { class: 'panel' },
      h('button', {
        type: 'button', class: 'details-row', 'aria-label': 'Month: ' + formatMonth(month) + '. Change month',
        onclick: () => openPeriodSheet({ types: ['month'], value: { type: 'month', value: month }, onChoose: (p) => openStatementSheet(p.value) }),
      }, h('span', { class: 'grow', style: 'font-weight:500;color:#4b505b' }, 'Month'), formatMonth(month), icon('next', 18)),
      h('div', { class: 'details-row', style: 'font-weight:500' }, h('span', { class: 'grow', style: 'color:#4b505b' }, 'Entries'), h('span', { style: 'font-weight:600' }, String(entries.length)))),
    entries.length ? h('div', { class: 'panel', style: 'display:flex;gap:14px;padding:16px;align-items:flex-start' },
      h('span', { class: 'tile', style: '--tile:#eef0f3;--cat:#0b0d12' }, icon('file', 22)),
      h('div', null, h('p', { style: 'font-weight:600' }, 'PDF Document'),
        h('p', { class: 'caption' }, 'Easy to print or share. Receipt photos are not included.' + (unsaved ? ' Entries not saved yet are left out.' : ''))))
      : h('div', { class: 'banner banner-warning', role: 'status' }, icon('info', 20),
        h('span', { class: 'banner-text' }, 'No entries in ' + formatMonthShort(month) + '. Pick another month.')),
    entries.length
      ? h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: () => downloadStatement(month, entries) }, icon('download', 20, 2.4), 'Download ' + monthName)
      : h('button', { type: 'button', class: 'btn btn-block', disabled: true }, 'Nothing to Download'));
  openSheet();
}

/**
 * Makes the PDF (statement.js does the drawing), saves it to the phone, and
 * shows "Statement ready" with Open and, where the phone supports it, Share.
 */
function downloadStatement(month, entries) {
  let pdf;
  try {
    pdf = SenStatement.build({
      month,
      monthLabel: formatMonth(month),
      email: state.user.email,
      entries: entries.slice().sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? -1 : 1) : a.date < b.date ? -1 : 1)),
      generatedAt: new Date(),
    });
  } catch (err) {
    console.error(err);
    showToast("Couldn't make the statement. Please try again.", { isError: true });
    return;
  }
  const file = new File([pdf.bytes], pdf.fileName, { type: 'application/pdf' });
  const url = URL.createObjectURL(file);
  const link = h('a', { href: url, download: pdf.fileName, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();

  const canShare = navigator.canShare && navigator.canShare({ files: [file] });
  fillSheet(
    sheetHead('Statement', 'ready.'),
    h('div', { class: 'panel', style: 'display:flex;gap:14px;padding:16px;align-items:center' },
      h('span', { class: 'tile', style: '--tile:#eef0f3;--cat:#0b0d12' }, icon('file', 22)),
      h('div', { style: 'min-width:0' }, h('p', { style: 'font-weight:600;overflow-wrap:anywhere' }, pdf.fileName),
        h('p', { class: 'caption' }, plural(pdf.pages, 'page', 'pages') + ' · saved to your downloads'))),
    h('div', { class: 'sheet-actions' + (canShare ? ' side-by-side' : '') },
      h('a', { class: 'btn btn-primary', href: url, target: '_blank', rel: 'noopener' }, icon('file', 20, 2.2), 'Open'),
      canShare ? h('button', {
        type: 'button', class: 'btn btn-secondary',
        onclick: () => navigator.share({ files: [file], title: pdf.fileName }).catch(() => { /* cancelled */ }),
      }, icon('share', 20, 2.2), 'Share') : null));
}

// ===========================================================================
// 15. Toast, banners and pop-ups
// ===========================================================================

/**
 * Shows the dark message above the tab bar. It stays up until it's closed or
 * the user leaves the screen. options.undo adds an Undo button;
 * options.onClose runs when the message goes away for any reason (used to
 * send a waiting delete); options.isError shows an error mark.
 */
function showToast(message, options = {}) {
  hideToast();
  const toast = $('toast');
  state.toast = { onClose: options.onClose };
  toast.classList.toggle('is-error', Boolean(options.isError));
  toast.setAttribute('role', options.isError ? 'alert' : 'status');
  setChildren(toast, 
    h('span', { class: 'toast-icon' }, icon(options.isError ? 'alert' : 'check', 22, 2.6)),
    h('span', { class: 'toast-text' }, message),
    options.undo ? h('button', { type: 'button', class: 'toast-button', onclick: options.undo }, icon('undo', 18, 2.2), 'Undo') : null,
    h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Close message', onclick: hideToast }, icon('close', 20, 2.4)));
  toast.hidden = false;
}

/** Closes the message (and runs its onClose, e.g. sends a waiting delete). */
function hideToast() {
  const current = state.toast;
  state.toast = null;
  $('toast').hidden = true;
  if (current && current.onClose) current.onClose();
}

/** The two-tone title row of a pop-up, with a close button. */
function sheetHead(line1, line2) {
  return h('div', { class: 'sheet-head' },
    h('h2', { class: 'sheet-title', id: 'sheet-title' }, line1, h('span', { class: 'sub' }, line2)),
    h('button', { type: 'button', class: 'btn btn-secondary btn-icon', 'aria-label': 'Close', onclick: closeSheet }, icon('close', 20, 2.4)));
}

/** Replaces the pop-up's content (one <dialog> is reused for every pop-up). */
function fillSheet(...children) {
  setChildren($('sheet'), h('div', { class: 'sheet-body' }, children));
}

/**
 * Opens the pop-up. Tapping the pale area around it closes it, like most
 * apps: a tap on the backdrop is reported as a tap on the <dialog> itself,
 * outside its box.
 */
function openSheet() {
  const sheet = $('sheet');
  if (!sheet.open) sheet.showModal();
  if (!sheet.dataset.wired) {
    sheet.dataset.wired = 'yes';
    sheet.addEventListener('click', (event) => {
      const box = sheet.getBoundingClientRect();
      const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
      if (event.target === sheet && outside) closeSheet();
    });
  }
}

/** Closes the pop-up and the receipt viewer if they're open. */
function closeSheet() {
  if ($('sheet').open) $('sheet').close();
  if ($('receipt-viewer').open) $('receipt-viewer').close();
}

start();
