// app.js — Sen Tracker's logic: sign-in, talking to the script, every screen.
//
// Big picture:
//   1. Google Sign-In gives us an "ID token" (a signed text that says who the
//      user is). We keep it and send it with every request.
//   2. callApi() POSTs {action, idToken, ...} to the Apps Script URL. In demo
//      mode it answers from sample data in memory instead (demoApi).
//   3. Entries are encrypted on this phone (crypto.js) before they're sent,
//      so the server only stores scrambled text. After signing in, the user
//      unlocks them with their passphrase (or a key remembered on this
//      device); passphrase.js draws those screens.
//   4. The decrypted entries live in state.expenses. The encrypted copies are
//      cached in localStorage, so screens draw instantly, even offline; the
//      server is refreshed in the background. Every screen is drawn from
//      state by a render function.
//   5. New entries appear at once and save in the background. Deletes wait
//      until the "Undo" message is closed before they reach the server.
//
// Sections (search for the numbers):
//   1. Settings and state      9. Choose period pop-up
//   2. Icons and tiny helpers  10. Add and Edit expense
//   3. Start-up and demo       11. History
//   4. Sign-in and session     12. Receipts
//   5. Talking to the script   13. Settings, Help, What the Developer Can See
//   6. Entries, encryption     14. PDF statement
//      and the cache           15. Toast, notices and pop-ups
//   7. Dates and money
//   8. Navigation and Overview

'use strict';

// ===========================================================================
// 1. Settings and state
// ===========================================================================

// The server can't read entries any more, so these checks happen here only.
const CATEGORIES = ['Food', 'Transport', 'Bills', 'Shopping', 'Health', 'Entertainment', 'Other'];
const MAX_AMOUNT = 1000000;
const MAX_NOTE_LENGTH = 200;

const TOKEN_KEY = 'sen.session';               // where the sign-in is kept
const CACHE_PREFIX = 'sen.expenses.';          // + email: one cache per user (encrypted)
const PENDING_DELETE_PREFIX = 'sen.pendingDelete.'; // + email: deletes not sent yet
const NAME_PREFIX = 'sen.name.';               // + email: the name chosen in Settings
const LAST_CATEGORY_KEY = 'sen.lastCategory';  // the category used last time
const EXPIRY_MARGIN_MS = 60 * 1000;            // treat tokens as expired 1 min early
const REFRESH_BEFORE_MS = 5 * 60 * 1000;       // try to renew the sign-in 5 min before it ends
const PHOTO_MAX_SIZE = 1280;                   // longest side of a receipt photo, in pixels
const PHOTO_QUALITY = 0.75;                    // JPEG quality: text stays readable, files ~150 KB
const CODE_URL = 'https://github.com/hendricklarsson/budget-app';

// Everything the app currently knows, in one place.
const state = {
  idToken: null,        // the raw Google ID token, sent to the script
  user: null,           // {email, name, exp} read from the token, for display only
  demo: false,          // true in demo mode: sample data in memory, nothing saved
  demoStore: null,      // demo mode's pretend server: {rows, photos}

  // Encryption (see crypto.js and passphrase.js)
  keys: undefined,      // the user's key box (text); null = no passphrase yet; undefined = not known yet
  vault: null,          // the unlocked data key: {key, keyId, raw?}. raw only right after typing
  storedRows: null,     // encrypted rows waiting for the user to unlock
  legacyRows: null,     // rows from before encryption, waiting for the first setup
  remember: true,       // "Remember on This Device" (on by default)

  // The user's entries, decrypted. Each is
  // {id, date, time, amount, category, note, hasReceipt, createdAt, data,
  //  legacy?, status?, error?, errorCode?, receiptData?}
  // data is the encrypted copy (what the server stores). status is only set
  // on entries not yet on the server: 'saving' or 'failed'; receiptData is
  // their encrypted photo waiting to be uploaded. legacy marks entries saved
  // before encryption, until they're encrypted (passphrase.js, "Securing").
  expenses: [],
  hasLoaded: false,     // true once the server (or the cache) has answered
  offline: false,       // true when the last refresh couldn't reach the server
  lastSync: null,       // when entries last came from the server (ms)
  deleting: new Set(),  // ids being deleted right now (a refresh won't bring them back)
  pendingDelete: null,  // {entries, serverIds} hidden but not deleted yet (Undo possible)
  recentlyEdited: new Set(), // ids edited this session ("Edited just now")
  receiptCache: new Map(),   // id → image already loaded, so opening it twice is instant

  screen: 'overview',   // 'overview' | 'history' | 'settings' | 'form'
  previousScreen: 'overview', // where Back on the form returns to
  period: null,         // Overview's period: {type: 'day'|'month'|'year', value}
  weekDay: null,        // the day picked in Overview's "This Week" strip
  historyMonth: null,   // 'yyyy-mm' shown in History
  historyFilter: 'All', // History's category filter
  selecting: false,     // History's edit mode (choosing entries)
  selected: new Set(),  // ids chosen in edit mode
  form: null,           // the Add/Edit form: {mode, id?, original?, photo, saving, failed}

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
  history: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3 4v4.5h4.5M12 7.5V12l3 2',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM10 15a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
  plus: 'M12 5v14M5 12h14',
  calendar: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v5l3 2',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 10a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z',
  next: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  down: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  alert: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v6M12 16.5v.5',
  info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 8v5M12 16h.01',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  share: 'M12 3v12M7 8l5-5 5 5M5 14v6h14v-6',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  offline: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M3 3l18 18',
  signOut: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  equals: 'M6 9.5h12M6 14.5h12',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  lockSmall: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  key: 'M14 10a4 4 0 1 0-1.2 2.8L20 20M17 17l2-2',
  refresh: 'M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4',
  phone: 'M7 3h10v18H7zM11 18h2',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  money: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM9 9.5h4.5a2 2 0 0 1 0 4H10.5a2 2 0 0 0 0 4H15M12 7v2M12 17v2',
  tag: 'M3 12V4h8l10 10-8 8zM7 8h1',
  noteLines: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  hash: 'M5 9h14M5 15h14M10 4L8 20M16 4l-2 16',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  help: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
};
// Category icons: an outline plus a soft filled shape behind it.
const CATEGORY_ICONS = {
  Food: 'M3.5 11.5h17a8.5 8.5 0 0 1-17 0zM13.5 3l-2.5 8.5M19.5 4.5l-6 7',
  Transport: 'M4 17v-5l2.2-5.2A2 2 0 0 1 8 5.5h8a2 2 0 0 1 1.8 1.3L20 12v5zM4 12h16M7 14.5h2M15 14.5h2M6 17v2.5M18 17v2.5',
  Bills: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21zM9 8h6M9 12h6M9 16h3',
  Shopping: 'M5 8h14l-1.2 11.2A2 2 0 0 1 15.8 21H8.2a2 2 0 0 1-2-1.8zM9 10V7a3 3 0 0 1 6 0v3',
  Health: 'M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20zM12 10.5v5M9.5 13h5',
  Entertainment: 'M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4zM14 7v2M14 11v2M14 15v2',
  Other: 'M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z',
};
const ICON_FILLS = {
  Food: 'M3.5 11.5h17a8.5 8.5 0 0 1-17 0z',
  Transport: 'M4 12h16v5H4z',
  Bills: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z',
  Shopping: 'M5 8h14l-1.2 11.2A2 2 0 0 1 15.8 21H8.2a2 2 0 0 1-2-1.8z',
  Health: 'M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z',
  Entertainment: 'M3 7h11v10H3v-3a2 2 0 0 0 0-4z',
  Other: 'M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z',
  home: 'M4 11l8-7 8 7v9H4z',
  history: 'M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 1 1 0-17z',
  settings: 'M16 5a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM10 15a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
};

// Shortcut for document.getElementById.
const $ = (id) => document.getElementById(id);

/**
 * Makes an SVG icon. Icons are decoration (the text next to them says what
 * they mean), so screen readers skip them (aria-hidden). Category and tab
 * icons get a soft filled shape behind the outline.
 */
function icon(name, size = 20, strokeWidth = 2) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('stroke-width', strokeWidth);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  if (ICON_FILLS[name]) {
    const fill = document.createElementNS(ns, 'path');
    fill.setAttribute('d', ICON_FILLS[name]);
    fill.setAttribute('class', 'fill');
    svg.append(fill);
  }
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] || CATEGORY_ICONS[name]);
  svg.append(path);
  return svg;
}

/**
 * Builds an element in one line, e.g.
 *   h('button', {class: 'btn', onclick: save}, icon('check'), 'Save')
 * Props: class, on<event> handlers, anything else becomes an attribute
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
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/**
 * Replaces an element's content. Like el.replaceChildren(), but skips empty
 * parts (null, undefined, false), so optional pieces can be written inline
 * as  condition ? part : null  without the word "null" appearing on screen.
 */
function setChildren(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
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

/** The coloured icon tile used in lists. */
function categoryTile(category, big) {
  return h('span', { class: 'tile' + (big ? ' big' : ''), 'data-cat': category }, icon(category, big ? 20 : 18));
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

/** The screen's coloured wash (see .mesh in style.css). */
function setWash(name) {
  document.body.dataset.wash = name;
}

// ===========================================================================
// 3. Start-up and demo
// ===========================================================================

/**
 * Runs once when the page loads: wires up the fixed parts of the page, sets
 * up Google's sign-in, and restores a saved sign-in if it is still valid.
 */
function start() {
  registerServiceWorker();
  moveOldStorage();

  state.period = { type: 'month', value: currentMonth() };
  state.historyMonth = currentMonth();

  // Icons in the fixed HTML (tab bar, form rows).
  for (const slot of document.querySelectorAll('[data-icon]')) {
    slot.replaceWith(icon(slot.dataset.icon, Number(slot.dataset.size) || 20, slot.dataset.icon === 'plus' ? 2.6 : 2.1));
  }
  $('amount-error-icon').replaceWith(icon('alert', 18));

  // Tab bar.
  for (const tab of document.querySelectorAll('[data-screen]')) {
    tab.addEventListener('click', () => (tab.dataset.screen === 'add' ? openAddForm() : showScreen(tab.dataset.screen)));
  }

  setUpForm();
  $('delete-selected').addEventListener('click', confirmDeleteSelected);
  $('demo-button').addEventListener('click', enterDemo);
  $('signin-see').addEventListener('click', openDeveloperPage);

  // Phones pause timers while the app is in the background, so when it comes
  // back we check the sign-in again. When it goes to the background, we send
  // any delete that was waiting for its Undo message to close.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') commitPendingDelete();
    if (document.visibilityState === 'visible' && state.idToken && !state.demo) scheduleSessionTimers();
  });

  if (CLIENT_ID.startsWith('PASTE_') || SCRIPT_URL.startsWith('PASTE_')) {
    showSignIn('Setup needed: put your Client ID and Script URL in config.js. You can still try the demo.', 'error');
    return;
  }

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
 * The app used to be called Budget Tracker and stored things under
 * "budget.…" names. This moves them to the "sen.…" names once, so nobody is
 * signed out after the rename.
 */
function moveOldStorage() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('budget.')) continue;
      const newKey = 'sen.' + key.slice('budget.'.length);
      if (localStorage.getItem(newKey) === null) localStorage.setItem(newKey, localStorage.getItem(key));
      localStorage.removeItem(key);
    }
  } catch (err) {
    // storage blocked or full: nothing to move
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
 * "Try the Demo, No Sign-In": opens the app with about seven weeks of sample
 * spending, so the screens aren't empty. It uses real encryption with a
 * throwaway key, so it behaves exactly like the real thing. Everything stays
 * in memory: nothing is sent or stored, and leaving clears it.
 */
async function enterDemo() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await SenVault.importDataKey(raw, false);
  const rows = await Promise.all(makeDemoEntries().map(async (e) =>
    ({ id: e.id, data: await SenVault.encryptEntry(key, e), hasReceipt: false, createdAt: e.createdAt })));
  state.demo = true;
  state.demoStore = { rows, photos: new Map() };
  state.vault = { key, keyId: 'demo' };
  state.keys = 'demo';
  state.idToken = 'demo';
  state.user = { email: '', name: 'Demo Visitor', exp: Date.now() / 1000 + 365 * 86400 };
  state.screen = 'overview';
  showApp();
}

/**
 * Leaves the demo (Sign In, or Exit Demo): forgets all sample data and goes
 * to the sign-in screen.
 */
function exitDemo(message = 'You left the demo. Nothing from it was kept.') {
  clearUserData();
  showSignIn(message, 'info');
}

/**
 * The demo's sample spending: one to three entries a day from about seven
 * weeks ago to today, chosen by fixed rules (not random), so it looks the
 * same every time.
 */
