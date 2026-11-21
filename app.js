// app.js — the app's logic: sign-in, talking to the script, drawing screens.
//
// Big picture:
//   1. Google Sign-In gives us an "ID token" (a signed text that says who the
//      user is). We keep it and send it with every request.
//   2. callApi() POSTs {action, idToken, ...} to the Apps Script URL.
//   3. The user's rows live in state.expenses and are cached in localStorage,
//      so screens draw instantly; the server is refreshed in the background.
//   4. New entries appear at once ("optimistic" update) and save in the
//      background. If a save fails, the entry is marked so the user can retry.

'use strict';

// ---------------------------------------------------------------------------
// Settings and state
// ---------------------------------------------------------------------------

// Must match the list in Code.gs, which re-checks every value.
const CATEGORIES = ['Food', 'Transport', 'Bills', 'Shopping', 'Health', 'Entertainment', 'Other'];
const MAX_AMOUNT = 1000000;
const MAX_NOTE_LENGTH = 200;

const TOKEN_KEY = 'budget.session';            // where the token is kept
const CACHE_PREFIX = 'budget.expenses.';       // + email, one cache per user
const EXPIRY_MARGIN_MS = 60 * 1000;            // treat tokens as expired 1 min early
const REFRESH_BEFORE_MS = 5 * 60 * 1000;       // try to renew the sign-in 5 min before it ends
const PHOTO_MAX_SIZE = 1280;                   // longest side of a receipt photo, in pixels
const PHOTO_QUALITY = 0.75;                    // JPEG quality: 0.75 keeps text readable, files ~150 KB

// Everything the app currently knows, in one place.
const state = {
  idToken: null,        // the raw Google ID token, sent to the script
  user: null,           // {email, name, exp} read from the token, for display only
  // The user's entries, newest first. Each is
  // {id, date, amount, category, note, hasReceipt, createdAt, status?, error?, receipt?}
  // where status is only set on entries not yet on the server:
  // 'saving' (request in progress) or 'failed' (needs a retry),
  // and receipt ({mimeType, data}) is the photo waiting to be uploaded.
  expenses: [],
  deleting: new Set(),  // ids being deleted right now (so a refresh won't bring them back)
  receiptPhoto: null,   // the compressed photo chosen on the Add form, {mimeType, data}
  preparingPhoto: false, // true while a photo is being compressed
  receiptCache: new Map(), // id → image already loaded, so opening it twice is instant
  refreshTimer: null,   // timer that renews the sign-in shortly before it expires
  expiryTimer: null,    // timer that asks the user to sign in again if renewing didn't work
  screen: 'add',        // which tab is open
  summaryMonth: null,   // 'yyyy-mm' shown on the Summary screen
};

// Shortcut for document.getElementById.
const $ = (id) => document.getElementById(id);

// Money in Malaysian ringgit, e.g. "RM 12.50".
const money = new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' });

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

/**
 * Runs once when the page loads: wires up every button, sets up Google's
 * sign-in, and restores a saved sign-in if it is still valid (so a reload
 * doesn't force a new sign-in).
 */
