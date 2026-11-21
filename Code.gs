/**
 * Budget Tracker — backend (Google Apps Script)
 * ==============================================
 *
 * This file is pasted into the Apps Script editor attached to the
 * "Budget App DB" Google Sheet (Extensions → Apps Script). It is deployed as a
 * web app with "Execute as: Me" and "Who has access: Anyone".
 *
 * HOW A REQUEST WORKS
 *   1. The app sends a POST whose body is JSON text: {action, idToken, ...}.
 *      (Content-Type is text/plain so the browser skips the CORS "preflight"
 *      check, which Apps Script cannot answer.)
 *   2. doPost() checks the Google ID token, which tells us who the user is.
 *   3. Only then does it run the action, and every action only touches rows
 *      whose email column matches the signed-in user.
 *   4. The answer is always JSON: {ok: true, ...} or {ok: false, code, error}.
 *
 * NAMING: functions ending in "_" are private. Apps Script hides them from the
 * editor's Run menu and they cannot be called from outside. Only setup(),
 * doGet() and doPost() are "public".
 *
 * SCRIPT PROPERTIES (Project Settings → Script properties)
 *   CLIENT_ID      — you add this by hand: your Google Sign-In Client ID.
 *   ALLOWED_EMAILS — optional. Leave it out and anyone with a Google account
 *                    can use the app. Set it to a list of emails separated by
 *                    commas to make the app invite-only.
 *   SPREADSHEET_ID — written by setup().
 *   FOLDER_ID      — written by setup() (the "Budget App Receipts" folder).
 *   usage:...      — written automatically: today's counts for the daily limits.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SHEET_NAME = 'Expenses';
const FOLDER_NAME = 'Budget App Receipts';

// Column order in the sheet. Change it here and nowhere else.
const HEADERS = ['id', 'email', 'date', 'amount', 'category', 'note',
                 'receiptFileId', 'createdAt', 'deleted'];

// COL.amount === 3, etc., so code reads row[COL.amount] instead of row[3].
const COL = {};
HEADERS.forEach(function (name, index) { COL[name] = index; });

// Number formats per column: '@' means plain text, so Sheets never turns
// "2026-11-21" into a date or "007" into 7.
const COLUMN_FORMATS = ['@', '@', '@', '0.00', '@', '@', '@', '@', 'General'];

const CATEGORIES = ['Food', 'Transport', 'Bills', 'Shopping', 'Health',
                    'Entertainment', 'Other'];
const MAX_AMOUNT = 1000000;
const MAX_NOTE_LENGTH = 200;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024; // 2 MB; a 1280px JPEG is ~150 KB
const LOCK_WAIT_MS = 10000;                 // wait up to 10 s for other saves

// Daily limits, so no one (by mistake or on purpose) can fill your Drive or
// use up Google's free quotas. Counts reset at midnight in the script's time
// zone (Project Settings → Time zone). Normal use is far below these.
const MAX_ADDS_PER_USER_PER_DAY = 200;
const MAX_RECEIPTS_PER_USER_PER_DAY = 50;
const MAX_ADDS_ALL_USERS_PER_DAY = 5000;
const MAX_RECEIPTS_ALL_USERS_PER_DAY = 1000; // at most ~2 GB a day, usually ~150 MB

// ---------------------------------------------------------------------------
// One-time setup (run by hand from the editor)
// ---------------------------------------------------------------------------

/**
 * Creates the "Expenses" tab with its header row and column formats, creates
 * (or finds) the private "Budget App Receipts" Drive folder, and stores both
 * IDs in Script Properties.
 *
 * Why store IDs: the web app runs without an "active" spreadsheet in some
 * contexts, and a folder found by name could be confused with another folder
 * of the same name. IDs are exact. Safe to run more than once.
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Open this script from your Sheet (Extensions → Apps Script) and run setup() there.');
  }

  // 1. The Expenses tab and its headers.
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  // Apply the format to every row of each column, so new rows inherit it.
  COLUMN_FORMATS.forEach(function (format, i) {
    sheet.getRange(1, i + 1, sheet.getMaxRows(), 1).setNumberFormat(format);
  });

  // 2. The receipts folder. Reuse the one we made before if it still exists.
  let folder = null;
  const savedFolderId = props.getProperty('FOLDER_ID');
  if (savedFolderId) {
    try {
      folder = DriveApp.getFolderById(savedFolderId);
      if (folder.isTrashed()) folder = null;
    } catch (e) {
      folder = null; // deleted or no longer accessible
    }
  }
  if (!folder) {
    const existing = DriveApp.getFoldersByName(FOLDER_NAME);
    folder = existing.hasNext() ? existing.next() : DriveApp.createFolder(FOLDER_NAME);
  }

  // 3. Remember both IDs.
  props.setProperties({ SPREADSHEET_ID: ss.getId(), FOLDER_ID: folder.getId() });

  Logger.log('Setup done. Sheet tab: "%s". Receipts folder: %s', SHEET_NAME, folder.getUrl());
  if (!props.getProperty('CLIENT_ID')) {
    Logger.log('WARNING: Script property CLIENT_ID is not set yet. Add it under Project Settings → Script properties.');
  }
}

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

/**
 * Answers GET requests (e.g. opening the /exec URL in a browser).
 * The app never uses GET; this only lets you check the deployment is live.
 */