function makeDemoEntries() {
  const items = {
    Food: [['Nasi lemak, teh tarik', 12.5], ['Roti canai', 6.5], ['Mamak dinner', 18.2], ["Groceries, Lotus's", 96.4], ['Kopitiam breakfast', 9.8], ['Mixed rice lunch', 11.5]],
    Transport: [['Grab to KLCC', 8.4], ['LRT top-up', 50], ['Petrol', 60], ['Touch n Go reload', 50]],
    Bills: [['TNB electricity', 142.8], ['Unifi internet', 129], ['Mobile plan', 68], ['Water bill', 17]],
    Shopping: [['Uniqlo socks', 25.4], ['Mr DIY', 117.9], ['Watsons', 24.9]],
    Health: [['Clinic visit', 33.5], ['Guardian, vitamins', 38.9]],
    Entertainment: [['GSC, 2 tickets', 22], ['Spotify', 17.9]],
    Other: [['Gift wrapping', 16.4], ['Laundry', 12]],
  };
  const nowTime = currentTime();
  const out = [];
  let n = 0;
  for (let day = addDays(today(), -50); day <= today(); day = addDays(day, 1)) {
    const count = [1, 2, 1, 0, 2, 1, 3][parseDate(day).getDay()];
    for (let k = 0; k < count; k++) {
      n++;
      const category = CATEGORIES[(n * 3 + k) % CATEGORIES.length];
      const [note, amount] = items[category][n % items[category].length];
      let time = pad2(8 + ((n * 5) % 13)) + ':' + pad2((n * 17) % 60);
      if (day === today() && time > nowTime) time = nowTime; // nothing in the future
      out.push({ id: 'demo' + String(n).padStart(6, '0'), date: day, time, amount, category, note, createdAt: day + 'T' + time });
    }
  }
  return out;
}

/**
 * The demo's pretend server: answers the same actions as Code.gs, from
 * memory, so every screen works exactly as it does when signed in. Like
 * the real server, it only ever holds encrypted entries and photos.
 */
async function demoApi(action, data) {
  const store = state.demoStore;
  const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
  if (action === 'list') return { expenses: store.rows.map((row) => ({ ...row })), keys: 'demo' };
  if (action === 'add') {
    const e = data.expense;
    let row = store.rows.find((r) => r.id === e.id);
    if (!row) {
      row = { id: e.id, data: e.data, hasReceipt: Boolean(e.receipt), createdAt: new Date().toISOString() };
      if (e.receipt) store.photos.set(e.id, e.receipt.data);
      store.rows.push(row);
    }
    return { expense: { ...row } };
  }
  if (action === 'update') {
    const e = data.expense;
    const row = store.rows.find((r) => r.id === e.id);
    if (!row) fail('That entry was not found.', 'NOT_FOUND');
    row.data = e.data;
    if (e.photo === 'remove') { row.hasReceipt = false; store.photos.delete(e.id); }
    else if (e.photo) { row.hasReceipt = true; store.photos.set(e.id, e.photo.data); }
    return { expense: { ...row } };
  }
  if (action === 'deleteMany') {
    const ids = new Set(data.ids);
    store.rows = store.rows.filter((r) => !ids.has(r.id));
    return { deleted: ids.size };
  }
  if (action === 'getReceipt') {
    if (!store.photos.has(data.id)) fail('No receipt for that entry.', 'NOT_FOUND');
    return { id: data.id, encrypted: true, data: store.photos.get(data.id) };
  }
  return fail('Sign in to use this. The demo keeps nothing.', 'DEMO');
}

/**
 * Sets up "Sign in with Google" and draws its button. Google draws the
 * button itself (we can't restyle it), so we pick its white pill version,
 * the closest match to the design's white Sign In button.
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
    theme: 'outline',
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
    width: Math.min(400, Math.max(200, box.clientWidth || 340)),
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
  if (state.demo) clearUserData(); // signing in ends the demo
  // A different person on this phone: forget the last one's unlocked key.
  if (state.user && state.user.email !== payload.email) clearUserData();
  // A quiet renewal (see renewSignIn) for the person already using the app:
  // just swap in the new token and leave the screen exactly as it is.
  const isRenewal = Boolean(state.user) && state.user.email === payload.email && $('signin-screen').hidden;
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
  if (!state.user || state.demo) return;
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
 * Keeps the cached entries and the unlocked key in memory (they show again
 * after sign-in) and asks the user to sign in again.
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
 * person using this phone can't see them. A key remembered on this device
 * stays (so signing back in doesn't ask for the passphrase); Forget This
 * Device removes it.
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

/** Forgets everything about the current user (or the demo) on this device, except a remembered key. */
function clearUserData() {
  if (state.user && !state.demo) {
    localStorage.removeItem(CACHE_PREFIX + state.user.email);
    localStorage.removeItem(PENDING_DELETE_PREFIX + state.user.email);
    localStorage.removeItem(TOKEN_KEY);
    if (typeof google !== 'undefined' && google.accounts) google.accounts.id.disableAutoSelect();
  }
  clearTimeout(state.refreshTimer);
  clearTimeout(state.expiryTimer);
  Object.assign(state, {
    idToken: null, user: null, demo: false, demoStore: null, expenses: [], hasLoaded: false, offline: false,
    lastSync: null, pendingDelete: null, selecting: false, form: null, screen: 'overview',
    keys: undefined, vault: null, storedRows: null, legacyRows: null, flow: null, historyFilter: 'All',
  });
  state.selected.clear();
  state.recentlyEdited.clear();
  state.receiptCache.clear();
}

// ===========================================================================
// 5. Talking to the script
// ===========================================================================

/**
 * Sends one request to the Apps Script backend and returns its JSON answer.
 * In demo mode the pretend server in memory answers instead.
 *
 * Why text/plain: a JSON content type would make the browser send a CORS
 * "preflight" request first, which Apps Script can't answer. text/plain is a
 * "simple" request, so it goes straight through. The body is still JSON.
 *
 * options.keepalive lets a request finish even if the page is closing (used
 * for deletes sent when the app goes to the background).
 * Throws an Error with .code: the server's code, or 'NETWORK'. A CONFLICT
 * error also carries .keys (the key box that already exists).
 */
async function callApi(action, data = {}, options = {}) {
  if (state.demo) return demoApi(action, data);
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
    throw Object.assign(new Error(result.error), { code: result.code, keys: result.keys });
  }
  return result;
}

// ===========================================================================
// 6. Entries, encryption and the cache
// ===========================================================================

/** True when the user has a passphrase but hasn't unlocked on this phone yet. */
function isLocked() {
  return !state.demo && Boolean(state.keys) && !state.vault;
}

/**
 * Fetches the user's entries (and key box) from the script, then redraws.
 *   - No key box yet: the user must make a passphrase first (passphrase.js).
 *   - Not unlocked: the encrypted rows wait in state.storedRows.
 *   - Unlocked: the rows are decrypted into state.expenses.
 * Entries not on the server yet (saving or failed) are kept, and entries
 * being deleted (or waiting for Undo) are left out, so a refresh never
 * undoes the user's most recent actions.
 */
async function loadExpenses() {
  try {
    const result = await callApi('list');
    const hidden = new Set([...state.deleting, ...(state.pendingDelete ? state.pendingDelete.serverIds : [])]);
    const rows = result.expenses.filter((e) => !hidden.has(e.id));
    state.offline = false;
    state.lastSync = Date.now();
    state.keys = result.keys || null;
    if (!state.keys) {
      // First sign-in since encryption arrived (or a brand-new user).
      state.legacyRows = rows.filter((r) => r.legacy);
      state.hasLoaded = true;
      startSetup();
      return;
    }
    await useRememberedKey();
    if (!state.vault) {
      state.storedRows = rows.concat(state.expenses.filter((e) => e.status).map(toStoredRow));
      state.hasLoaded = true;
      saveCache();
      renderAll();
      return;
    }
    await applyRows(rows);
  } catch (err) {
    if (err.code === 'AUTH') return;
    state.offline = true;
    if (err.code !== 'NETWORK') showToast('Could not refresh: ' + err.message, { isError: true });
  }
  state.hasLoaded = true;
  renderAll();
}

/**
 * If this device remembers the user's key, and it still fits their key box,
 * unlock with it. (It may not fit if they started fresh on another phone.)
 */
async function useRememberedKey() {
  if (state.vault || !state.keys || state.demo || !state.user) return;
  const saved = await SenVault.recall(state.user.email);
  if (!saved) return;
  if (saved.keyId === SenVault.boxKeyId(state.keys)) state.vault = { key: saved.key, keyId: saved.keyId };
  else await SenVault.forget(state.user.email);
}

/**
 * Turns rows from the server (or the cache) into state.expenses: decrypts
 * each encrypted row (reusing ones already decrypted), keeps rows from
 * before encryption as they are, and keeps entries not on the server yet.
 * A row that can't be decrypted is left out and counted.
 */
async function applyRows(rows) {
  const known = new Map(state.expenses.map((e) => [e.id, e]));
  const serverIds = new Set(rows.map((r) => r.id));
  const out = [];
  let broken = 0;
  for (const row of rows) {
    try {
      out.push(await rowToEntry(row, known.get(row.id)));
    } catch (err) {
      broken++;
      console.warn('Could not decrypt entry', row.id, err);
    }
  }
  const notOnServerYet = state.expenses.filter((e) => e.status && !serverIds.has(e.id));
  state.expenses = out.concat(notOnServerYet);
  sortExpenses();
  saveCache();
  if (broken) showToast(plural(broken, 'entry', 'entries') + " couldn't be opened and are hidden.", { isError: true });
}

/** One stored row → one entry. Rows from before encryption are already readable. */
async function rowToEntry(row, known) {
  if (row.legacy) return { ...row };
  if (known && known.data === row.data && !known.legacy) {
    return { ...known, hasReceipt: row.hasReceipt, createdAt: row.createdAt, status: row.status, error: row.error, errorCode: row.errorCode, receiptData: row.receiptData };
  }
  const fields = await SenVault.decryptEntry(state.vault.key, row.id, row.data);
  const entry = { id: row.id, ...fields, hasReceipt: Boolean(row.hasReceipt), createdAt: row.createdAt, data: row.data };
  for (const key of ['status', 'error', 'errorCode', 'receiptData']) if (row[key]) entry[key] = row[key];
  return entry;
}

/** The encrypted form of an entry, as cached (never the readable fields). */
function toStoredRow(e) {
  const row = { id: e.id, data: e.data, hasReceipt: e.hasReceipt, createdAt: e.createdAt };
  if (e.status) {
    // An entry cut off mid-save becomes "failed" for the user to retry.
    row.status = 'failed';
    row.error = e.status === 'saving' ? 'The app closed before it saved.' : e.error;
    row.errorCode = e.errorCode;
    if (e.receiptData) row.receiptData = e.receiptData;
  }
  return row;
}

/**
 * Saves this user's entries in localStorage, encrypted, with the key box, so
 * the app opens instantly and can be unlocked offline. Entries saved before
 * encryption aren't cached (they'd be readable). If storage is full we just
 * skip caching. The demo stores nothing.
 */
function saveCache() {
  if (state.demo || !state.user || !state.keys) return;
  const rows = state.storedRows || state.expenses.filter((e) => !e.legacy && e.data).map(toStoredRow);
  try {
    localStorage.setItem(CACHE_PREFIX + state.user.email, JSON.stringify({ v: 3, keys: state.keys, rows, lastSync: state.lastSync }));
  } catch (err) {
    console.warn('Could not cache entries:', err);
  }
}

/** This user's cache: {keys, rows, lastSync}. Caches from before encryption are ignored. */
function loadCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_PREFIX + state.user.email));
    if (cached && cached.v === 3 && cached.keys) return { keys: cached.keys, rows: cached.rows || [], lastSync: cached.lastSync || null };
  } catch (err) {
    // damaged: start from the server
  }
  return { keys: undefined, rows: [], lastSync: null };
}