function start() {
  registerServiceWorker();

  if (CLIENT_ID.startsWith('PASTE_') || SCRIPT_URL.startsWith('PASTE_')) {
    showSignIn('Setup needed: put your Client ID and Script URL in config.js.', true);
    return;
  }

  state.summaryMonth = currentMonth();
  fillCategoryOptions();
  resetAddForm();

  // Buttons and forms.
  $('add-form').addEventListener('submit', handleAddSubmit);
  $('refresh-button').addEventListener('click', () => loadExpenses());
  $('signout-button').addEventListener('click', signOut);
  $('prev-month').addEventListener('click', () => changeMonth(-1));
  $('next-month').addEventListener('click', () => changeMonth(1));
  for (const tab of document.querySelectorAll('.tabbar button')) {
    tab.addEventListener('click', () => showScreen(tab.dataset.screen));
  }
  // One listener for every Delete/Retry button in History ("event delegation"):
  // the list is redrawn often, so this is simpler than a listener per button.
  $('history-list').addEventListener('click', handleHistoryClick);

  // Receipts.
  $('receipt-input').addEventListener('change', handleReceiptChosen);
  $('receipt-remove').addEventListener('click', clearReceiptPhoto);
  $('receipt-close').addEventListener('click', () => $('receipt-dialog').close());

  // Delete my data.
  $('delete-data-button').addEventListener('click', openDeleteDialog);
  $('delete-cancel').addEventListener('click', () => $('delete-dialog').close());
  $('delete-confirm').addEventListener('click', deleteMyData);
  $('delete-confirm-input').addEventListener('input', () => {
    $('delete-confirm').disabled = $('delete-confirm-input').value.trim().toUpperCase() !== 'DELETE';
  });

  // Tapping the dark area around a pop-up closes it, like most apps.
  // A tap on the backdrop is reported as a tap on the <dialog> itself, so we
  // check whether it landed outside the dialog's box.
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => {
      const box = dialog.getBoundingClientRect();
      const outside = event.clientX < box.left || event.clientX > box.right ||
                      event.clientY < box.top || event.clientY > box.bottom;
      if (event.target === dialog && outside) dialog.close();
    });
  }

  // Phones pause timers while the app is in the background, so when it comes
  // back to the front (e.g. unlocked after an hour) we check the sign-in again.
  document.addEventListener('visibilitychange', () => {
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
 * Older browsers without service workers simply skip this.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch((err) => {
    console.warn('Service worker not registered:', err);
  });
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
 * Sets two timers based on when the token expires:
 *   - 5 minutes before: try to renew the sign-in quietly (renewSignIn);
 *   - 1 minute before: if it still wasn't renewed, ask the user to sign in.
 * Called after every sign-in, and whenever the app comes back to the front.
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
 * Asks Google for a fresh token without interrupting the user. Because we
 * set auto_select: true, Google signs a returning user straight back in
 * (at most a small "Signing in as…" banner) and calls handleCredential with
 * the new token. Google may skip this, e.g. after the user dismissed its
 * prompt, or in browsers that block it; then the expiry timer asks the user
 * to sign in normally, as before.
 */
function renewSignIn() {
  if (typeof google !== 'undefined' && google.accounts) google.accounts.id.prompt();
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
  clearTimeout(state.refreshTimer);
  clearTimeout(state.expiryTimer);
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
  const unsaved = state.expenses.filter((e) => e.status).length;
  if (unsaved && !confirm(unsaved + ' entries are not saved yet and will be lost. Sign out anyway?')) {
    return;
  }
  clearUserData();
  showSignIn();
}

/** Forgets everything about the current user on this device. */
function clearUserData() {
  if (state.user) localStorage.removeItem(CACHE_PREFIX + state.user.email);
  localStorage.removeItem(TOKEN_KEY);
  state.idToken = null;
  state.user = null;
  state.expenses = [];
  state.receiptCache.clear();
  clearReceiptPhoto();
  clearTimeout(state.refreshTimer);
  clearTimeout(state.expiryTimer);
  if (typeof google !== 'undefined' && google.accounts) google.accounts.id.disableAutoSelect();
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
    throw Object.assign(new Error('No connection to the server.'), { code: 'NETWORK' });
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
// Loading and caching entries
// ---------------------------------------------------------------------------

/**
 * Fetches the user's rows from the script, then redraws.
 * Entries that are not on the server yet (still saving, or failed) are kept,
 * and entries being deleted are left out, so a refresh never undoes the
 * user's most recent actions.
 */
async function loadExpenses() {
  if (!state.expenses.length) setStatus('Loading…');
  try {
    const result = await callApi('list');
    const serverIds = new Set(result.expenses.map((e) => e.id));
    const notOnServerYet = state.expenses.filter((e) => e.status && !serverIds.has(e.id));
    state.expenses = result.expenses
      .filter((e) => !state.deleting.has(e.id))
      .concat(notOnServerYet);
    sortExpenses();
    saveCache();
    renderAll();
    setStatus('');
  } catch (err) {
    if (err.code !== 'AUTH') setStatus('Could not refresh: ' + err.message, true);
  }
}

/**
 * Saves this user's rows in localStorage, under a key with their email.
 * Unsaved entries include their photo, so a retry still has it after the app
 * is closed. localStorage holds about 5 MB, so if it is full we just skip
 * caching: the app still works, it only loads a little slower next time.
 */
function saveCache() {
  try {
    localStorage.setItem(CACHE_PREFIX + state.user.email, JSON.stringify(state.expenses));
  } catch (err) {
    console.warn('Could not cache entries:', err);
  }
}

/**
 * Loads this user's cached rows. An entry cached as "saving" was cut off
 * (the app was closed mid-save), so it becomes "failed" for the user to retry.
 */
function loadCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_PREFIX + state.user.email)) || [];
    for (const e of cached) {
      if (e.status === 'saving') {
        e.status = 'failed';
        e.error = 'The app closed before it saved.';
      }
    }
    return cached;
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

// ---------------------------------------------------------------------------
// Add screen
// ---------------------------------------------------------------------------

/** Fills the Category drop-down from CATEGORIES. */
function fillCategoryOptions() {
  const select = $('category');
  for (const name of CATEGORIES) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
}

/**
 * Clears amount and note after an add. Date and category are kept on purpose:
 * people often add several things from the same day or shop in a row.
 */
function resetAddForm() {
  $('amount').value = '';
  $('note').value = '';
  if (!$('date').value) $('date').value = today();
  clearReceiptPhoto();
  $('form-error').hidden = true;
}

/** Shows a red message under the Add form. */
function showFormError(message) {
  $('form-error').textContent = message;
  $('form-error').hidden = false;
}

/**
 * Reads and checks the Add form. Returns {expense} or {error}.
 * The server checks everything again; checking here just gives instant
 * feedback without a 2-second round trip.
 */
function readAddForm() {
  const amountText = $('amount').value.trim();
  const amount = Math.round(Number(amountText) * 100) / 100;
  if (!amountText || !Number.isFinite(amount) || amount <= 0) {
    return { error: 'Enter an amount above RM 0.' };
  }
  if (amount > MAX_AMOUNT) return { error: 'The amount can be at most RM 1,000,000.' };

  const category = $('category').value;
  if (!CATEGORIES.includes(category)) return { error: 'Choose a category.' };

  const date = $('date').value; // date inputs always give yyyy-mm-dd
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Choose a date.' };

  const note = $('note').value.trim();
  if (note.length > MAX_NOTE_LENGTH) return { error: 'The note can be at most 200 characters.' };

  return { expense: { amount, category, date, note } };
}

/**
 * Handles "Add expense": shows the entry straight away, then saves it in the
 * background. The id is made here (a random UUID) so the entry has the same
 * id on screen and on the server, and a retry can't create a duplicate.
 */
function handleAddSubmit(event) {
  event.preventDefault(); // stop the browser reloading the page
  if (state.preparingPhoto) return showFormError('Wait a moment, the photo is still being prepared.');
  const { expense: values, error } = readAddForm();
  if (error) return showFormError(error);

  const expense = {
    ...values,
    id: makeId(),
    hasReceipt: Boolean(state.receiptPhoto),
    createdAt: new Date().toISOString(),
    status: 'saving',
  };
  if (state.receiptPhoto) expense.receipt = state.receiptPhoto;
  state.expenses.push(expense);
  sortExpenses();
  saveCache();
  renderAll();

  resetAddForm();
  $('amount').focus();
  showToast('Added ' + money.format(expense.amount) + ' · ' + expense.category);
  saveExpense(expense.id);
}

/**
 * Sends one not-yet-saved entry to the server. On success the local copy is
 * replaced by the server's copy (which has no status). On failure it is
 * marked "failed" with the reason, and History shows a Retry button.
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
    // Keep the photo we already have, so viewing it needs no download.
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
    showToast('Not saved: ' + err.message, true);
  }
  sortExpenses();
  saveCache();
  renderAll();
}

// ---------------------------------------------------------------------------
// History screen
// ---------------------------------------------------------------------------

/** Works out which button in History was tapped, and on which entry. */
function handleHistoryClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  if (button.dataset.action === 'delete') deleteExpense(button.dataset.id);
  if (button.dataset.action === 'retry') saveExpense(button.dataset.id);
  if (button.dataset.action === 'receipt') viewReceipt(button.dataset.id);
}

