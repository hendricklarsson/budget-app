// app.js — the app's logic: sign-in, talking to the script, drawing the list.
//
// Big picture:
//   1. Google Sign-In gives us an "ID token" (a signed text that says who the
//      user is). We keep it and send it with every request.
//   2. callApi() POSTs {action, idToken, ...} to the Apps Script URL.
//   3. The user's rows are cached in localStorage, so the list shows instantly
//      and is then refreshed in the background.

'use strict';

// ---------------------------------------------------------------------------
// State: everything the app currently knows, in one place.
// ---------------------------------------------------------------------------

const state = {
  idToken: null,   // the raw Google ID token, sent to the script
  user: null,      // {email, name, exp} read from the token, for display only
  expenses: [],    // the user's rows, newest first
};

const TOKEN_KEY = 'budget.session';            // where the token is kept
const CACHE_PREFIX = 'budget.expenses.';       // + email, one cache per user
const EXPIRY_MARGIN_MS = 60 * 1000;            // treat tokens as expired 1 min early

// Shortcut for document.getElementById.
const $ = (id) => document.getElementById(id);

// Money in Malaysian ringgit, e.g. "RM 12.50".
const money = new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' });

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

/**
 * Runs once when the page loads. Restores a saved sign-in if it is still
 * valid (so a reload doesn't force a new sign-in), sets up Google's button,
 * and wires up the buttons.
 */
function start() {
  if (CLIENT_ID.startsWith('PASTE_') || SCRIPT_URL.startsWith('PASTE_')) {
    showSignIn('Setup needed: put your Client ID and Script URL in config.js.', true);
    return;
  }

  $('signout-button').addEventListener('click', signOut);
  $('refresh-button').addEventListener('click', () => loadExpenses());

  initGoogleSignIn();

  const saved = loadSession();
  if (saved) {
    state.idToken = saved.idToken;
    state.user = saved.user;
    showApp();
  } else {
    showSignIn();
  }
}

/**
 * Sets up "Sign in with Google" and draws its button. Google calls
 * handleCredential() when the user signs in.
 * auto_select lets a returning user sign back in with one tap or none.
 */
function initGoogleSignIn() {
  if (typeof google === 'undefined' || !google.accounts) {
    // The library didn't load: usually no internet connection.
    showSignIn('Could not load Google Sign-In. Check your connection and reload.', true);
    return;
  }
  google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: handleCredential,
    auto_select: true,
  });
  google.accounts.id.renderButton($('google-button'), {
    theme: 'outline',
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
  });
}

// ---------------------------------------------------------------------------
// Sign-in and session
// ---------------------------------------------------------------------------

/**
 * Called by Google after a successful sign-in. response.credential is the
 * ID token. We read the email and expiry from it to show in the app, but the
 * real check happens on the server, which asks Google if it is genuine.
 */
function handleCredential(response) {
  const payload = decodeJwtPayload(response.credential);
  state.idToken = response.credential;
  state.user = { email: payload.email, name: payload.name, exp: payload.exp };
  saveSession();
  showApp();
}