/** Newest first: by date, then time of day, then when it was added. */
function sortExpenses() {
  state.expenses.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if ((a.time || '') !== (b.time || '')) return (a.time || '') < (b.time || '') ? 1 : -1;
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
 * Sends one not-yet-saved entry to the server: its encrypted data and, if
 * it has one, its encrypted photo. On success the local copy takes the
 * server's details (no status). On failure it is marked "failed" with the
 * reason, and History shows "Try Again".
 */
async function saveExpense(id) {
  const expense = findExpense(id);
  if (!expense) return;
  expense.status = 'saving';
  delete expense.error;
  delete expense.errorCode;
  renderAll();

  try {
    const body = { id: expense.id, data: expense.data };
    if (expense.receiptData) body.receipt = { data: expense.receiptData };
    const result = await callApi('add', { expense: body });
    const current = findExpense(id);
    if (current) {
      Object.assign(current, { data: result.expense.data, hasReceipt: result.expense.hasReceipt, createdAt: result.expense.createdAt });
      for (const key of ['status', 'error', 'errorCode', 'receiptData']) delete current[key];
    }
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
 * and needs no server. The message never times out (WCAG 2.2.1). The waiting
 * ids are also stored, so a delete is still sent if the app is closed.
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
  if (!state.user || state.demo) return;
  const key = PENDING_DELETE_PREFIX + state.user.email;
  if (ids.length) localStorage.setItem(key, JSON.stringify(ids));
  else localStorage.removeItem(key);
}

/**
 * After a restart: if the app was closed while a delete waited for Undo,
 * send it now (the user had not pressed Undo).
 */
function sendLeftoverDelete() {
  if (state.demo) return;
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

/**
 * A font size that keeps a big amount on one line: start at `base` pixels
 * and shrink for long numbers, never below 18px.
 */
function fitSize(text, base, width) {
  return Math.max(18, Math.min(base, Math.floor(width / (text.length * 0.62)))) + 'px';
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

/** The time now as "hh:mm" (24-hour), in the phone's time zone. */
function currentTime() {
  const d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** "09:41" → "9:41 am"; "20:15" → "8:15 pm". */
function formatTime(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return ((hours + 11) % 12 + 1) + ':' + pad2(minutes) + (hours < 12 ? ' am' : ' pm');
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

/** "Today, 21 Nov", "Yesterday, 20 Nov" or "Fri, 13 Nov" (for the Date pill). */
function dayWords(date) {
  const d = parseDate(date);
  const short = d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3);
  if (date === today()) return 'Today, ' + short;
  if (date === addDays(today(), -1)) return 'Yesterday, ' + short;
  return formatDay(date);
}

/**
 * When an entry happened, in words: "Sat, 21 Nov 2026, 8:15 am" (with the
 * year if asked). Older entries have no time, so only the day shows.
 */
function whenLabel(date, time, withYear) {
  const day = formatDay(date, withYear);
  return time ? day + ', ' + formatTime(time) : day;
}

/** The words for a period: "November 2026", "Sat, 21 Nov 2026" or "2026". */
function periodLabel(period) {
  if (period.type === 'day') return formatDay(period.value, true);
  if (period.type === 'year') return period.value;
  return formatMonth(period.value);
}

/** Short words for a period, for the title: "November", "Sat, 21 Nov", "2026". */
function periodShort(period) {
  if (period.type === 'day') return formatDay(period.value);
  if (period.type === 'year') return period.value;
  return formatMonthShort(period.value);
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
  setWash(kind === 'warning' || kind === 'error' ? 'amber' : 'signin');
  $('app-screen').hidden = true;
  $('vault-screen').hidden = true;
  $('signin-screen').hidden = false;
  const box = $('signin-message');
  setChildren(box);
  box.hidden = !message;
  if (message) {
    box.className = 'notice ' + (kind === 'error' ? 'notice-red' : kind === 'warning' ? 'notice-amber' : 'notice-plain');
    box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    box.append(icon(kind === 'info' ? 'info' : 'alert', 20), h('span', { class: 'text' }, message));
  }
}

/**
 * Shows the app for the signed-in user (or the demo): draws the cached
 * entries at once (decrypted with a remembered key, if there is one), then
 * refreshes from the server in the background.
 */
async function showApp() {
  $('signin-screen').hidden = true;
  $('vault-screen').hidden = true;
  $('app-screen').hidden = false;
  if (!state.demo) {
    const cached = loadCache();
    if (state.keys === undefined) state.keys = cached.keys;
    state.lastSync = state.lastSync || cached.lastSync;
    await useRememberedKey();
    if (state.vault && cached.rows.length && !state.expenses.length) await applyRows(cached.rows);
    else if (!state.vault && state.keys) state.storedRows = state.storedRows || cached.rows;
    state.hasLoaded = state.expenses.length > 0 || Boolean(state.storedRows && state.storedRows.length) || state.lastSync !== null;
    if (state.vault) sendLeftoverDelete();
  }
  showScreen(state.screen === 'form' ? 'overview' : state.screen);
  loadExpenses();
  // Entries that failed only because the sign-in had expired: retry them now.
  for (const e of state.expenses) {
    if (e.status === 'failed' && e.errorCode === 'AUTH') saveExpense(e.id);
  }
}

/**
 * Shows one screen ('overview', 'history', 'settings' or 'form'), highlights
 * its tab, and closes any message from the screen before ("stays up until
 * you leave the screen").
 */
function showScreen(name) {
  if (name !== state.screen) hideToast();
  if (name !== 'history') stopSelecting();
  if (name !== 'form' && state.screen !== 'form') state.previousScreen = name;
  if (name !== 'form') delete document.body.dataset.cat;
  state.screen = name;
  $('app-screen').hidden = false;
  $('vault-screen').hidden = true;
  for (const section of document.querySelectorAll('#app-main > .screen')) {
    section.hidden = section.id !== 'screen-' + name;
  }
  updateNav();
  renderScreen(name);
  window.scrollTo(0, 0);
}

/**
 * Shows the right bottom bar: the tabs normally, the selection bar in
 * History's edit mode, and nothing on Add or Edit, so there is no second Add
 * button to tap by mistake (the ways out are Save or Back). While locked,
 * Add is dashed: there's nowhere to save yet.
 */
function updateNav() {
  const onForm = state.screen === 'form';
  $('tabbar').hidden = onForm || state.selecting;
  $('selectbar').hidden = !state.selecting;
  $('app-main').classList.toggle('no-nav', onForm);
  $('toast').classList.toggle('no-nav', onForm);
  const add = $('add-tab');
  const locked = isLocked();
  add.disabled = locked;
  add.setAttribute('aria-label', locked ? 'Add Expense, unavailable until unlocked' : 'Add Expense');
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.screen === state.screen) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
}

/** Redraws the screen showing now (cheap at this app's size). */
function renderAll() {
  if (!$('app-screen').hidden) {
    updateNav();
    renderScreen(state.screen);
  }
}

/** Draws one screen from state. */
function renderScreen(name) {
  if (name === 'overview') renderOverview();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  if (name === 'form') setChildren($('form-demo-banner'), demoBanner());
}

/**
 * The amber notice on top of every screen in the demo, with a way to sign in.
 */
function demoBanner() {
  if (!state.demo) return null;
  return h('div', { class: 'notice notice-amber demo-banner screen-banner', role: 'status' },
    icon('alert', 20),
    h('span', { class: 'text' }, h('b', null, 'Demo mode.'), ' Sample data, cleared when you leave.'),
    h('button', { type: 'button', class: 'btn btn-primary btn-small', onclick: () => exitDemo('') }, 'Sign In'));
}

/** "No internet. Showing saved data." with Try Again. Shown on Overview and History. */
function offlineBanner() {
  if (!state.offline) return null;
  return h('div', { class: 'notice notice-amber center screen-banner', role: 'status' },
    icon('offline', 20),
    h('span', { class: 'text' }, 'No internet. Showing saved data.'),
    h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: () => loadExpenses() }, 'Try Again'));
}

/** "Last updated · 8:15 today", from state.lastSync (shown while offline). */
function lastUpdatedCard() {
  if (!state.offline) return null;
  let when = 'Not yet';
  if (state.lastSync) {
    const d = new Date(state.lastSync);
    const day = toDateText(d) === today() ? 'today' : formatDay(toDateText(d));
    when = formatTime(pad2(d.getHours()) + ':' + pad2(d.getMinutes())) + ' ' + day;
  }
  return h('div', { class: 'card last-updated' }, icon('clock', 18), h('span', { class: 'grow' }, 'Last updated'), h('b', null, when));
}

/**
 * Entries saved before encryption that are still readable on the server:
 * a notice with a way to finish encrypting them.
 */
function legacyBanner() {
  const count = state.expenses.filter((e) => e.legacy).length;
  if (!count || state.demo) return null;
  return h('div', { class: 'notice notice-amber screen-banner', role: 'status' },
    icon('lockSmall', 20),
    h('span', { class: 'text' }, h('b', null, plural(count, 'entry isn\'t', 'entries aren\'t') + ' encrypted yet.'),
      ' Finish securing them so only you can read them.'),
    h('button', { type: 'button', class: 'btn btn-primary btn-small', onclick: () => startSecuring() }, 'Secure Now'));
}

/** The screen title: a first line, and a second line that fades to peach. */
function screenTitle(id, first, second) {
  return h('h1', { class: 'title', id }, first, ' ', h('span', { class: 'sub' }, second));
}

/**
 * Draws Overview for state.period (a day, month or year): the total with
 * averages, Today and Add Expense, the "This Week" ovals, a card comparing
 * the period with the one before, spending by category, recent entries,
 * and Download Statement. Also its locked, loading, new-user, empty and
 * offline states. Everything is calculated on the phone, from entries
 * decrypted on the phone.
 */
function renderOverview() {
  const screen = $('screen-overview');
  const period = state.period;
  const all = state.expenses;
  const entries = all.filter((e) => inPeriod(e.date, period));

  if (isLocked()) {
    setWash('vault');
    setChildren(screen, h('div', { class: 'screen-head' }, screenTitle('overview-title', 'Overview', 'Locked')),
      h('div', { class: 'screen-body' }, lockPanel('overview')));
    return;
  }
  setWash(state.demo ? 'amber' : !all.length && state.hasLoaded ? 'new' : 'overview');

  const head = h('div', { class: 'screen-head' },
    screenTitle('overview-title', 'Overview', periodShort(period)),
    h('button', {
      type: 'button', class: 'btn btn-secondary btn-medium', 'aria-haspopup': 'dialog',
      'aria-label': 'Choose period. Showing ' + periodLabel(period),
      onclick: () => openPeriodSheet({ types: ['day', 'month', 'year'], value: period, onChoose: setOverviewPeriod }),
    }, icon('calendar', 20), 'Period'));

  // Loading: placeholder shapes in the same layout as the real cards, so
  // nothing jumps when the data arrives.
  if (!state.hasLoaded) {
    setChildren(screen, head, demoBanner(), h('div', { class: 'screen-body', 'aria-busy': 'true' },
      h('p', { class: 'visually-hidden', role: 'status' }, 'Loading your spending'),
      h('div', { class: 'skeleton', style: 'height:200px', 'aria-hidden': 'true' }),
      h('div', { class: 'duo', 'aria-hidden': 'true' }, h('div', { class: 'skeleton', style: 'height:140px' }), h('div', { class: 'skeleton', style: 'height:140px' })),
      h('div', { class: 'skeleton', style: 'height:230px', 'aria-hidden': 'true' })));
    return;
  }

  // New user: nothing added yet.
  if (!all.length) {
    setChildren(screen, head, demoBanner(), offlineBanner(), legacyBanner(), h('div', { class: 'screen-body' },
      h('div', { class: 'card empty-card' },
        h('div', { class: 'ghost-bars', 'aria-hidden': 'true' }, [38, 62, 30, 80, 46, 100, 54].map((p) => h('span', { style: 'height:' + p + '%' }))),
        h('h2', null, 'Your Overview', h('span', { class: 'sub' }, 'Starts Here.')),
        h('p', { class: 'help' }, 'Add your first expense to see charts.'),
        h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: openAddForm }, icon('plus', 20, 2.6), 'Add Expense'))));
    return;
  }

  // A period with no entries: no empty chart, just the words and a way back.
  if (!entries.length) {
    const name = period.type === 'day' ? formatDay(period.value) : period.type === 'year' ? period.value : formatMonthShort(period.value);
    setChildren(screen, head, demoBanner(), offlineBanner(), h('div', { class: 'screen-body' },
      h('div', { class: 'card empty-card' },
        h('h2', null, 'No Spending', h('span', { class: 'sub' }, (period.type === 'day' ? 'on ' : 'in ') + name + '.')),
        h('p', { class: 'help' }, 'Nothing was added ' + (period.type === 'day' ? 'on ' : 'for ') + name + '.'),
        periodHasToday(period) ? null : h('button', {
          type: 'button', class: 'btn btn-secondary btn-block',
          onclick: () => setOverviewPeriod(currentPeriod(period.type)),
        }, 'Go to This ' + (period.type === 'day' ? 'Day' : period.type === 'year' ? 'Year' : 'Month')))));
    return;
  }

  setChildren(screen, head, demoBanner(), offlineBanner(), legacyBanner(), h('div', { class: 'screen-body' },
    overviewHero(entries), overviewDuo(), overviewWeek(), overviewPeriodCard(entries), overviewCategories(entries),
    overviewRecent(entries),
    h('button', { type: 'button', class: 'btn btn-secondary btn-block statement-button', onclick: () => openStatementSheet(statementMonthFor(period)) },
      icon('download', 18), 'Download Statement'),
    lastUpdatedCard()));
  restoreFocus(screen);
}

/** Sets Overview's period (from the Choose Period pop-up) and redraws. */
function setOverviewPeriod(period) {
  state.period = period;
  state.weekDay = null;
  renderOverview();
}

/** The average per day with spending (one RM 52 entry shows RM 52.00, not RM 52 ÷ 30). */
function dailyAverage(entries) {
  const days = new Set(entries.map((e) => e.date)).size;
  return days ? sumAmounts(entries) / days : 0;
}