function doGet() {
  return ContentService.createTextOutput(
    'Budget Tracker API is running. The app talks to it with POST requests.');
}

/**
 * Answers every request from the app.
 * Order matters: parse → verify who is asking → run the action → reply JSON.
 * Any error becomes {ok: false, code, error} so the app can always read it.
 */
function doPost(e) {
  let result;
  try {
    const request = parseRequest_(e);
    const email = verifyIdToken_(request.idToken);
    // Anyone may always delete their own data, even after losing access.
    if (request.action !== 'deleteMyData') checkAllowed_(email);
    result = handleAction_(request, email);
    result.ok = true;
  } catch (err) {
    result = errorToJson_(err);
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Sends the request to the matching action. Unknown actions are rejected.
 * `email` is the verified user; actions trust only this, never the body.
 */
function handleAction_(request, email) {
  switch (request.action) {
    case 'list':         return listExpenses_(email);
    case 'add':          return addExpense_(request.expense, email);
    case 'delete':       return deleteExpense_(request.id, email);
    case 'getReceipt':   return getReceipt_(request.id, email);
    case 'deleteMyData': return deleteMyData_(email);
    default:
      throw new ApiError('BAD_REQUEST', 'Unknown action: ' + String(request.action));
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * An error we expect and can explain to the user, with a short code the app
 * can react to:
 *   AUTH        — sign in again
 *   FORBIDDEN   — signed in, but not on the ALLOWED_EMAILS list
 *   LIMIT       — a daily limit was reached
 *   BAD_REQUEST — the input was wrong (message says what)
 *   NOT_FOUND   — no such entry for this user
 *   BUSY        — another save held the lock too long; try again
 *   SERVER      — the server is misconfigured or failed
 */
class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/**
 * Turns any thrown error into the JSON reply. Unexpected errors are logged
 * (View → Executions in the editor) but the user only sees a generic message,
 * so internal details never leak.
 */
function errorToJson_(err) {
  if (err instanceof ApiError) {
    return { ok: false, code: err.code, error: err.message };
  }
  console.error(err && err.stack ? err.stack : err);
  return { ok: false, code: 'SERVER', error: 'Something went wrong on the server. Please try again.' };
}

// ---------------------------------------------------------------------------
// Request parsing and sign-in check
// ---------------------------------------------------------------------------

/** Reads the POST body as JSON. Rejects empty or non-JSON bodies. */
function parseRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new ApiError('BAD_REQUEST', 'Empty request.');
  }
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    throw new ApiError('BAD_REQUEST', 'Request body is not valid JSON.');
  }
  if (!body || typeof body !== 'object') {
    throw new ApiError('BAD_REQUEST', 'Request body must be a JSON object.');
  }
  return body;
}

/**
 * Proves who the user is and returns their email (lower case).
 *
 * The ID token comes from Google Sign-In in the browser. We ask Google's
 * tokeninfo endpoint whether it is genuine, then check:
 *   - aud   === our CLIENT_ID (the token was made for THIS app, not another)
 *   - iss   is Google
 *   - email_verified is true
 *   - exp   is in the future
 *
 * Calling Google takes ~0.5 s, so a verified token is cached (by its SHA-256
 * hash, never the token itself) until it expires. Later requests skip the call.
 */
function verifyIdToken_(idToken) {
  if (typeof idToken !== 'string' || idToken.length < 100 || idToken.length > 4096) {
    throw new ApiError('AUTH', 'Please sign in.');
  }
  const clientId = PropertiesService.getScriptProperties().getProperty('CLIENT_ID');
  if (!clientId) {
    throw new ApiError('SERVER', 'Server not configured: add the CLIENT_ID script property.');
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = 'tok_' + sha256_(idToken);
  const cachedEmail = cache.get(cacheKey);
  if (cachedEmail) return cachedEmail;

  const response = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    // Google says the token is invalid or expired.
    throw new ApiError('AUTH', 'Your sign-in has expired. Please sign in again.');
  }

  const info = JSON.parse(response.getContentText());
  const now = Math.floor(Date.now() / 1000);
  const exp = Number(info.exp);

  if (info.aud !== clientId) {
    throw new ApiError('AUTH', 'This sign-in was not made for this app.');
  }
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') {
    throw new ApiError('AUTH', 'This sign-in was not issued by Google.');
  }
  if (String(info.email_verified) !== 'true' || !info.email) {
    throw new ApiError('AUTH', 'Your Google email address is not verified.');
  }
  if (!(exp > now)) {
    throw new ApiError('AUTH', 'Your sign-in has expired. Please sign in again.');
  }

  const email = String(info.email).toLowerCase();
  // Cache for the token's remaining life (CacheService allows at most 6 hours).
  cache.put(cacheKey, email, Math.min(exp - now, 21600));
  return email;
}