/**
 * Reads the middle part of a JWT (header.payload.signature). It is base64url
 * text containing JSON. We decode via bytes + TextDecoder so names with
 * accents or non-Latin letters come out right.
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

/** Keeps the token across reloads until it expires. */
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
 * Called when the token has expired (or the server says it is invalid).
 * Keeps the cached rows (they'll show again after sign-in) but asks the user
 * to sign in again. prompt() shows Google's One Tap to make it quick.
 */
function handleExpiredSession() {
  state.idToken = null;
  localStorage.removeItem(TOKEN_KEY);
  showSignIn('Your sign-in has expired. Please sign in again.');
  if (typeof google !== 'undefined' && google.accounts) google.accounts.id.prompt();
}

/**
 * Signs out: forgets the token AND this user's cached rows, so the next
 * person using this phone or computer can't see them.
 * disableAutoSelect() stops Google from signing the same user straight back in.
 */
function signOut() {
  if (state.user) localStorage.removeItem(CACHE_PREFIX + state.user.email);
  localStorage.removeItem(TOKEN_KEY);
  state.idToken = null;
  state.user = null;
  state.expenses = [];
  if (typeof google !== 'undefined' && google.accounts) google.accounts.id.disableAutoSelect();
  showSignIn();
}

// ---------------------------------------------------------------------------
// Talking to the script
// ---------------------------------------------------------------------------

/**
 * Sends one request to the Apps Script backend and returns its JSON answer.
 *
 * Why text/plain: a JSON content type would make the browser send a CORS
 * "preflight" request first, which Apps Script can't answer. text/plain is a
 * "simple" request, so it goes straight through. The body is still JSON.
 *
 * Throws an Error (with .code from the server) if anything fails.
 */
async function callApi(action, data = {}) {
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
    });
  } catch (err) {
    throw Object.assign(new Error('No connection to the server. Check your internet.'), { code: 'NETWORK' });
  }
  if (!response.ok) {
    throw Object.assign(new Error('Server error (' + response.status + ').'), { code: 'NETWORK' });
  }

  const result = await response.json();
  if (!result.ok) {
    if (result.code === 'AUTH') handleExpiredSession();
    throw Object.assign(new Error(result.error), { code: result.code });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Expenses: load, cache, draw
// ---------------------------------------------------------------------------

/**
 * Fetches the user's rows from the script, saves them to the cache and
 * redraws. The cached list is already on screen, so this feels instant.
 */
async function loadExpenses() {
  setStatus(state.expenses.length ? '' : 'Loading…');
  try {
    const result = await callApi('list');
    state.expenses = result.expenses;
    saveCache();
    renderExpenses();
    setStatus('');
  } catch (err) {
    if (err.code !== 'AUTH') setStatus(err.message, true);
  }
}

/** Saves this user's rows in localStorage, under a key with their email. */
function saveCache() {
  localStorage.setItem(CACHE_PREFIX + state.user.email, JSON.stringify(state.expenses));
}

/** Loads this user's cached rows, or an empty list if there are none. */
function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_PREFIX + state.user.email)) || [];
  } catch (err) {
    return [];
  }
}

/**
 * Draws the list of entries. Uses textContent (never innerHTML) for user
 * text, so a note like "<script>" is shown as text, not run as code.
 */
function renderExpenses() {
  const list = $('expense-list');
  list.replaceChildren();
  $('empty-list').hidden = state.expenses.length > 0;

  for (const expense of state.expenses) {
    const item = document.createElement('li');
    item.className = 'expense';

    const main = document.createElement('div');
    main.className = 'expense-main';
    const category = document.createElement('div');
    category.className = 'expense-category';
    category.textContent = expense.category;
    const meta = document.createElement('div');
    meta.className = 'expense-meta';
    meta.textContent = expense.note ? expense.date + ' · ' + expense.note : expense.date;
    main.append(category, meta);

    const amount = document.createElement('div');
    amount.className = 'expense-amount';
    amount.textContent = money.format(expense.amount);

    item.append(main, amount);
    list.append(item);
  }
}

// ---------------------------------------------------------------------------
// Screens and messages
// ---------------------------------------------------------------------------

/** Shows the sign-in screen, optionally with a message (red if isError). */
function showSignIn(message = '', isError = false) {
  $('app-screen').hidden = true;
  $('signin-screen').hidden = false;
  const box = $('signin-message');
  box.textContent = message;
  box.hidden = !message;
  box.classList.toggle('error', isError);
}

/**
 * Shows the main app for the signed-in user: draws the cached rows at once,
 * then refreshes from the server in the background.
 */
function showApp() {
  $('signin-screen').hidden = true;
  $('app-screen').hidden = false;
  $('user-email').textContent = state.user.email;
  state.expenses = loadCache();
  renderExpenses();
  loadExpenses();
}

/** Shows a status line above the list; an empty message hides it. */
function setStatus(message, isError = false) {
  const box = $('status');
  box.textContent = message;
  box.hidden = !message;
  box.classList.toggle('error', isError);
}

start();