/**
 * The big card: the period's total in dotted numerals, a ruler showing how
 * far through the month you are, and the average and number of entries.
 */
function overviewHero(entries) {
  const period = state.period;
  const total = sumAmounts(entries);
  const isNow = periodHasToday(period);
  const label = period.type === 'day' ? (isNow ? 'Spent Today' : 'Spent on ' + formatDay(period.value)) :
    period.type === 'year' ? (isNow ? 'Spent This Year' : 'Spent in ' + period.value) :
    isNow ? 'Spent This Month' : 'Spent in ' + MONTHS[Number(period.value.slice(5)) - 1];

  const pills = [];
  if (period.type === 'month') {
    pills.push(['Daily Average', rm(dailyAverage(entries))]);
  } else if (period.type === 'year') {
    const months = new Set(entries.map((e) => e.date.slice(0, 7))).size;
    pills.push(['Monthly Average', rm(total / months)]);
  } else {
    pills.push(['Largest', rm(Math.max(...entries.map((e) => e.amount)))]);
  }

  let ruler = null;
  if (period.type === 'month' && isNow) {
    const days = daysInMonth(period.value);
    const day = parseDate(today()).getDate();
    ruler = h('div', null,
      h('div', { class: 'ruler', 'aria-hidden': 'true' }, Array.from({ length: days }, (_, i) => {
        const d = i + 1;
        return h('span', { class: (d === day ? 'now' : d > day ? 'later' : '') + (d % 7 === 1 && d !== day ? ' week' : '') });
      })),
      h('p', { class: 'ruler-words' }, h('b', null, 'Day ' + day + ' of ' + days),
        h('span', null, days - day === 0 ? 'Last day' : plural(days - day, 'day', 'days') + ' left')));
  }

  const number = amountNumber(total);
  return h('section', { class: 'hero', 'aria-label': label },
    h('div', null,
      h('p', { class: 'hero-label' }, label),
      h('p', { class: 'hero-amount' }, h('span', { class: 'cur' }, 'RM'),
        h('span', { class: 'num dots', style: 'font-size:' + fitSize(number, 44, 276) }, number))),
    ruler,
    h('div', { class: 'hero-pills' },
      pills.map(([k, v]) => h('span', { class: 'hero-pill' }, k, ' ', h('b', null, v))),
      h('span', { class: 'hero-pill' }, h('b', null, entries.length), entries.length === 1 ? ' entry' : ' entries')));
}

/** "Today" with its total, beside the big Add Expense tile. Only when the period includes today. */
function overviewDuo() {
  const period = state.period;
  if (period.type === 'day' || !periodHasToday(period)) return null;
  const todays = state.expenses.filter((e) => e.date === today());
  const number = amountNumber(sumAmounts(todays));
  return h('div', { class: 'duo' },
    h('div', { class: 'today-tile' },
      h('span', { class: 'k' }, 'Today'),
      h('span', { class: 'amt' }, h('span', { class: 'cur' }, 'RM'), h('span', { class: 'num dots', style: 'font-size:' + fitSize(number, 30, 96) }, number)),
      h('span', { class: 'n' }, plural(todays.length, 'entry', 'entries'))),
    h('button', { type: 'button', class: 'add-tile', onclick: openAddForm },
      h('span', { class: 'plus' }, icon('plus', 24, 2.6)),
      h('span', { class: 'words' }, 'Add', h('br'), 'Expense')));
}

/** {'2026-11-21': 46.3, ...}: the total for each day that has entries. */
function totalsByDay(entries) {
  const sen = {};
  for (const e of entries) sen[e.date] = (sen[e.date] || 0) + Math.round(e.amount * 100);
  for (const day of Object.keys(sen)) sen[day] /= 100;
  return sen;
}

/**
 * "This Week": seven days, Monday to Sunday. Each day's spending is a
 * glowing oval as tall as the amount; a dashed line marks the daily
 * average. Tap a day to see its total underneath. Days still to come are
 * dashed outlines. Shown for a month (the week of today, or the month's
 * last week) or a day.
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
  const average = dailyAverage(state.expenses.filter((e) => e.date.startsWith(chosen.slice(0, 7))));
  const max = Math.max(average, ...days.map((d) => byDay[d] || 0));
  const px = (amount) => (max > 0 ? Math.round((amount / max) * 100) : 0);

  const cells = days.map((day) => {
    const d = parseDate(day);
    const wd = WEEKDAYS[d.getDay()].slice(0, 3);
    if (day > today()) {
      return h('div', { class: 'day future', 'aria-hidden': 'true' }, h('span', { class: 'track' }), h('span', { class: 'wd' }, wd), h('span', { class: 'n' }, d.getDate()));
    }
    const total = byDay[day] || 0;
    return h('button', {
      type: 'button', class: 'day', 'aria-pressed': String(day === chosen), 'data-key': 'day-' + day,
      'aria-label': WEEKDAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' + rm(total),
      onclick: () => { state.weekDay = day; keepFocus('day-' + day); renderOverview(); },
    },
    h('span', { class: 'track' },
      average > 0 ? h('span', { class: 'avg', 'aria-hidden': 'true', style: 'bottom:' + px(average) + 'px' }) : null,
      total > 0 ? h('span', { class: 'oval', style: 'height:' + Math.max(20, px(total)) + 'px' }) : null),
    h('span', { class: 'wd' }, wd),
    h('span', { class: 'n' }, d.getDate()));
  });

  const first = parseDate(days[0]);
  const last = parseDate(days[6]);
  const range = first.getMonth() === last.getMonth()
    ? first.getDate() + ' to ' + last.getDate() + ' ' + MONTHS[last.getMonth()].slice(0, 3)
    : first.getDate() + ' ' + MONTHS[first.getMonth()].slice(0, 3) + ' to ' + last.getDate() + ' ' + MONTHS[last.getMonth()].slice(0, 3);

  return h('section', { class: 'card week-card', 'aria-labelledby': 'week-title' },
    h('div', { class: 'card-head' }, h('h2', { class: 'section-title', id: 'week-title' }, 'This Week'), h('span', { class: 'caption' }, range)),
    h('div', { class: 'week-days' }, cells),
    h('div', { class: 'inset week-foot', role: 'status' },
      h('span', { style: 'min-width:0' },
        h('span', { class: 'day-name' }, formatDayLong(chosen)),
        average > 0 ? h('span', { class: 'avg-line' }, h('i', { 'aria-hidden': 'true' }), 'Daily Average ' + rm(average)) : null),
      h('span', { class: 'amount' }, rm(byDay[chosen] || 0))));
}

/**
 * "This Month" (or This Year / the day): two bars comparing the period with
 * the one before, a sentence saying how far along it is, a coloured label
 * (green less, grey same, red more), and the biggest day.
 */
function overviewPeriodCard(entries) {
  const period = state.period;
  const isNow = periodHasToday(period);
  const total = sumAmounts(entries);
  const before = previousPeriod(period);
  const beforeTotal = sumAmounts(state.expenses.filter((e) => inPeriod(e.date, before)));

  let title; let range = ''; let nowName; let beforeName; let left = 0;
  if (period.type === 'month') {
    const m = Number(period.value.slice(5)) - 1;
    title = isNow ? 'This Month' : MONTHS[m];
    range = '1 to ' + (isNow ? parseDate(today()).getDate() : daysInMonth(period.value)) + ' ' + MONTHS[m].slice(0, 3);
    nowName = MONTHS[m];
    beforeName = MONTHS[Number(before.value.slice(5)) - 1];
    if (isNow) left = daysInMonth(period.value) - parseDate(today()).getDate();
  } else if (period.type === 'year') {
    title = isNow ? 'This Year' : period.value;
    range = 'Jan to ' + (isNow ? MONTHS[new Date().getMonth()].slice(0, 3) : 'Dec');
    nowName = period.value;
    beforeName = before.value;
  } else {
    title = isNow ? 'Today' : formatDayLong(period.value);
    nowName = isNow ? 'Today' : formatDay(period.value);
    beforeName = before.value === addDays(today(), -1) ? 'Yesterday' : formatDay(before.value);
  }

  const widest = Math.max(total, beforeTotal);
  const bar = (amount, cls) => h('span', { class: 'bar-track' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' },
    h('span', { style: 'width:' + (widest ? Math.max(2, Math.round((amount / widest) * 100)) : 0) + '%' }));

  const rows = [h('div', { class: 'compare-row' },
    h('span', { class: 'top' }, h('span', { class: 'k' }, nowName + (isNow && period.type !== 'day' ? ' So Far' : '')), h('span', { class: 'v' }, rm(total))),
    bar(total))];
  let words = null;
  let pill = null;
  if (beforeTotal > 0) {
    rows.push(h('div', { class: 'compare-row' },
      h('span', { class: 'top' }, h('span', { class: 'k' }, beforeName), h('span', { class: 'v' }, rm(beforeTotal))),
      bar(beforeTotal, 'before')));
    const pct = Math.round((total / beforeTotal) * 100);
    words = h('p', { class: 'compare-words' }, nowName + (isNow ? ' is at ' : ' was '), h('b', null, pct + '%'),
      ' of ' + beforeName + "'s total" + (left ? ', with ' + plural(left, 'day', 'days') + ' left.' : '.'));
    const diff = Math.round((total - beforeTotal) * 100) / 100;
    const kind = diff < 0 ? 'less' : diff > 0 ? 'more' : 'same';
    pill = h('span', { class: 'change-pill is-' + kind },
      icon(kind === 'less' ? 'arrowDown' : kind === 'more' ? 'arrowUp' : 'equals', 16, 2.4),
      h('span', null, kind === 'same' ? 'The same as ' + beforeName : rm(Math.abs(diff)) + ' ' + kind + ' than ' + beforeName));
  }

  let biggest = null;
  if (period.type !== 'day') {
    const byDay = totalsByDay(entries);
    const days = Object.keys(byDay);
    if (days.length > 1) {
      const top = days.reduce((a, b) => (byDay[b] > byDay[a] ? b : a));
      biggest = h('span', { class: 'fact' }, 'Biggest day ', h('b', null, rm(byDay[top])), ' on ' + formatDay(top).replace(',', ''));
    }
  }

  return h('section', { class: 'card', style: 'padding:18px 10px 6px;display:flex;flex-direction:column;gap:6px', 'aria-labelledby': 'period-card-title' },
    h('div', { class: 'card-head' }, h('h2', { class: 'section-title', id: 'period-card-title' }, title), range ? h('span', { class: 'caption' }, range) : null),
    h('div', { class: 'compare' }, rows, words),
    pill || biggest ? h('div', { class: 'inset facts' }, pill, biggest) : null);
}

/**
 * "Where It Went": every category with spending as a glowing tile, biggest
 * first (the largest one tall, with its share in dotted numerals). Each
 * shows its name, share and amount, so nothing depends on colour alone.
 */
function overviewCategories(entries) {
  const total = sumAmounts(entries);
  const rows = CATEGORIES
    .map((name) => {
      const own = entries.filter((e) => e.category === name);
      return { name, amount: sumAmounts(own), count: own.length };
    })
    .filter((row) => row.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const pct = (amount) => Math.round((amount / total) * 100) + '%';

  const tile = (row, first) => h('div', { class: 'cat-tile' + (first ? ' is-first' : ''), 'data-cat': row.name },
    h('span', { class: 'top' },
      h('span', { class: 'ic plate' }, icon(row.name, 18)),
      first ? null : h('span', { class: 'pct-badge plate' }, pct(row.amount))),
    first
      ? h('span', { class: 'info plate' }, h('span', { class: 'name' }, row.name), h('span', { class: 'big dots' }, pct(row.amount)),
        h('span', { class: 'amt' }, rm(row.amount)), h('span', { class: 'n' }, plural(row.count, 'entry', 'entries')))
      : h('span', { class: 'info plate' }, h('span', { class: 'name' }, row.name),
        h('span', { class: 'amt' }, rm(row.amount) + ' · ' + plural(row.count, 'entry', 'entries'))));

  let top;
  if (rows.length >= 3) top = h('div', { class: 'cat-top' }, tile(rows[0], true), tile(rows[1]), tile(rows[2]));
  else if (rows.length === 2) top = h('div', { class: 'cat-top two' }, tile(rows[0]), tile(rows[1]));
  else top = h('div', { class: 'cat-rest' }, h('div', { style: 'grid-column:span 2;display:grid' }, tile(rows[0])));

  return h('section', { 'aria-labelledby': 'cat-title', style: 'display:flex;flex-direction:column;gap:10px' },
    h('h2', { class: 'block-title', id: 'cat-title' }, 'Where It Went', h('span', { class: 'sub' }, 'By Category')),
    top,
    rows.length > 3 ? h('div', { class: 'cat-rest' }, rows.slice(3).map((row) => tile(row))) : null);
}

/** "Recent": the latest five entries in the period, with See All. */
function overviewRecent(entries) {
  const month = statementMonthFor(state.period);
  return h('section', { class: 'card recent', 'aria-labelledby': 'recent-title' },
    h('div', { class: 'card-head' },
      h('h2', { class: 'section-title', id: 'recent-title' }, 'Recent'),
      h('button', { type: 'button', class: 'link-button pink', onclick: () => { state.historyMonth = month; state.historyFilter = 'All'; showScreen('history'); } }, 'See All')),
    h('ul', { class: 'rows' },
      entries.slice(0, 5).map((e) => h('li', { class: 'row' },
        categoryTile(e.category, true),
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, e.category),
          h('span', { class: 'row-note' }, e.note || formatDay(e.date))),
        h('span', { class: 'row-amount' }, rm(e.amount))))));
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
 * Opens "Choose Period". options.types lists the tabs to offer ('day',
 * 'month', 'year'); options.value is the current period; options.onChoose
 * gets the chosen period. Future dates are dashed or struck through and
 * can't be chosen, and the confirm button names exactly what will show.
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

/** Draws the Choose Period pop-up for the picker's current tab. */
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
        type: 'button', class: 'pick' + (spentDays.has(value) ? ' has-spend' : '') + (value === today() ? ' is-today' : ''),
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
    sheetHead('Choose Period'),
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
    h('button', { type: 'button', class: 'btn btn-secondary btn-icon', 'aria-label': 'Previous ' + unit, disabled: !canGoBack, 'data-key': 'prev', onclick: () => { keepFocus('prev'); move(-1); } }, icon('back', 20)),
    h('span', { class: 'label', 'aria-live': 'polite' }, label),
    h('button', { type: 'button', class: 'btn btn-secondary btn-icon', 'aria-label': 'Next ' + unit, disabled: !canGoForward, 'data-key': 'next', onclick: () => { keepFocus('next'); move(1); } }, icon('next', 20)));
}