/**
 * If the ALLOWED_EMAILS script property is set, only those emails may use the
 * app. If it is empty or missing, everyone may (the limits still apply).
 */
function checkAllowed_(email) {
  const list = PropertiesService.getScriptProperties().getProperty('ALLOWED_EMAILS');
  if (!list || !list.trim()) return;
  const allowed = list.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (allowed.indexOf(email) === -1) {
    throw new ApiError('FORBIDDEN', 'This app is invite-only for now. Ask the developer for access.');
  }
}

/** Returns the SHA-256 hash of a string as base64 (a short, safe cache key). */
function sha256_(text) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * action "list": returns all of the user's entries that are not deleted,
 * newest date first. Reading needs no lock: it never changes anything.
 */
function listExpenses_(email) {
  const rows = readAllRows_(getSheet_());
  const expenses = rows
    .filter(function (row) { return isOwner_(row, email) && !isDeleted_(row); })
    .map(rowToExpense_);
  expenses.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  return { expenses: expenses };
}

/**
 * action "add": validates and saves one expense, plus an optional receipt.
 *
 * The app makes the id itself (so it can show the entry before the server
 * answers). If the same id arrives twice, e.g. a retry after a dropped
 * connection, we return the saved entry instead of making a duplicate.
 *
 * Why the order below: uploading a photo to Drive is the slow part (~1 s).
 * If we did it while holding the lock, every other user's save would wait
 * for it. So we check first, upload WITHOUT the lock, and only take the lock
 * for the quick part: re-checking and writing the row.
 */