/**
 * Deletes an entry after the user confirms. It disappears at once; if the
 * server then fails, it is put back and the user is told.
 * NOT_FOUND counts as success: it means the server never had it (e.g. an
 * entry whose save had failed) or it was already deleted.
 */
async function deleteExpense(id) {
  const expense = findExpense(id);
  if (!expense || expense.status === 'saving') return;
  const label = expense.category + ' ' + money.format(expense.amount) + ' on ' + formatDay(expense.date);
  if (!confirm('Delete ' + label + '?')) return;

  state.expenses = state.expenses.filter((e) => e.id !== id);
  state.deleting.add(id);
  saveCache();
  renderAll();

  try {
    await callApi('delete', { id });
    showToast('Deleted');
  } catch (err) {
    if (err.code !== 'NOT_FOUND') {
      state.expenses.push(expense);
      sortExpenses();
      saveCache();
      renderAll();
      showToast('Could not delete: ' + err.message, true);
    }
  } finally {
    state.deleting.delete(id);
  }
}

/** Redraws every screen that shows entries. Cheap at this app's size. */
function renderAll() {
  renderHistory();
  renderSummary();
}

/**
 * Draws History: entries grouped under a heading per day.
 * Uses textContent (never innerHTML) for user text, so a note like
 * "<script>" is shown as text, not run as code.
 */