// ===========================================================================
// 10. Add and Edit expense
// ===========================================================================
//
// The form asks in the order people remember a purchase: how much, when,
// what it was (note and receipt), then the category. Amount and category are
// required (red asterisk). The tab bar is hidden while it's open, and the
// screen's wash and the amount tile take on the category's colour.

/** Wires up the form's fixed parts once: chips, date, note, photo, buttons. */
function setUpForm() {
  const chips = $('category-chips');
  for (const name of CATEGORIES) {
    chips.append(h('button', {
      type: 'button', class: 'chip', role: 'radio', 'aria-checked': 'false', 'data-cat': name, 'data-value': name,
      tabindex: '-1', onclick: () => selectCategory(name, true),
    }, h('span', { class: 'chip-icon' }, icon(name, 18)), name));
  }
  // Arrow keys move between chips, as in any radio group.
  chips.addEventListener('keydown', (event) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const current = CATEGORIES.indexOf(formCategory());
    selectCategory(CATEGORIES[(current + keys[event.key] + CATEGORIES.length) % CATEGORIES.length], true);
  });

  $('amount').addEventListener('input', () => setAmountError(false));
  for (const id of ['date-input', 'time-input', 'datetime-input']) {
    const input = $(id);
    input.addEventListener('change', () => { if (state.form) state.form.whenChanged = true; updateWhenLabels(); });
    // Desktop browsers only open the picker from its small icon; open it on any click.
    input.addEventListener('click', () => { try { input.showPicker(); } catch (err) { /* the phone opens its own */ } });
  }
  $('category-row').addEventListener('click', () => setCategoryChipsOpen($('category-chips').hidden));
  $('photo-add').addEventListener('click', () => $('photo-input').click());
  $('photo-replace').addEventListener('click', () => $('photo-input').click());
  $('photo-remove').addEventListener('click', removeFormPhoto);
  $('photo-view').addEventListener('click', viewFormPhoto);
  $('photo-input').addEventListener('change', handlePhotoChosen);
  $('form-back').addEventListener('click', formBack);
  $('expense-form').addEventListener('submit', (event) => {
    event.preventDefault(); // stop the browser reloading the page
    if (state.form.mode === 'edit') saveEdit();
    else saveNewExpense();
  });
}

/** Opens Add Expense, empty, dated now, with the last category used. */
function openAddForm() {
  if (isLocked()) return;
  state.form = { mode: 'add', photo: null, saving: false, failed: false, whenChanged: false };
  let last = 'Food';
  try { last = localStorage.getItem(LAST_CATEGORY_KEY) || 'Food'; } catch (err) { /* ignore */ }
  fillForm({ amount: '', category: CATEGORIES.includes(last) ? last : 'Food', date: today(), time: currentTime(), note: '' });
  $('form-title-1').textContent = 'Add';
  $('category-row').hidden = true;
  $('category-label').hidden = false;
  $('when-pills').classList.remove('one');
  $('date-pill').hidden = false;
  $('time-pill').hidden = false;
  $('datetime-pill').hidden = true;
  setCategoryChipsOpen(true);
  showPhoto(null);
  showScreen('form');
  setWash('form');
  $('amount').focus();
}

/**
 * Opens Edit Expense for a saved entry (tap it in History). Delete stays in
 * History, away from Save. The category is one row with Change, and the
 * date and time are one pill, since they're already set.
 */
function openEditForm(id) {
  const expense = findExpense(id);
  if (!expense || expense.status) return;
  state.form = { mode: 'edit', id, original: { ...expense }, photo: { state: 'keep' }, saving: false, failed: false, whenChanged: false };
  fillForm({ amount: amountNumber(expense.amount).replace(/,/g, ''), category: expense.category, date: expense.date, time: expense.time || '', note: expense.note });
  $('form-title-1').textContent = 'Edit';
  $('category-row').hidden = false;
  $('category-label').hidden = true;
  $('when-pills').classList.add('one');
  $('date-pill').hidden = true;
  $('time-pill').hidden = true;
  $('datetime-pill').hidden = false;
  setCategoryChipsOpen(false);
  showPhoto(null);
  if (expense.hasReceipt) {
    showPhoto('');
    getReceiptSrc(id).then((src) => {
      if (state.form && state.form.id === id && state.form.photo.state === 'keep') showPhoto(src);
    }).catch(() => { /* the thumbnail stays a placeholder */ });
  }
  showScreen('form');
  setWash('form');
}

/** Puts values into the form and resets messages. */
function fillForm(values) {
  state.form.time = values.time;
  $('amount').value = values.amount;
  $('note').value = values.note || '';
  $('date-input').value = values.date;
  $('time-input').value = values.time || '12:00';
  $('datetime-input').value = values.date + 'T' + (values.time || '12:00');
  for (const id of ['date-input', 'datetime-input']) $(id).max = id === 'date-input' ? today() : today() + 'T23:59';
  selectCategory(values.category, false);
  setAmountError(false);
  $('form-banner').hidden = true;
  $('photo-input').value = '';
  $('save-button').disabled = false;
  updateWhenLabels();
  updateSaveLabel();
}

/**
 * Marks one chip as chosen (aria-checked, with a tick) and makes it the one
 * Tab reaches. The amount tile's badge, its glow and the screen's wash all
 * take on the category's colour.
 */
function selectCategory(name, focus) {
  for (const chip of $('category-chips').children) {
    const on = chip.dataset.value === name;
    chip.setAttribute('aria-checked', String(on));
    chip.tabIndex = on ? 0 : -1;
    setChildren(chip.querySelector('.chip-icon'), icon(on ? 'check' : chip.dataset.value, 18, on ? 2.6 : 2));
    if (on && focus) chip.focus();
  }
  $('category-value').textContent = name;
  const tile = $('category-row-tile');
  tile.dataset.cat = name;
  setChildren(tile, icon(name, 18));
  $('amount-cat').textContent = name;
  document.body.dataset.cat = name;
}

/** Edit only: shows or hides the chips under the category row. */
function setCategoryChipsOpen(open) {
  $('category-chips').hidden = !open;
  $('category-row').setAttribute('aria-expanded', String(open));
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

/**
 * The date and time chosen. When editing an older entry that has no time,
 * it stays without one unless the user changes it.
 */
function readWhen() {
  const edit = state.form && state.form.mode === 'edit';
  let date;
  let time;
  if (edit) [date, time] = ($('datetime-input').value || today() + 'T' + currentTime()).split('T');
  else { date = $('date-input').value || today(); time = $('time-input').value || currentTime(); }
  const keepNoTime = edit && !state.form.whenChanged && !state.form.time;
  return { date, time: keepNoTime ? '' : (time || '').slice(0, 5) };
}

/** "Today, 21 Nov" and "9:41 am" on the pills (or one "Sat, 21 Nov 2026, 8:15 am" when editing). */
function updateWhenLabels() {
  const { date, time } = readWhen();
  $('date-label').textContent = dayWords(date);
  $('time-label').textContent = time ? formatTime(time) : 'No time';
  $('datetime-label').textContent = whenLabel(date, time, true);
}

/** The Save button says what happens: Save Expense, Save Changes or Try Again. */
function updateSaveLabel() {
  const form = state.form;
  if (!form) return;
  if (form.saving) setChildren($('save-button'), 'Saving…');
  else if (form.mode === 'add') setChildren($('save-button'), 'Save Expense');
  else if (form.failed) setChildren($('save-button'), 'Try Again');
  else setChildren($('save-button'), 'Save Changes');
}

/** Shows or hides "Type an amount first." in red inside the amount tile, and turns the wash red. */
function setAmountError(on, message) {
  $('amount-card').classList.toggle('is-invalid', on);
  $('amount').setAttribute('aria-invalid', String(on));
  $('amount-error').hidden = !on;
  if (message) $('amount-error-text').textContent = message;
  if (state.screen === 'form') setWash(on ? 'form-error' : 'form');
}

/**
 * Checks the form. Returns the values, or null after showing what's wrong.
 * The server can't check them any more (it can't read them), so this is
 * the only check.
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
  if (!CATEGORIES.includes(category)) {
    showFormBanner('Choose a category.');
    return null;
  }
  const { date, time } = readWhen();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today() || (date === today() && time > currentTime()) || date < '2000-01-01') {
    showFormBanner('Choose a date and time that have already passed.');
    return null;
  }
  const note = $('note').value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, MAX_NOTE_LENGTH);
  return { amount, category, date, time, note };
}

/** Shows a red message above the Save button. */
function showFormBanner(message) {
  const banner = $('form-banner');
  setChildren(banner, icon('alert', 20), h('span', { class: 'text' }, message));
  banner.hidden = false;
  banner.scrollIntoView({ block: 'center' });
}

/** True if anything was typed or chosen on Add Expense. */
function addFormHasInput() {
  return Boolean($('amount').value.trim() || $('note').value.trim() || (state.form && state.form.photo));
}

/**
 * Back. On Add with something entered, asks first ("Leave Without Saving?");
 * on Edit with changes, asks to discard them; otherwise just goes back.
 */
function formBack() {
  if (state.form.mode === 'edit') return cancelEdit();
  if (!addFormHasInput()) return leaveForm();
  const amount = readAmount();
  const category = formCategory();
  fillSheet(
    sheetHead('Leave Without Saving?', { noClose: true }),
    h('p', { class: 'lede sheet-message' }, "This expense hasn't been saved yet."),
    h('div', { class: 'pair' },
      h('div', { class: 'pair-box' }, h('span', { class: 'k' }, 'Amount'), h('span', { class: 'v' }, amount ? rm(amount) : '—')),
      h('div', { class: 'pair-box' }, h('span', { class: 'k' }, 'Category'), h('span', { class: 'cat-badge', 'data-cat': category }, category))),
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: closeSheet }, 'Keep Editing'),
      h('button', { type: 'button', class: 'btn btn-quiet-danger btn-block', onclick: () => { closeSheet(); leaveForm(); } }, 'Discard Entry')));
  openSheet();
}

/** Leaves the form for the screen it was opened from. */
function leaveForm() {
  state.form = null;
  showScreen(state.previousScreen || 'overview');
}

/**
 * Add Expense → Save Expense: the entry is encrypted here, shows at once
 * and saves in the background (see saveExpense), and the app goes back
 * where it came from. The id is made here, so a retry can't make a
 * duplicate.
 */
async function saveNewExpense() {
  const form = state.form;
  if (form.preparingPhoto) return showFormBanner('Wait a moment, the photo is still being prepared.');
  if (form.saving) return;
  const values = readForm();
  if (!values) return;
  form.saving = true;
  const expense = { ...values, id: makeId(), hasReceipt: Boolean(form.photo), createdAt: new Date().toISOString(), status: 'saving' };
  try {
    expense.data = await SenVault.encryptEntry(state.vault.key, expense);
    if (form.photo) {
      expense.receiptData = await SenVault.encryptPhoto(state.vault.key, expense.id, form.photo.data);
      state.receiptCache.set(expense.id, 'data:image/jpeg;base64,' + form.photo.data);
    }
  } catch (err) {
    form.saving = false;
    return showFormBanner("Couldn't encrypt this entry: " + err.message);
  }
  if (!state.demo) {
    try { localStorage.setItem(LAST_CATEGORY_KEY, values.category); } catch (err) { /* ignore */ }
  }

  state.expenses.push(expense);
  sortExpenses();
  saveCache();
  leaveForm();
  saveExpense(expense.id);
  showToast('Saved ' + rm(expense.amount) + ' · ' + expense.category);
}