function addExpense_(input, email) {
  const expense = validateExpense_(input);
  const receiptBlob = input.receipt ? decodeReceipt_(input.receipt, expense.id) : null;
  const hasReceipt = Boolean(receiptBlob);
  const sheet = getSheet_();

  // 1. Quick checks before uploading anything, so we never upload for nothing.
  const existing = findRowById_(readAllRows_(sheet), expense.id);
  if (existing) return duplicateResult_(existing, email);
  checkLimits_(email, hasReceipt);

  // 2. The slow part, outside the lock.
  const receiptFileId = hasReceipt ? getReceiptFolder_().createFile(receiptBlob).getId() : '';

  try {
    return withLock_(function () {
      // 3. Check again: another request may have saved this id or used up a
      //    limit while we were uploading. Only now is the answer certain.
      const found = findRowById_(readAllRows_(sheet), expense.id);
      if (found) {
        trashFile_(receiptFileId);
        return duplicateResult_(found, email);
      }
      checkLimits_(email, hasReceipt);
      const saved = writeExpenseRow_(sheet, expense, email, receiptFileId);
      recordUsage_(email, hasReceipt);
      return { expense: saved };
    });
  } catch (err) {
    // Don't leave an orphan photo in Drive if the row was not saved.
    trashFile_(receiptFileId);
    throw err;
  }
}

/** Finds the row with this id. Returns the row, or null. */
function findRowById_(rows, id) {
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][COL.id]) === id) return rows[i];
  }
  return null;
}

/**
 * The answer when an id already exists: the saved entry if it is the user's
 * own (a retry), or an error if it belongs to someone else.
 */
function duplicateResult_(row, email) {
  if (!isOwner_(row, email)) throw new ApiError('BAD_REQUEST', 'That id is already in use.');
  return { expense: rowToExpense_(row), duplicate: true };
}

/**
 * Appends one expense as a new row and returns it as the app expects.
 * Must be called while holding the lock (see withLock_).
 */
function writeExpenseRow_(sheet, expense, email, receiptFileId) {
  const row = [];
  row[COL.id] = expense.id;
  row[COL.email] = email;
  row[COL.date] = expense.date;
  row[COL.amount] = expense.amount;
  row[COL.category] = expense.category;
  row[COL.note] = safeText_(expense.note);
  row[COL.receiptFileId] = receiptFileId;
  row[COL.createdAt] = new Date().toISOString();
  row[COL.deleted] = false;

  const range = sheet.getRange(sheet.getLastRow() + 1, 1, 1, HEADERS.length);
  range.setNumberFormats([COLUMN_FORMATS]); // set text format BEFORE writing
  range.setValues([row]);
  return rowToExpense_(row);
}

/**
 * action "delete": removes the entry's row for real and moves its receipt
 * photo to Drive's trash. When a user deletes something, they expect it gone.
 * (Older versions only marked rows deleted = TRUE; run purgeDeletedRows()
 * once to clean those up.) The photo is trashed after the lock is released,
 * so other users' saves don't wait for Drive.
 */
function deleteExpense_(id, email) {
  const cleanId = validateId_(id);
  const sheet = getSheet_();
  const receiptFileId = withLock_(function () {
    const rows = readAllRows_(sheet);
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][COL.id]) === cleanId && isOwner_(rows[i], email) && !isDeleted_(rows[i])) {
        // +2: one for the header row, one because sheet rows start at 1.
        sheet.deleteRow(i + 2);
        return String(rows[i][COL.receiptFileId] || '');
      }
    }
    throw new ApiError('NOT_FOUND', 'That entry was not found.');
  });
  trashFile_(receiptFileId);
  return { id: cleanId };
}

/**
 * action "getReceipt": returns the receipt photo as base64, but only if the
 * entry belongs to the signed-in user. The Drive file itself stays private;
 * the app never gets a Drive link.
 */