function renderHistory() {
  const container = $('history-list');
  container.replaceChildren();
  $('empty-list').hidden = state.expenses.length > 0;

  let currentDay = null;
  let list = null;
  for (const expense of state.expenses) {
    if (expense.date !== currentDay) {
      currentDay = expense.date;
      list = createElement('ul', 'expense-list');
      container.append(createElement('h3', 'day-heading', formatDay(expense.date)), list);
    }
    list.append(renderExpenseItem(expense));
  }
}

/** Builds one entry in the History list, with its status and buttons. */
function renderExpenseItem(expense) {
  const item = createElement('li', 'expense');
  if (expense.status) item.classList.add('is-' + expense.status);

  const main = createElement('div', 'expense-main');
  main.append(createElement('div', 'expense-category', expense.category));
  if (expense.status === 'saving') {
    main.append(createElement('div', 'expense-meta saving', 'Saving…'));
  } else if (expense.status === 'failed') {
    main.append(createElement('div', 'expense-meta failed', 'Not saved: ' + (expense.error || 'unknown error')));
  }
  if (expense.note) main.append(createElement('div', 'expense-meta', expense.note));

  const side = createElement('div', 'expense-side');
  side.append(createElement('div', 'expense-amount', money.format(expense.amount)));
  if (expense.hasReceipt) {
    side.append(createButton('Receipt', 'receipt', expense.id, 'small-button'));
  }
  if (expense.status === 'failed') {
    side.append(createButton('Retry', 'retry', expense.id, 'small-button'));
  }
  const del = createButton('Delete', 'delete', expense.id, 'small-button danger');
  del.disabled = expense.status === 'saving';
  side.append(del);

  item.append(main, side);
  return item;
}

// ---------------------------------------------------------------------------
// Summary screen
// ---------------------------------------------------------------------------

/**
 * Draws the Summary for state.summaryMonth: total, number of entries, and a
 * total per category (largest first) with its share of the month.
 * Calculated on the phone from rows already loaded, so it is instant.
 * Sums are done in whole sen (cents) to avoid errors like 0.1 + 0.2 = 0.30000000000000004.
 */
function renderSummary() {
  const month = state.summaryMonth;
  $('month-label').textContent = formatMonth(month);
  $('next-month').disabled = month >= currentMonth();

  const entries = state.expenses.filter((e) => e.date.startsWith(month + '-'));
  const senByCategory = {};
  let totalSen = 0;
  for (const e of entries) {
    const sen = Math.round(e.amount * 100);
    senByCategory[e.category] = (senByCategory[e.category] || 0) + sen;
    totalSen += sen;
  }

  $('month-total').textContent = money.format(totalSen / 100);
  $('month-count').textContent = plural(entries.length, 'entry', 'entries');

  const list = $('category-totals');
  list.replaceChildren();
  const rows = Object.entries(senByCategory).sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    list.append(createElement('li', 'muted', 'No spending this month.'));
  }
  for (const [category, sen] of rows) {
    const item = document.createElement('li');
    const amount = createElement('span', 'amount', money.format(sen / 100));
    amount.append(createElement('span', 'percent', Math.round((sen / totalSen) * 100) + '%'));
    item.append(createElement('span', '', category), amount);
    list.append(item);
  }
}