/** What changed on the edit form, as [field, before, now] rows. */
function editChanges() {
  const original = state.form.original;
  const amount = readAmount();
  const { date, time } = readWhen();
  const note = $('note').value.trim();
  const changes = [];
  if (amount !== original.amount) changes.push(['Amount', rm(original.amount), amount ? rm(amount) : '—']);
  if (formCategory() !== original.category) changes.push(['Category', original.category, formCategory()]);
  if (date !== original.date || time !== (original.time || '')) {
    changes.push(['Date', whenLabel(original.date, original.time, true), whenLabel(date, time, true)]);
  }
  if (note !== (original.note || '')) changes.push(['Note', original.note || '—', note || '—']);
  if (state.form.photo.state !== 'keep') changes.push(['Photo', original.hasReceipt ? 'Photo' : 'None', state.form.photo.state === 'remove' ? 'Removed' : 'New photo']);
  return changes;
}

/**
 * Edit → Back. With unsaved changes, asks first and shows exactly what
 * changed, before and now; "Keep Editing" is the pastel button, "Discard"
 * a red glass pill.
 */
function cancelEdit() {
  const changes = editChanges();
  if (!changes.length) return leaveForm();
  fillSheet(
    sheetHead('Discard Changes?', { noClose: true }),
    h('p', { class: 'lede sheet-message' }, 'Here is what you changed.'),
    changes.map(([field, before, now]) => h('div', { class: 'pair' },
      h('div', { class: 'pair-box' }, h('span', { class: 'k' }, changes.length > 1 ? field + ' Before' : 'Before'), h('span', { class: 'v was' }, before)),
      h('span', { class: 'arrow', 'aria-hidden': 'true' }, icon('next', 18)),
      h('div', { class: 'pair-box' }, h('span', { class: 'k' }, 'Now'), h('span', { class: 'v' }, now)))),
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: closeSheet }, 'Keep Editing'),
      h('button', { type: 'button', class: 'btn btn-quiet-danger btn-block', onclick: () => { closeSheet(); leaveForm(); } }, 'Discard')));
  openSheet();
}

/**
 * Edit → Save Changes. Unlike adding, this waits for the server, so if it
 * fails the user stays on the form with their changes kept, and the button
 * becomes Try Again. Afterwards, "Changes saved · Undo" (Undo is offered when
 * the photo didn't change, since a replaced photo is already in the trash).
 */
async function saveEdit() {
  const form = state.form;
  if (form.saving) return;
  if (form.preparingPhoto) return showFormBanner('Wait a moment, the photo is still being prepared.');
  const values = readForm();
  if (!values) return;
  if (!editChanges().length) return leaveForm();

  form.saving = true;
  $('save-button').disabled = true;
  $('form-banner').hidden = true;
  updateSaveLabel();
  try {
    const data = await SenVault.encryptEntry(state.vault.key, { id: form.id, ...values });
    let photo;
    if (form.photo.state === 'new') photo = { data: await SenVault.encryptPhoto(state.vault.key, form.id, form.photo.data.data) };
    if (form.photo.state === 'remove') photo = 'remove';
    // An entry from before encryption: its photo is still a readable JPEG on
    // the server, so send it encrypted too (the readable one goes to the trash).
    if (form.original.legacy && form.original.hasReceipt && form.photo.state === 'keep') {
      const src = await getReceiptSrc(form.id);
      photo = { data: await SenVault.encryptPhoto(state.vault.key, form.id, src.split(',')[1]) };
    }
    const result = await callApi('update', { expense: { id: form.id, data, photo } });
    const current = findExpense(form.id);
    if (current) {
      Object.assign(current, values, { data: result.expense.data, hasReceipt: result.expense.hasReceipt });
      delete current.legacy;
    }
    if (form.photo.state === 'new') state.receiptCache.set(form.id, 'data:image/jpeg;base64,' + form.photo.data.data);
    if (form.photo.state === 'remove') state.receiptCache.delete(form.id);
    state.recentlyEdited.add(form.id);
    sortExpenses();
    saveCache();
    const original = form.original;
    state.historyMonth = values.date.slice(0, 7);
    state.form = null;
    showScreen('history');
    showToast('Changes saved', form.photo.state === 'keep' ? { undo: () => undoEdit(original) } : {});
  } catch (err) {
    form.saving = false;
    form.failed = true;
    $('save-button').disabled = false;
    updateSaveLabel();
    if (err.code === 'AUTH') return; // the sign-in screen is showing; the form is kept
    showFormBanner(err.code === 'NETWORK' ? "Couldn't save. Your changes are kept here." : "Couldn't save: " + err.message);
  }
}

/** Undo for an edit: encrypts the original values again and sends them back. */
async function undoEdit(original) {
  hideToast();
  try {
    const data = await SenVault.encryptEntry(state.vault.key, original);
    const result = await callApi('update', { expense: { id: original.id, data } });
    const current = findExpense(original.id);
    if (current) Object.assign(current, { date: original.date, time: original.time || '', amount: original.amount, category: original.category, note: original.note, data: result.expense.data });
    state.recentlyEdited.delete(original.id);
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
 * Draws History for state.historyMonth as a timeline: each day hangs off a
 * glowing rail, with its total, and its entries in a card. Category
 * capsules filter the list. Tap an entry to edit it; "Edit" in the header
 * switches to edit mode, where entries are chosen to delete.
 */
function renderHistory() {
  const screen = $('screen-history');
  const month = state.historyMonth;
  const filter = state.historyFilter;
  const monthEntries = state.expenses.filter((e) => e.date.startsWith(month + '-'));
  const entries = monthEntries.filter((e) => filter === 'All' || e.category === filter);
  const parts = [];
  screen.classList.toggle('selecting', state.selecting);

  if (isLocked()) {
    setWash('vault');
    setChildren(screen, h('div', { class: 'screen-head' }, screenTitle('history-title', 'History', 'Locked')),
      h('div', { class: 'screen-body' }, lockPanel('history')));
    return;
  }

  if (state.selecting) {
    setWash('delete');
    const choosable = entries.filter((e) => !e.status);
    const allChosen = choosable.length > 0 && choosable.every((e) => state.selected.has(e.id));
    parts.push(h('div', { class: 'select-top' },
      h('button', { type: 'button', class: 'btn btn-secondary btn-medium', onclick: stopSelecting }, 'Done'),
      h('button', { type: 'button', class: 'btn btn-secondary btn-medium', onclick: () => toggleSelectAll(choosable, allChosen) },
        allChosen ? 'Select None' : 'Select All')),
    h('div', { class: 'select-title' },
      h('h1', { class: 'title', id: 'history-title', role: 'status' }, state.selected.size + ' Selected'),
      h('p', { class: 'hint' }, 'Tap to Choose')));
  } else {
    setWash(state.demo ? 'amber' : 'history');
    parts.push(h('div', { class: 'screen-head' },
      h('h1', { class: 'title', id: 'history-title' }, 'History ',
        h('span', { class: 'sub' }, h('button', {
          type: 'button', class: 'month-button', 'aria-label': 'Choose month. Showing ' + formatMonth(month),
          onclick: () => openPeriodSheet({ types: ['month'], value: { type: 'month', value: month }, onChoose: (p) => { state.historyMonth = p.value; renderHistory(); } }),
        }, formatMonthShort(month), icon('down', 22, 2.4)))),
      monthEntries.some((e) => !e.status) ? h('button', { type: 'button', class: 'btn btn-secondary btn-medium', onclick: startSelecting },
        icon('edit', 18), 'Edit') : null));
    parts.push(demoBanner(), offlineBanner());
    if (monthEntries.length) {
      const used = new Set(monthEntries.map((e) => e.category));
      parts.push(h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter by category' },
        ['All', ...CATEGORIES.filter((c) => used.has(c))].map((name) => h('button', {
          type: 'button', class: 'filter' + (name === 'All' ? ' all' : ''), 'data-cat': name === 'All' ? null : name,
          'aria-pressed': String(filter === name), 'data-key': 'filter-' + name,
          onclick: () => { state.historyFilter = name; keepFocus('filter-' + name); renderHistory(); },
        }, name === 'All' ? null : h('span', { class: 'dot', 'aria-hidden': 'true' }), name,
        name === 'All' && filter === 'All' ? icon('check', 16, 2.6) : null))));
    }
  }

  if (!state.hasLoaded) {
    parts.push(h('div', { class: 'screen-body', 'aria-busy': 'true' },
      h('p', { class: 'visually-hidden', role: 'status' }, 'Loading your entries'),
      h('div', { class: 'skeleton', style: 'height:200px', 'aria-hidden': 'true' }),
      h('div', { class: 'skeleton', style: 'height:140px', 'aria-hidden': 'true' })));
  } else if (!monthEntries.length) {
    const isNow = month === currentMonth();
    parts.push(h('div', { class: 'screen-body' }, h('div', { class: 'card empty-card' },
      h('div', { class: 'ghost-rows', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
      h('h2', null, 'No Entries', h('span', { class: 'sub' }, isNow ? 'Yet This Month.' : 'in ' + formatMonthShort(month) + '.')),
      h('p', { class: 'help' }, isNow ? 'Add your first expense for ' + MONTHS[Number(month.slice(5)) - 1] + '.' : 'Nothing was added for ' + formatMonthShort(month) + '.'),
      isNow ? h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: openAddForm }, icon('plus', 20, 2.6), 'Add Expense')
        : h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: () => { state.historyMonth = currentMonth(); renderHistory(); } }, 'Go to This Month'))));
  } else if (!entries.length) {
    parts.push(h('div', { class: 'screen-body' }, h('div', { class: 'card empty-card' },
      h('h2', null, 'No ' + filter, h('span', { class: 'sub' }, 'in ' + formatMonthShort(month) + '.')),
      h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: () => { state.historyFilter = 'All'; renderHistory(); } }, 'Show All Categories'))));
  } else {
    const days = [...new Set(entries.map((e) => e.date))];
    parts.push(h('div', { class: 'timeline' }, days.map((day) => {
      const dayEntries = entries.filter((e) => e.date === day);
      return h('div', { class: 'day-group' },
        h('div', { class: 'day-head' },
          h('span', { class: 'node', 'aria-hidden': 'true' }),
          h('h2', null, formatDay(day)), h('span', { class: 'amount' }, rm(sumAmounts(dayEntries)))),
        h('div', { class: 'card day-card' }, h('ul', { class: 'rows', 'aria-label': formatDayLong(day) },
          dayEntries.map((e) => h('li', null, state.selecting ? historySelectRow(e) : historyRow(e))))));
    })));
  }
  setChildren(screen, ...parts);
  updateSelectBar();
  restoreFocus(screen);
}

/**
 * One entry in History. Tap it to edit. A receipt mark sits by the name;
 * entries still saving show "Saving…", and ones that failed show
 * "Couldn't save" with Try Again.
 */