function getReceipt_(id, email) {
  const cleanId = validateId_(id);
  const rows = readAllRows_(getSheet_());
  const row = rows.find(function (r) {
    return String(r[COL.id]) === cleanId && isOwner_(r, email) && !isDeleted_(r);
  });
  if (!row || !row[COL.receiptFileId]) {
    throw new ApiError('NOT_FOUND', 'No receipt for that entry.');
  }
  let blob;
  try {
    blob = DriveApp.getFileById(String(row[COL.receiptFileId])).getBlob();
  } catch (err) {
    throw new ApiError('NOT_FOUND', 'The receipt file is missing.');
  }
  return { id: cleanId, mimeType: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

/**
 * action "deleteMyData": removes ALL of the user's rows (including soft-deleted
 * ones) and moves their receipt files to Drive's trash (Drive empties trash
 * after 30 days). Rows are deleted bottom-up so row numbers above stay valid.
 */
function deleteMyData_(email) {
  const removed = removeRows_(function (row) { return isOwner_(row, email); });
  return { deletedRows: removed.rows, deletedReceipts: trashFiles_(removed.fileIds) };
}

/**
 * Run this ONCE by hand from the editor (choose purgeDeletedRows, click Run)
 * to clean up rows that older versions only marked deleted = TRUE: removes
 * those rows and trashes their receipt photos. Safe to run again any time.
 */
function purgeDeletedRows() {
  const removed = removeRows_(isDeleted_);
  const trashed = trashFiles_(removed.fileIds);
  Logger.log('Removed %s old deleted rows and trashed %s receipt photos.', removed.rows, trashed);
}

/**
 * Deletes every row for which shouldRemove(row) is true, and returns how many
 * rows went plus the receipt file ids they pointed to (for the caller to
 * trash AFTER the lock is released, since Drive is slow).
 * Rows are deleted bottom-up so the row numbers above stay valid, with
 * neighbouring rows grouped into one call.
 */
function removeRows_(shouldRemove) {
  const sheet = getSheet_();
  return withLock_(function () {
    const rows = readAllRows_(sheet);
    const rowNumbers = [];
    const fileIds = [];
    rows.forEach(function (row, i) {
      if (shouldRemove(row)) {
        rowNumbers.push(i + 2);
        if (row[COL.receiptFileId]) fileIds.push(String(row[COL.receiptFileId]));
      }
    });

    let i = rowNumbers.length - 1;
    while (i >= 0) {
      let start = rowNumbers[i];
      let count = 1;
      while (i - count >= 0 && rowNumbers[i - count] === start - 1) {
        start--;
        count++;
      }
      sheet.deleteRows(start, count);
      i -= count;
    }
    return { rows: rowNumbers.length, fileIds: fileIds };
  });
}

/** Trashes a list of Drive files and returns how many it managed to trash. */
function trashFiles_(fileIds) {
  return fileIds.filter(trashFile_).length;
}

/**
 * Moves one Drive file to the trash (Drive deletes it for good after 30
 * days). Does nothing for an empty id. Returns true if it worked.
 */
function trashFile_(fileId) {
  if (!fileId) return false;
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
    return true;
  } catch (err) {
    console.warn('Could not trash receipt ' + fileId + ': ' + err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Daily limits
// ---------------------------------------------------------------------------

/**
 * Throws a LIMIT error if this save would go over a daily limit, for this
 * user or for everyone together. Counts live in Script Properties as
 * {day, adds, receipts}: one entry per user (keyed by a hash of their email)
 * plus one for everyone. A new day simply starts again from zero.
 */
function checkLimits_(email, withReceipt) {
  const mine = readUsage_(userUsageKey_(email));
  const everyone = readUsage_('usage:all');
  if (mine.adds >= MAX_ADDS_PER_USER_PER_DAY) {
    throw new ApiError('LIMIT', "You've reached today's limit of " + MAX_ADDS_PER_USER_PER_DAY +
      ' entries. Please try again tomorrow.');
  }
  if (everyone.adds >= MAX_ADDS_ALL_USERS_PER_DAY) {
    throw new ApiError('LIMIT', 'The app is very busy today. Please try again tomorrow.');
  }
  if (withReceipt && mine.receipts >= MAX_RECEIPTS_PER_USER_PER_DAY) {
    throw new ApiError('LIMIT', "You've reached today's limit of " + MAX_RECEIPTS_PER_USER_PER_DAY +
      ' receipt photos. Remove the photo to save this entry.');
  }
  if (withReceipt && everyone.receipts >= MAX_RECEIPTS_ALL_USERS_PER_DAY) {
    throw new ApiError('LIMIT', "The app has reached today's limit for receipt photos. " +
      'Remove the photo to save this entry.');
  }
}

/** Adds one save (and maybe one photo) to today's counts. Call inside the lock. */
function recordUsage_(email, withReceipt) {
  const updates = {};
  [userUsageKey_(email), 'usage:all'].forEach(function (key) {
    const usage = readUsage_(key);
    usage.adds++;
    if (withReceipt) usage.receipts++;
    updates[key] = JSON.stringify(usage);
  });
  PropertiesService.getScriptProperties().setProperties(updates);
}

/** Today's counts for one key, or zeros if there are none yet for today. */
function readUsage_(key) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  try {
    const usage = JSON.parse(PropertiesService.getScriptProperties().getProperty(key));
    if (usage && usage.day === today) return usage;
  } catch (err) {
    // missing or damaged: start from zero
  }
  return { day: today, adds: 0, receipts: 0 };
}

/** The Script Properties key for one user's counts (a hash keeps it short). */
function userUsageKey_(email) {
  return 'usage:' + sha256_(email);
}

// ---------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------

/**
 * Checks every field of a new expense and returns a clean copy.
 * Never trust the browser: anyone can send any JSON to the /exec URL.
 */
function validateExpense_(input) {
  if (!input || typeof input !== 'object') {
    throw new ApiError('BAD_REQUEST', 'Missing expense.');
  }

  const id = validateId_(input.id);

  const amount = Math.round(Number(input.amount) * 100) / 100; // 2 decimals
  if (typeof input.amount === 'boolean' || !isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new ApiError('BAD_REQUEST', 'Amount must be a number above 0 and at most 1,000,000.');
  }

  if (CATEGORIES.indexOf(input.category) === -1) {
    throw new ApiError('BAD_REQUEST', 'Category must be one of: ' + CATEGORIES.join(', ') + '.');
  }

  if (!isValidDate_(input.date)) {
    throw new ApiError('BAD_REQUEST', 'Date must be a real date in the form yyyy-mm-dd.');
  }

  let note = input.note == null ? '' : input.note;
  if (typeof note !== 'string') {
    throw new ApiError('BAD_REQUEST', 'Note must be text.');
  }
  note = note.replace(/[\u0000-\u001F\u007F]/g, ' ').trim(); // no control characters
  if (note.length > MAX_NOTE_LENGTH) {
    throw new ApiError('BAD_REQUEST', 'Note must be ' + MAX_NOTE_LENGTH + ' characters or fewer.');
  }

  return { id: id, amount: amount, category: input.category, date: input.date, note: note };
}

/** Ids are made by the app (a UUID). Allow only letters, digits, - and _. */
function validateId_(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    throw new ApiError('BAD_REQUEST', 'Invalid id.');
  }
  return id;
}

/**
 * True for a real calendar date in yyyy-mm-dd form. The regex checks the
 * shape; building a Date and reading it back rejects things like 2026-02-30.
 */
function isValidDate_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return d.getUTCFullYear() === parts[0] && d.getUTCMonth() === parts[1] - 1 &&
         d.getUTCDate() === parts[2] && parts[0] >= 2000 && parts[0] <= 2100;
}

/**
 * Checks a receipt sent as {mimeType: 'image/jpeg', data: base64} and turns it
 * into a file "blob". The app always compresses to JPEG, so anything else is
 * refused. The first two bytes of every JPEG are FF D8 (stored as -1, -40,
 * because Apps Script bytes are signed); this stops other files posing as one.
 */
function decodeReceipt_(receipt, id) {
  if (typeof receipt !== 'object' || receipt.mimeType !== 'image/jpeg' || typeof receipt.data !== 'string') {
    throw new ApiError('BAD_REQUEST', 'Receipt must be a JPEG image.');
  }
  const base64 = receipt.data.replace(/^data:image\/jpeg;base64,/, '');
  if (base64.length > Math.ceil(MAX_RECEIPT_BYTES / 3) * 4) {
    throw new ApiError('BAD_REQUEST', 'Receipt image is too large (max 2 MB).');
  }
  let bytes;
  try {
    bytes = Utilities.base64Decode(base64);
  } catch (err) {
    throw new ApiError('BAD_REQUEST', 'Receipt image data is damaged.');
  }
  if (bytes.length < 4 || bytes[0] !== -1 || bytes[1] !== -40) {
    throw new ApiError('BAD_REQUEST', 'Receipt must be a JPEG image.');
  }
  return Utilities.newBlob(bytes, 'image/jpeg', id + '.jpg');
}

/**
 * Stops "formula injection": text starting with = + - or @ would be run as a
 * formula by Sheets (e.g. a note "=IMPORTXML(...)"). A leading apostrophe
 * tells Sheets "this is plain text"; it is hidden and not returned on read.
 */
function safeText_(text) {
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

// ---------------------------------------------------------------------------
// Sheet and Drive helpers
// ---------------------------------------------------------------------------

/** Opens the Expenses tab using the ID saved by setup(). */
function getSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new ApiError('SERVER', 'Server not set up: run setup() in the Apps Script editor.');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(SHEET_NAME);
  if (!sheet) throw new ApiError('SERVER', 'The "' + SHEET_NAME + '" tab is missing: run setup() again.');
  return sheet;
}

/** Opens the private receipts folder using the ID saved by setup(). */
function getReceiptFolder_() {
  const id = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (!id) throw new ApiError('SERVER', 'Server not set up: run setup() in the Apps Script editor.');
  return DriveApp.getFolderById(id);
}

/** Returns every data row (not the header) as an array of arrays. */
function readAllRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
}