/** Moves the Summary one month back (-1) or forward (+1), never past this month. */
function changeMonth(delta) {
  const [year, month] = state.summaryMonth.split('-').map(Number);
  const d = new Date(year, month - 1 + delta, 1); // Date handles year roll-over
  const next = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  if (next > currentMonth()) return;
  state.summaryMonth = next;
  renderSummary();
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * Runs when the user picks or takes a photo on the Add form. Phone photos
 * are often 3–8 MB, so we shrink it first (see compressImage) and keep the
 * result until the entry is added. The Add button waits while this runs.
 */
async function handleReceiptChosen() {
  const file = $('receipt-input').files[0];
  state.receiptPhoto = null;
  $('receipt-preview').hidden = true;
  $('form-error').hidden = true;
  if (!file) return;

  state.preparingPhoto = true;
  const button = $('add-form').querySelector('.primary-button');
  button.disabled = true;
  button.textContent = 'Preparing photo…';
  try {
    const blob = await compressImage(file);
    const data = await blobToBase64(blob);
    state.receiptPhoto = { mimeType: 'image/jpeg', data };
    $('receipt-thumb').src = 'data:image/jpeg;base64,' + data;
    $('receipt-preview').hidden = false;
  } catch (err) {
    $('receipt-input').value = '';
    showFormError(err.message);
  } finally {
    state.preparingPhoto = false;
    button.disabled = false;
    button.textContent = 'Add expense';
  }
}

/** Removes the chosen photo from the Add form. */
function clearReceiptPhoto() {
  state.receiptPhoto = null;
  $('receipt-input').value = '';
  $('receipt-preview').hidden = true;
  $('receipt-thumb').removeAttribute('src');
}

/**
 * Shrinks a photo so its longest side is at most PHOTO_MAX_SIZE pixels and
 * saves it as a JPEG. How: load the file into an <img>, draw it smaller on a
 * <canvas>, then ask the canvas for a JPEG. Modern browsers rotate phone
 * photos the right way up when drawing them, so receipts aren't sideways.
 */
async function compressImage(file) {
  const url = URL.createObjectURL(file); // a temporary link to the file
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
    URL.revokeObjectURL(url); // free the memory the link used
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

/**
 * Turns a file (blob) into base64 text, which can travel inside JSON.
 * readAsDataURL gives "data:image/jpeg;base64,AAAA…"; we keep the part after the comma.
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Opens the receipt viewer for one entry. The photo comes from, in order:
 * the entry itself (not uploaded yet), the in-memory cache, or the server.
 * The server only returns it to the entry's owner.
 */
async function viewReceipt(id) {
  const expense = findExpense(id);
  if (!expense) return;
  const dialog = $('receipt-dialog');
  const img = $('receipt-image');
  const status = $('receipt-status');
  dialog.dataset.id = id;
  img.hidden = true;
  img.removeAttribute('src');
  status.textContent = 'Loading receipt…';
  status.hidden = false;
  dialog.showModal();

  try {
    let src = state.receiptCache.get(id);
    if (expense.receipt) {
      src = 'data:image/jpeg;base64,' + expense.receipt.data;
    } else if (!src) {
      const result = await callApi('getReceipt', { id });
      src = 'data:image/jpeg;base64,' + result.data;
      state.receiptCache.set(id, src);
    }
    // The user may have closed the viewer, or opened another receipt, meanwhile.
    if (!dialog.open || dialog.dataset.id !== id) return;
    img.src = src;
    img.hidden = false;
    status.hidden = true;
  } catch (err) {
    if (dialog.dataset.id === id) status.textContent = 'Could not load the receipt: ' + err.message;
  }
}

// ---------------------------------------------------------------------------
// Delete my data
// ---------------------------------------------------------------------------

/** Opens the "Delete my data" confirmation, empty and with the button off. */
function openDeleteDialog() {
  $('delete-confirm-input').value = '';
  $('delete-confirm').disabled = true;
  $('delete-confirm').textContent = 'Delete all';
  $('delete-error').hidden = true;
  $('delete-dialog').showModal();
  $('delete-confirm-input').focus();
}

/**
 * Asks the server to remove all of the user's rows and receipt files, then
 * clears this device and signs out. Waits for saves in progress first:
 * otherwise a save could land just after the delete and leave a row behind.
 */
async function deleteMyData() {
  const errorBox = $('delete-error');
  const button = $('delete-confirm');
  if (state.expenses.some((e) => e.status === 'saving')) {
    errorBox.textContent = 'Some entries are still saving. Wait a few seconds and try again.';
    errorBox.hidden = false;
    return;
  }

  button.disabled = true;
  button.textContent = 'Deleting…';
  errorBox.hidden = true;
  try {
    const result = await callApi('deleteMyData');
    clearUserData();
    showSignIn('Your data was deleted: ' + plural(result.deletedRows, 'entry', 'entries') +
               ' and ' + plural(result.deletedReceipts, 'receipt photo', 'receipt photos') + '.');
  } catch (err) {
    errorBox.textContent = 'Could not delete your data: ' + err.message;
    errorBox.hidden = false;
    button.disabled = false;
    button.textContent = 'Delete all';
  }
}

// ---------------------------------------------------------------------------
// Screens, messages and small helpers
// ---------------------------------------------------------------------------

/** Shows the sign-in screen, optionally with a message (red if isError). */
function showSignIn(message = '', isError = false) {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
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
  sortExpenses();
  renderAll();
  showScreen(state.screen);
  loadExpenses();
  // Entries that failed only because the sign-in had expired: retry them now.
  for (const e of state.expenses) {
    if (e.status === 'failed' && e.errorCode === 'AUTH') saveExpense(e.id);
  }
}

/** Shows one screen ('add', 'history', 'summary', 'settings') and highlights its tab. */
function showScreen(name) {
  state.screen = name;
  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.id !== 'screen-' + name;
  }
  for (const tab of document.querySelectorAll('.tabbar button')) {
    if (tab.dataset.screen === name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
}

/** Shows a status line at the top of the app; an empty message hides it. */
function setStatus(message, isError = false) {
  const box = $('status');
  box.textContent = message;
  box.hidden = !message;
  box.classList.toggle('error', isError);
}

/** Shows a short pop-up message for a few seconds (longer for errors). */
function showToast(message, isError = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.hidden = false;
  clearTimeout(showToast.timer); // a function can hold a value, like an object
  showToast.timer = setTimeout(() => { toast.hidden = true; }, isError ? 5000 : 2500);
}

/** Makes an element with a class and (optional) text, safely via textContent. */
function createElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Makes a button that handleHistoryClick() will recognise. */
function createButton(text, action, id, className) {
  const button = createElement('button', className, text);
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = id;
  return button;
}

/**
 * A random, unique id for a new entry, like "3f2b9c1e-...".
 * crypto.randomUUID() only exists on secure pages (https or localhost);
 * the fallback builds 16 random bytes as hex, which is just as unique.
 */
function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** plural(1, 'entry', 'entries') → "1 entry"; plural(3, ...) → "3 entries". */
function plural(count, one, many) {
  return count + ' ' + (count === 1 ? one : many);
}

/** "5" → "05", for building dates. */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Today's date as yyyy-mm-dd in the phone's own time zone.
 * (new Date().toISOString() would give UTC, which in Malaysia is the wrong
 * day until 8 am.)
 */
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** This month as yyyy-mm. */
function currentMonth() {
  return today().slice(0, 7);
}

/** "2026-11-21" → "Sat, 21 Nov 2026". Built from parts so it stays in local time. */
function formatDay(dateText) {
  const [y, m, d] = dateText.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-MY', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

/** "2026-11" → "November 2026". */
function formatMonth(monthText) {
  const [y, m] = monthText.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
}

start();