function historyRow(expense) {
  const status = expense.status;
  const title = h('span', { class: 'row-title' }, expense.category, expense.hasReceipt ? icon('receipt', 15) : null,
    expense.hasReceipt ? h('span', { class: 'visually-hidden' }, ', has receipt') : null);
  let second;
  if (status === 'saving') second = h('span', { class: 'row-saving', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Saving…');
  else if (status === 'failed') second = h('span', { class: 'row-failed', role: 'alert' }, "Couldn't save");
  else second = expense.note ? h('span', { class: 'row-note' }, expense.note) : null;
  const main = h('span', { class: 'row-main' }, title, second,
    state.recentlyEdited.has(expense.id) ? h('span', { class: 'tag' }, 'Edited just now') : null);

  if (status === 'failed') {
    return h('div', { class: 'row' }, categoryTile(expense.category), main,
      h('button', { type: 'button', class: 'btn btn-quiet-danger btn-small', onclick: () => saveExpense(expense.id) }, 'Try Again'),
      h('button', {
        type: 'button', class: 'btn btn-secondary btn-icon', style: 'width:44px;height:44px',
        'aria-label': 'Delete unsaved ' + expense.category + ', ' + rm(expense.amount),
        onclick: () => deleteWithUndo([expense.id], expense.category + ' ' + rm(expense.amount) + ' deleted'),
      }, icon('trash', 18)));
  }
  if (status === 'saving') {
    return h('div', { class: 'row' }, categoryTile(expense.category), main, h('span', { class: 'row-amount' }, rm(expense.amount)));
  }
  return h('button', {
    type: 'button', class: 'row', 'data-key': 'row-' + expense.id,
    'aria-label': 'Edit ' + expense.category + (expense.note ? ', ' + expense.note : '') + ', ' + rm(expense.amount) + (expense.hasReceipt ? ', has receipt' : ''),
    onclick: () => openEditForm(expense.id),
  }, categoryTile(expense.category), main, h('span', { class: 'row-amount' }, rm(expense.amount)));
}

/** One entry in edit mode: a round tick you tap to choose it. */
function historySelectRow(expense) {
  const on = state.selected.has(expense.id);
  const unsaved = Boolean(expense.status);
  return h('button', {
    type: 'button', class: 'row', 'aria-pressed': String(on), disabled: unsaved, 'data-key': 'pick-' + expense.id,
    'aria-label': expense.category + (expense.note ? ', ' + expense.note : '') + ', ' + rm(expense.amount),
    onclick: () => { if (on) state.selected.delete(expense.id); else state.selected.add(expense.id); keepFocus('pick-' + expense.id); renderHistory(); },
  },
  h('span', { class: 'pick-circle', 'aria-hidden': 'true' }, on ? icon('check', 16, 3) : null),
  categoryTile(expense.category),
  h('span', { class: 'row-main' },
    h('span', { class: 'row-title' }, expense.category),
    h('span', { class: 'row-note' }, expense.note || (unsaved ? 'Not saved yet' : ''))),
  h('span', { class: 'row-amount' }, rm(expense.amount)));
}

/** Enters edit mode: a red wash, and the tab bar becomes one action bar. */
function startSelecting() {
  hideToast();
  state.selecting = true;
  state.selected.clear();
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

/** Select All / Select None for the entries showing. */
function toggleSelectAll(entries, allChosen) {
  for (const e of entries) {
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
  setChildren(button, n ? icon('trash', 18) : null, n ? 'Delete ' + plural(n, 'Entry', 'Entries') : 'Select Entries First');
}

/** Asks before deleting the chosen entries, listing exactly what will go. */
function confirmDeleteSelected() {
  const chosen = state.expenses.filter((e) => state.selected.has(e.id));
  if (!chosen.length) return;
  const n = chosen.length;
  fillSheet(
    sheetHead('Delete ' + plural(n, 'Entry', 'Entries') + '?', { noClose: true }),
    h('p', { class: 'lede sheet-message' }, 'This can be undone straight after.'),
    h('ul', { class: 'sheet-list rows' },
      chosen.slice(0, 5).map((e) => h('li', { class: 'row' }, categoryTile(e.category),
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, e.category), h('span', { class: 'row-note' }, formatDay(e.date))),
        h('span', { class: 'row-amount' }, rm(e.amount)))),
      n > 5 ? h('li', { class: 'row', style: 'min-height:48px' }, h('span', { class: 'help' }, 'and ' + plural(n - 5, 'more entry', 'more entries'))) : null),
    h('div', { class: 'sheet-actions' },
      h('button', {
        type: 'button', class: 'btn btn-danger btn-block',
        onclick: () => {
          closeSheet();
          const ids = chosen.map((e) => e.id);
          stopSelecting();
          deleteWithUndo(ids, plural(n, 'entry', 'entries') + ' deleted');
        },
      }, icon('trash', 18), 'Delete ' + plural(n, 'Entry', 'Entries')),
      h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: closeSheet }, 'Cancel')));
  $('sheet').classList.add('is-danger');
  openSheet();
}

// ===========================================================================
// 12. Receipts
// ===========================================================================

/**
 * Runs when the user picks or takes a photo. Phone photos are often 3–8 MB,
 * so we shrink it first (compressImage), then keep it with the form until
 * Save, where it's encrypted. Saving waits while this runs.
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

/** Remove: in Add, forget the photo; in Edit, mark it to be removed on save. */
function removeFormPhoto() {
  if (state.form.mode === 'edit') state.form.photo = state.form.original.hasReceipt ? { state: 'remove' } : { state: 'keep' };
  else state.form.photo = null;
  showPhoto(null);
  $('photo-add').focus();
}

/**
 * Shows the photo row: src = an image to show, '' = a placeholder while
 * loading, null = no photo (then the row is "Add Receipt Photo").
 */
function showPhoto(src) {
  const has = src !== null;
  $('photo-add').hidden = has;
  $('photo-has').hidden = !has;
  const thumb = $('photo-thumb');
  if (src) thumb.src = src;
  else thumb.removeAttribute('src');
  $('photo-replace').hidden = !has || state.form.mode !== 'edit';
}

/** Tapping the thumbnail on the form opens the photo full screen. */
function viewFormPhoto() {
  const src = $('photo-thumb').getAttribute('src');
  if (!src) return;
  const values = { category: formCategory(), amount: readAmount() || 0, date: readWhen().date };
  openViewer(src, values);
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
 * The photo for an entry, as an image address: from the memory cache, or
 * the server (which only gives it to the entry's owner), decrypted here.
 * Photos from before encryption arrive as plain JPEGs.
 */
async function getReceiptSrc(id) {
  if (state.receiptCache.has(id)) return state.receiptCache.get(id);
  const result = await callApi('getReceipt', { id });
  const jpeg = result.encrypted ? await SenVault.decryptPhoto(state.vault.key, id, result.data) : result.data;
  const src = 'data:image/jpeg;base64,' + jpeg;
  state.receiptCache.set(id, src);
  return src;
}

/** Opens the receipt viewer: the photo on black with a warm glow, details in an ice card. */
function openViewer(src, values) {
  const viewer = $('receipt-viewer');
  setChildren(viewer,
    h('div', { class: 'viewer-top' },
      h('button', { type: 'button', class: 'btn btn-secondary btn-medium', onclick: () => viewer.close() }, icon('close', 18), 'Close')),
    h('h2', { class: 'visually-hidden', id: 'viewer-title' }, 'Receipt'),
    h('div', { class: 'viewer-image-wrap' }, h('img', { src, alt: 'Receipt photo for ' + values.category + ', ' + rm(values.amount) })),
    h('div', { class: 'ice' },
      h('p', { class: 't' }, values.category + ', ' + rm(values.amount)),
      h('p', { class: 'd' }, formatDay(values.date, true))));
  viewer.showModal();
}

// ===========================================================================
// 13. Settings, Help, What the Developer Can See
// ===========================================================================

/** The name shown in Settings and on statements: the one chosen, else Google's. */
function displayName() {
  if (!state.user) return '';
  if (state.demo) return 'Demo Visitor';
  try {
    const chosen = localStorage.getItem(NAME_PREFIX + state.user.email);
    if (chosen) return chosen;
  } catch (err) { /* ignore */ }
  return state.user.name || '';
}

/** One row in a Settings list: icon tile, words, a chevron. */
function listRow(tileColour, iconName, label, help, onclick) {
  return h('button', { type: 'button', class: 'list-row', onclick },
    h('span', { class: 'tile ' + tileColour }, icon(iconName, 18)),
    h('span', { class: 'grow' }, h('span', { class: 'k' }, label), help ? h('span', { class: 'help' }, help) : null),
    h('span', { class: 'chevron' }, icon('next', 18)));
}

/**
 * Draws Settings: the account card ("Encrypted on Your Phone"), Privacy
 * (Change Passphrase, New Recovery Code, Forget This Device, What the
 * Developer Can See), then Download Statement, Help and Tips, Privacy
 * Policy and Sign Out, and Delete Account. In the demo, rows that need a
 * real account say so; while locked, only what works without the key shows.
 */
function renderSettings() {
  const user = state.user || {};
  const name = displayName();
  const locked = isLocked();
  setWash(state.demo ? 'amber' : 'settings');
  const demoOnly = () => showToast('Sign in to use this. The demo has no passphrase.', { isError: true });

  const account = h('div', { class: 'account-card' + (state.demo ? ' is-demo' : '') },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, ((name || user.email || '?')[0]).toUpperCase()),
    h('span', { class: 'who' },
      h('span', { class: 'name' }, name || 'Add Your Name'),
      h('span', { class: 'email' }, state.demo ? 'Not signed in' : user.email),
      state.demo ? null : h('span', { class: 'lock-line' }, icon('lockSmall', 16), locked ? 'Encrypted, Locked on This Phone' : 'Encrypted on Your Phone')),
    state.demo ? null : h('button', { type: 'button', class: 'link-button', 'aria-label': 'Edit your name', onclick: openNameSheet }, 'Edit'));

  const privacy = h('div', { class: 'card list-card' },
    h('h2', null, 'Privacy'),
    h('div', null,
      locked ? null : listRow('violet', 'key', 'Change Passphrase', null, state.demo ? demoOnly : () => startChangePassphrase()),
      locked ? null : listRow('violet', 'refresh', 'New Recovery Code', 'Your old code will stop working.', state.demo ? demoOnly : () => startNewRecoveryCode()),
      locked ? null : listRow('blue', 'phone', 'Forget This Device', 'Ask for the passphrase next time.', state.demo ? demoOnly : openForgetDeviceSheet),
      listRow('blue', 'eye', 'What the Developer Can See', null, openDeveloperPage)));

  const more = h('div', { class: 'card list-card plain' },
    locked ? null : listRow('blue', 'download', 'Download Statement', null, () => openStatementSheet(currentMonth())),
    listRow('violet', 'help', 'Help and Tips', null, openHelpSheet),
    h('a', { class: 'list-row', href: 'privacy.html' },
      h('span', { class: 'tile green' }, icon('file', 18)),
      h('span', { class: 'grow' }, h('span', { class: 'k' }, 'Privacy Policy')),
      h('span', { class: 'chevron' }, icon('next', 18))),
    state.demo
      ? listRow('amber', 'signOut', 'Exit Demo', null, () => exitDemo())
      : listRow('amber', 'signOut', 'Sign Out', null, signOut));

  const demoNotice = state.demo ? h('div', { class: 'notice notice-amber', role: 'status' },
    icon('alert', 20), h('span', { class: 'text' }, 'Demo. Nothing you add is saved.'),
    h('button', { type: 'button', class: 'btn btn-primary btn-small', onclick: () => exitDemo('') }, 'Sign In')) : null;

  setChildren($('screen-settings'),
    h('div', { class: 'screen-head' }, screenTitle('settings-title', 'Settings', 'and Account')),
    h('div', { class: 'screen-body' },
      demoNotice,
      account,
      privacy,
      more,
      state.demo ? null : h('button', { type: 'button', class: 'btn btn-quiet-danger btn-block delete-account', onclick: openDeleteDataSheet },
        icon('trash', 18), 'Delete Account')));
}

/**
 * "Your Name in Sen Tracker": the name shown in Settings and on statements.
 * It's kept on this device; the Google account name doesn't change.
 * Saving it empty goes back to the Google name.
 */
function openNameSheet() {
  const input = h('input', { id: 'name-input', type: 'text', maxlength: '60', autocomplete: 'name', value: displayName(), 'aria-describedby': 'name-help' });
  const save = () => {
    const value = input.value.trim();
    try {
      if (value && value !== state.user.name) localStorage.setItem(NAME_PREFIX + state.user.email, value);
      else localStorage.removeItem(NAME_PREFIX + state.user.email);
    } catch (err) { /* storage blocked: nothing to save */ }
    closeSheet();
    renderSettings();
    showToast('Name saved');
  };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') save(); });
  fillSheet(
    sheetHead('Your Name'),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'name-input' }, 'Name'),
      h('div', { class: 'input-box' }, input),
      h('p', { class: 'help', id: 'name-help' }, "Shown in Settings and on your statements. Kept on this phone only. Your Google account name doesn't change.")),
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: save }, 'Save Name'),
      h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: closeSheet }, 'Cancel')));
  openSheet();
  input.focus();
  input.select();
}

/**
 * "Forget This Device?": low risk (nothing is deleted), so no typed
 * confirmation. Removes the remembered key and locks the app.
 */
function openForgetDeviceSheet() {
  fillSheet(
    sheetHead('Forget This Device?', { noClose: true }),
    h('p', { class: 'lede sheet-message' }, "You'll need your passphrase next time you open Sen Tracker on this phone. Nothing is deleted."),
    h('div', { class: 'sheet-actions' },
      h('button', {
        type: 'button', class: 'btn btn-primary btn-block',
        onclick: async () => {
          closeSheet();
          await SenVault.forget(state.user.email);
          lockApp();
          showScreen('overview');
          showToast('This phone no longer remembers your passphrase.');
        },
      }, 'Forget This Device'),
      h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: closeSheet }, 'Cancel')));
  openSheet();
}

/** Locks the app now: forgets the key in memory; entries wait, encrypted, until unlocked. */
function lockApp() {
  state.storedRows = state.expenses.filter((e) => e.data && !e.legacy).map(toStoredRow);
  state.expenses = [];
  state.vault = null;
  state.receiptCache.clear();
  saveCache();
}

/**
 * "Delete Account": says exactly how much will go, and only allows the red
 * button once DELETE is typed. Removes every entry, photo and the key box,
 * and forgets this phone's key.
 */