/** True if this row belongs to the signed-in user. The core privacy check. */
function isOwner_(row, email) {
  return String(row[COL.email]).trim().toLowerCase() === email;
}

/** True if the row was soft-deleted (TRUE checkbox, or the text "true"). */
function isDeleted_(row) {
  return row[COL.deleted] === true || String(row[COL.deleted]).toLowerCase() === 'true';
}

/**
 * Turns a sheet row into the object the app receives. The owner's email and
 * the Drive file id are left out: the app only needs to know a receipt exists.
 */
function rowToExpense_(row) {
  return {
    id: String(row[COL.id]),
    date: toDateText_(row[COL.date]),
    amount: Number(row[COL.amount]),
    category: String(row[COL.category]),
    note: String(row[COL.note] || ''),
    hasReceipt: Boolean(row[COL.receiptFileId]),
    createdAt: row[COL.createdAt] instanceof Date ? row[COL.createdAt].toISOString() : String(row[COL.createdAt]),
  };
}

/**
 * Dates are stored as text, but if someone types a row by hand Sheets may
 * turn it into a real date. This turns it back into yyyy-mm-dd either way.
 */
function toDateText_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value);
}

/**
 * Runs fn() while holding the script-wide lock, so two saves can never write
 * at the same moment (e.g. both picking the same "next empty row").
 * flush() makes sure the writes are finished before the next request reads.
 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    throw new ApiError('BUSY', 'The server is busy. Please try again in a moment.');
  }
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}