function openDeleteDataSheet() {
  const saved = savedExpenses();
  const photos = saved.filter((e) => e.hasReceipt).length;
  openTypeDeleteSheet({
    title: 'Delete Account?',
    message: "Your entries, receipt photos and passphrase will be deleted for good. You can't get them back.",
    deleted: plural(saved.length, 'entry', 'entries') + ', ' + plural(photos, 'photo', 'photos'),
    kept: 'Your Google account',
    keepLabel: 'Keep My Account',
    actionLabel: 'Delete Account',
    action: async () => {
      if (state.expenses.some((e) => e.status === 'saving')) throw new Error('Some entries are still saving. Wait a few seconds and try again.');
      await commitPendingDelete();
      const result = await callApi('deleteMyData');
      await SenVault.forget(state.user.email);
      closeSheet();
      clearUserData();
      showSignIn('Your account was deleted: ' + plural(result.deletedRows, 'entry', 'entries') + ' and ' +
        plural(result.deletedReceipts, 'photo', 'photos') + '.', 'info');
    },
  });
}

/**
 * A pop-up for anything that deletes for good: what goes and what stays,
 * side by side, and a button that stays dashed until DELETE is typed
 * (WCAG 3.3.4). Used by Delete Account and Start Fresh.
 */
function openTypeDeleteSheet(options) {
  const input = h('input', { id: 'delete-confirm-input', class: 'mono', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
  const box = h('div', { class: 'input-box' }, input);
  const ready = h('span', { class: 'field-ok', role: 'status', hidden: true }, icon('check', 18, 2.6), 'Ready');
  const error = h('div', { class: 'notice notice-red', role: 'alert', hidden: true });
  const button = h('button', { type: 'button', class: 'btn btn-block', disabled: true }, options.actionLabel);
  input.addEventListener('input', () => {
    const ok = input.value.trim().toUpperCase() === 'DELETE';
    button.disabled = !ok;
    button.className = 'btn btn-block' + (ok ? ' btn-coral' : '');
    ready.hidden = !ok;
  });
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Deleting…';
    error.hidden = true;
    try {
      await options.action();
    } catch (err) {
      setChildren(error, icon('alert', 20), h('span', { class: 'text' }, "Couldn't delete: " + err.message));
      error.hidden = false;
      button.disabled = false;
      button.textContent = options.actionLabel;
    }
  });
  fillSheet(
    sheetHead(options.title, { noClose: true }),
    h('p', { class: 'lede sheet-message' }, options.message),
    h('div', { class: 'pair' },
      h('div', { class: 'pair-box' }, h('span', { class: 'k' }, 'Deleted'), h('span', { class: 'v' }, options.deleted)),
      h('div', { class: 'pair-box' }, h('span', { class: 'k' }, 'Kept'), h('span', { class: 'v' }, options.kept))),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'delete-confirm-input' }, 'Type DELETE to Confirm'), box, ready),
    error,
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: options.onKeep || closeSheet }, options.keepLabel),
      button));
  $('sheet').classList.add('is-danger');
  openSheet();
  input.focus();
}

/** "Help and Tips": short answers to the questions people ask most. */
function openHelpSheet() {
  const tips = [
    ['Add in Seconds', 'Tap Add, type the amount, pick a category. The date and time are filled in for you.'],
    ['Change or Delete', 'In History, tap an entry to edit it. To delete, tap Edit at the top and choose entries.'],
    ['See Another Month', 'On Overview, tap Period to pick a day, month or year. In History, tap the month name.'],
    ['Your Passphrase', 'It unlocks your entries on a new phone. Only you know it: nobody can reset it for you.'],
    ['Your Recovery Code', 'If you forget your passphrase, the code lets you make a new one. Keep it somewhere away from this phone.'],
    ['Works Offline', 'Entries you add without internet save as soon as you are back online.'],
  ];
  fillSheet(
    sheetHead('Help and Tips'),
    h('ul', { class: 'help-list sheet-list' }, tips.map(([t, d]) => h('li', null, h('b', null, t), h('span', { class: 'help' }, d)))),
    h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: closeSheet }, 'Close'));
  openSheet();
}

/**
 * "What the Developer Can See": exactly what's stored, and who can read it,
 * as two real lists. Reached from Settings and Sign In.
 */
function openDeveloperPage() {
  const dialog = $('page-dialog');
  const item = (colour, iconName, label) => h('li', null, h('span', { class: 'tile ' + colour }, icon(iconName, 18)), label);
  setChildren(dialog,
    h('div', { class: 'mesh', 'aria-hidden': 'true', style: '--top:#0a1638;--g1:rgba(143,240,255,.25);--g2:rgba(61,139,255,.18);--g3:rgba(122,61,255,.1)' }),
    h('div', { class: 'inner' },
      h('div', null, h('button', { type: 'button', class: 'btn btn-secondary btn-back', onclick: () => dialog.close() }, icon('back', 20), 'Back')),
      h('h1', { class: 'title', id: 'page-title', style: '--sub-from:#8fd8ff' }, 'What the ', h('span', { class: 'sub' }, 'Developer Can See')),
      h('p', { class: 'lede' }, "Exactly what's stored, and who can read it."),
      h('section', { class: 'card see-list', 'aria-labelledby': 'see-1' },
        h('h2', { id: 'see-1' }, icon('lock', 20), 'Encrypted, Only You'),
        h('p', { class: 'help' }, "Encrypted on your phone with your passphrase before they're saved."),
        h('ul', null, item('green', 'money', 'Amounts'), item('green', 'tag', 'Categories'), item('green', 'calendar', 'Dates and Times'),
          item('green', 'noteLines', 'Notes'), item('green', 'image', 'Receipt Photos'))),
      h('section', { class: 'card see-list', 'aria-labelledby': 'see-2' },
        h('h2', { id: 'see-2' }, icon('eye', 20), 'The Developer Can See'),
        h('p', { class: 'help' }, 'Needed to keep your account and entries in sync.'),
        h('ul', null, item('blue', 'mail', 'Your Email'), item('blue', 'hash', 'How Many Entries'), item('blue', 'clock', 'When Each Was Created'),
          item('blue', 'image', 'Receipt Photo Sizes'))),
      h('a', { class: 'btn btn-secondary btn-block', href: CODE_URL, target: '_blank', rel: 'noopener' }, icon('external', 18), 'See the Public Code'),
      h('p', { class: 'caption', style: 'text-align:center' }, 'Opens GitHub in your browser')));
  dialog.showModal();
}

// ===========================================================================
// 14. PDF statement
// ===========================================================================

/**
 * "Download Statement" for a month. Shows the month (tap to change), how
 * many entries it has, and what the PDF contains. With no entries, an amber
 * notice says why and the button is dashed: "Nothing to Download".
 */
function openStatementSheet(month) {
  SenStatement.load().catch(() => { /* tried again on Download */ });
  const entries = savedExpenses().filter((e) => e.date.startsWith(month + '-'));
  const unsaved = state.expenses.some((e) => e.status && e.date.startsWith(month + '-'));
  const monthName = MONTHS[Number(month.slice(5)) - 1];
  fillSheet(
    sheetHead('Download Statement'),
    h('button', {
      type: 'button', class: 'pair-box', style: 'width:100%;text-align:left;color:inherit', 'aria-label': 'Month: ' + formatMonth(month) + ', ' + plural(entries.length, 'entry', 'entries') + '. Change month',
      onclick: () => openPeriodSheet({ types: ['month'], value: { type: 'month', value: month }, onChoose: (p) => openStatementSheet(p.value) }),
    }, h('span', { class: 'k' }, 'Month'),
    h('span', { style: 'display:flex;justify-content:space-between;align-items:center;width:100%;gap:8px' },
      h('span', { class: 'v' }, formatMonth(month)), h('span', { class: 'help' }, plural(entries.length, 'entry', 'entries'), ' ', icon('next', 16)))),
    entries.length ? null : h('div', { class: 'notice notice-amber', role: 'status' }, icon('info', 20),
      h('span', { class: 'text' }, 'No entries in ' + formatMonthShort(month) + '. Pick another month.')),
    h('div', { class: 'statement-file inset' },
      h('span', { class: 'pdf-tile', 'aria-hidden': 'true' }, icon('file', 18), 'PDF'),
      h('div', null, h('p', { class: 'name' }, 'PDF Document'),
        h('p', { class: 'help' }, 'Easy to print or share. Receipt photos are not included.' + (unsaved ? ' Entries not saved yet are left out.' : '')))),
    entries.length
      ? h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: () => downloadStatement(month, entries) }, icon('download', 18), 'Download ' + monthName)
      : h('button', { type: 'button', class: 'btn btn-block', disabled: true }, 'Nothing to Download'));
  openSheet();
}

/**
 * Makes the PDF (statement.js does the drawing), saves it to the phone, and
 * shows "Statement Ready" with Open and, where the phone supports it, Share.
 * Entries go in date order, oldest first, so it reads like a diary of the
 * month; last month's entries are passed for the "vs" comparisons.
 */
async function downloadStatement(month, entries) {
  let pdf;
  try {
    // Fonts and logo load once (they're stored by the service worker after).
    const resources = await SenStatement.load();
    const oldestFirst = (a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.time || '') < (b.time || '') ? -1 : 1);
    pdf = SenStatement.build({
      month,
      monthLabel: formatMonth(month),
      name: displayName(),
      email: state.demo ? 'Demo mode (sample data)' : state.user.email,
      entries: entries.slice().sort(oldestFirst),
      previousEntries: savedExpenses().filter((e) => e.date.startsWith(addMonths(month, -1) + '-')),
      generatedAt: new Date(),
    }, resources);
  } catch (err) {
    console.error(err);
    showToast("Couldn't make the statement. Check your connection and try again.", { isError: true });
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
    sheetHead('Statement Ready.'),
    h('div', { class: 'statement-file inset' },
      h('span', { class: 'pdf-tile ready', 'aria-hidden': 'true' }, icon('check', 18, 2.6), 'PDF'),
      h('div', { style: 'min-width:0' }, h('p', { class: 'name' }, pdf.fileName),
        h('p', { class: 'help' }, plural(pdf.pages, 'page', 'pages') + ' · saved to your downloads'))),
    h('div', { class: canShare ? 'two-buttons' : 'sheet-actions' },
      h('a', { class: 'btn btn-primary btn-block', href: url, target: '_blank', rel: 'noopener' }, icon('file', 18), 'Open'),
      canShare ? h('button', {
        type: 'button', class: 'btn btn-secondary btn-block',
        onclick: () => navigator.share({ files: [file], title: pdf.fileName }).catch(() => { /* cancelled */ }),
      }, icon('share', 18), 'Share') : null));
}

// ===========================================================================
// 15. Toast, notices and pop-ups
// ===========================================================================

/**
 * Shows the message above the tab bar. It stays up until it's closed or the
 * user leaves the screen. options.undo adds an Undo button; options.onClose
 * runs when the message goes away for any reason (used to send a waiting
 * delete); options.isError shows an error mark.
 */
function showToast(message, options = {}) {
  hideToast();
  const toast = $('toast');
  state.toast = { onClose: options.onClose };
  toast.classList.toggle('is-error', Boolean(options.isError));
  toast.setAttribute('role', options.isError ? 'alert' : 'status');
  setChildren(toast,
    h('span', { class: 'toast-icon' }, icon(options.isError ? 'alert' : 'check', 16, 2.6)),
    h('span', { class: 'toast-text' }, message),
    options.undo ? h('button', { type: 'button', class: 'btn btn-primary btn-medium', onclick: options.undo }, 'Undo') : null,
    h('button', { type: 'button', class: 'btn btn-secondary btn-icon', 'aria-label': 'Dismiss', onclick: hideToast }, icon('close', 18)));
  toast.hidden = false;
}

/** Closes the message (and runs its onClose, e.g. sends a waiting delete). */
function hideToast() {
  const current = state.toast;
  state.toast = null;
  $('toast').hidden = true;
  if (current && current.onClose) current.onClose();
}

/** The title row of a pop-up, with a close button unless options.noClose. */
function sheetHead(title, options = {}) {
  return h('div', { class: 'sheet-head' },
    h('h2', { class: 'sheet-title', id: 'sheet-title' }, title),
    options.noClose ? null : h('button', { type: 'button', class: 'btn btn-secondary btn-icon', 'aria-label': 'Close', onclick: closeSheet }, icon('close', 18)));
}

/** Replaces the pop-up's content (one <dialog> is reused for every pop-up). */
function fillSheet(...children) {
  const sheet = $('sheet');
  sheet.classList.remove('is-danger');
  sheet.removeAttribute('role');
  setChildren(sheet, h('div', { class: 'sheet-body' }, children));
}

/**
 * Opens the pop-up. Tapping the dim area around it closes it, like most
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

/** Closes the pop-up, the receipt viewer and the full-screen page if they're open. */
function closeSheet() {
  for (const id of ['sheet', 'receipt-viewer', 'page-dialog']) if ($(id).open) $(id).close();
}

// Start once every script (including passphrase.js) has loaded.
document.addEventListener('DOMContentLoaded', start);
