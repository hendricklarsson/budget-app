// crypto.js — Sen Tracker's encryption ("the vault").
//
// The idea in one paragraph: every user has one random secret key (the
// "data key"). It scrambles each entry (amount, category, date, time, note)
// and each receipt photo on the phone, before anything is sent. The server
// and the Sheet only ever see the scrambled result. The data key itself is
// stored on the server too, but locked inside a "key box" that only the
// user's passphrase or their recovery code can open. Neither ever leaves the
// phone, so the developer can't open the box.
//
// Everything here uses the browser's built-in Web Crypto API
// (crypto.subtle), not home-made maths:
//   AES-GCM (256-bit)   scrambles entries, photos and the data key. It also
//                       detects tampering: a changed byte fails to open.
//   PBKDF2 (SHA-256)    turns a passphrase into a key. It is deliberately
//                       slow (600,000 rounds) so guessing passphrases is slow.
//   getRandomValues     makes keys, recovery codes and the random "salt" and
//                       "iv" values that make every result different.
//
// "Remember on This Device" keeps the data key in IndexedDB (the browser's
// database for this site) as a non-extractable key: the app can use it, but
// even code running on this page can't read its bytes out.

'use strict';

const SenVault = (() => {
  const VERSION = 1;
  const PASS_ROUNDS = 600000;  // OWASP's 2023 advice for PBKDF2-SHA256
  const CODE_ROUNDS = 100000;  // the code is already random and long (111 bits)
  const MIN_PASSPHRASE = 12;
  // The recovery code avoids characters people mix up: 0 O, 1 I L, 5 S, 2 Z, 8 B.
  const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
  const CODE_LENGTH = 24;      // shown as six groups of four
  const DB_NAME = 'sen-vault';
  const STORE = 'keys';

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const subtle = () => {
    if (!window.crypto || !crypto.subtle) {
      throw new Error('This browser can\'t encrypt. Open the app over https in an up-to-date browser.');
    }
    return crypto.subtle;
  };

  /** A wrong passphrase or code: the box didn't open. */
  class WrongSecretError extends Error {
    constructor(message) { super(message); this.name = 'WrongSecretError'; }
  }

  // ---------------------------------------------------------------------
  // Small helpers: bytes <-> base64, random bytes
  // ---------------------------------------------------------------------

  /** Bytes → base64 text, in chunks so big photos don't overflow the stack. */
  function toBase64(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  }

  /** Base64 text → bytes. */
  function fromBase64(text) {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  /** n random bytes from the browser's secure random generator. */
  function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  /** A short random id for the data key (so the server can tell keys apart). */
  function makeKeyId() {
    return Array.from(randomBytes(12), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ---------------------------------------------------------------------
  // AES-GCM: the scrambling itself
  // ---------------------------------------------------------------------
  //
  // Output layout: [version 1 byte][iv 12 bytes][ciphertext + 16-byte tag].
  // The "label" (additional data) ties a result to its purpose and entry id,
  // so a scrambled entry can't be swapped onto another entry unnoticed.

  async function seal(key, bytes, label) {
    const iv = randomBytes(12);
    const sealed = new Uint8Array(await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, bytes));
    const out = new Uint8Array(1 + iv.length + sealed.length);
    out[0] = VERSION;
    out.set(iv, 1);
    out.set(sealed, 1 + iv.length);
    return out;
  }

  async function open(key, bytes, label) {
    if (bytes[0] !== VERSION) throw new Error('This data was made by a newer version of the app.');
    const iv = bytes.subarray(1, 13);
    const sealed = bytes.subarray(13);
    return new Uint8Array(await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, sealed));
  }

  /** Imports 32 raw bytes as an AES-GCM key. */
  function importDataKey(raw, extractable) {
    return subtle().importKey('raw', raw, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
  }

  // ---------------------------------------------------------------------
  // The key box: the data key, locked with the passphrase and the code
  // ---------------------------------------------------------------------

  /** Turns a secret (passphrase or code) into a key, slowly, with PBKDF2. */
  async function stretch(secret, salt, rounds) {
    const base = await subtle().importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /** Locks the raw data key with one secret. Returns one half of the box. */
  async function lockWith(raw, keyId, secret, rounds) {
    const salt = randomBytes(16);
    const lockKey = await stretch(secret, salt, rounds);
    const sealed = await seal(lockKey, raw, 'sen:key:' + keyId);
    return { salt: toBase64(salt), rounds, sealed: toBase64(sealed) };
  }

  /** Opens one half of the box with a secret. Throws WrongSecretError if it's wrong. */
  async function unlockWith(part, keyId, secret, wrongMessage) {
    const lockKey = await stretch(secret, fromBase64(part.salt), part.rounds);
    try {
      return await open(lockKey, fromBase64(part.sealed), 'sen:key:' + keyId);
    } catch (err) {
      throw new WrongSecretError(wrongMessage);
    }
  }

  /** Passphrases are compared exactly, after making accented letters consistent. */
  function cleanPassphrase(text) {
    return String(text).normalize('NFC');
  }

  /**
   * Makes a brand-new vault for first setup: a random data key, a recovery
   * code, and the key box locked with both. Returns
   * {key, raw, keyId, code, box}; box is the JSON text the server stores.
   */
  async function create(passphrase) {
    const raw = randomBytes(32);
    const keyId = makeKeyId();
    const code = makeRecoveryCode();
    const box = await buildBox(raw, keyId, passphrase, code);
    return { key: await importDataKey(raw, false), raw, keyId, code, box };
  }

  /** Builds the key box text from the raw key, its id, a passphrase and a code. */
  async function buildBox(raw, keyId, passphrase, code) {
    const [pass, codePart] = await Promise.all([
      lockWith(raw, keyId, cleanPassphrase(passphrase), PASS_ROUNDS),
      lockWith(raw, keyId, cleanCode(code), CODE_ROUNDS),
    ]);
    return JSON.stringify({ v: VERSION, keyId, pass, code: codePart });
  }

  /** The same box with a new passphrase (the code half is kept as it is). */
  async function withNewPassphrase(boxText, raw, passphrase) {
    const box = JSON.parse(boxText);
    box.pass = await lockWith(raw, box.keyId, cleanPassphrase(passphrase), PASS_ROUNDS);
    return JSON.stringify(box);
  }

  /** The same box with a new recovery code (the old code stops working). */
  async function withNewCode(boxText, raw, code) {
    const box = JSON.parse(boxText);
    box.code = await lockWith(raw, box.keyId, cleanCode(code), CODE_ROUNDS);
    return JSON.stringify(box);
  }

  /** Opens the box with the passphrase: {key, raw, keyId}. */
  async function openWithPassphrase(boxText, passphrase) {
    const box = JSON.parse(boxText);
    const raw = await unlockWith(box.pass, box.keyId, cleanPassphrase(passphrase),
      "That passphrase isn't right. Check for typos, or use your recovery code.");
    return { key: await importDataKey(raw, false), raw, keyId: box.keyId };
  }

  /** Opens the box with the recovery code: {key, raw, keyId}. */
  async function openWithCode(boxText, code) {
    const box = JSON.parse(boxText);
    const raw = await unlockWith(box.code, box.keyId, cleanCode(code),
      "This code doesn't match. Check each group of 4 against your saved copy.");
    return { key: await importDataKey(raw, false), raw, keyId: box.keyId };
  }

  /** The key id inside a box (to check a remembered key still fits). */
  function boxKeyId(boxText) {
    try { return JSON.parse(boxText).keyId; } catch (err) { return null; }
  }

  // ---------------------------------------------------------------------
  // Recovery codes
  // ---------------------------------------------------------------------

  /** 24 random characters from CODE_ALPHABET, with no bias towards any. */
  function makeRecoveryCode() {
    let code = '';
    while (code.length < CODE_LENGTH) {
      for (const b of randomBytes(32)) {
        // 250 = 10 × 25: drop 250–255 so every character is equally likely.
        if (b < 250 && code.length < CODE_LENGTH) code += CODE_ALPHABET[b % 25];
      }
    }
    return code;
  }

  /** "k7qm 4xpf-…" → "K7QM4XPF…": case, spaces and dashes don't matter. */
  function cleanCode(text) {
    return String(text).toUpperCase().replace(/[\s-]/g, '');
  }

  /** True if the text could be a recovery code (right length and characters). */
  function looksLikeCode(text) {
    const code = cleanCode(text);
    return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
  }

  /** "K7QM4XPF…" → ["K7QM", "4XPF", …] (six groups of four). */
  function codeGroups(code) {
    return cleanCode(code).match(/.{1,4}/g) || [];
  }

  // ---------------------------------------------------------------------
  // Passphrase rules and strength
  // ---------------------------------------------------------------------

  /**
   * How strong a passphrase looks, as {level 0–4, word}. Length is the only
   * rule (at least 12 characters, NIST 800-63B); the meter just nudges
   * towards longer ones and warns about repeated characters.
   */
  function strength(passphrase) {
    const text = cleanPassphrase(passphrase);
    const length = [...text].length;
    if (!length) return { level: 0, word: '' };
    if (length < MIN_PASSPHRASE) return { level: 1, word: 'Too Short' };
    const distinct = new Set(text.toLowerCase()).size;
    if (distinct < 5) return { level: 2, word: 'Weak' };
    if (length >= 20 || (length >= 16 && distinct >= 9)) return { level: 4, word: 'Strong' };
    return { level: 3, word: 'Good' };
  }

  // ---------------------------------------------------------------------
  // Entries and photos
  // ---------------------------------------------------------------------

  /**
   * Scrambles one entry's private fields into base64 text for the "data"
   * column. Short field names keep the Sheet small.
   */
  async function encryptEntry(key, entry) {
    const json = JSON.stringify({ d: entry.date, t: entry.time || '', a: entry.amount, c: entry.category, n: entry.note || '' });
    return toBase64(await seal(key, enc.encode(json), 'sen:entry:' + entry.id));
  }

  /** Unscrambles "data" back into {date, time, amount, category, note}. */
  async function decryptEntry(key, id, data) {
    const fields = JSON.parse(dec.decode(await open(key, fromBase64(data), 'sen:entry:' + id)));
    return { date: fields.d, time: fields.t || '', amount: fields.a, category: fields.c, note: fields.n || '' };
  }

  /** Scrambles a photo (base64 JPEG) for upload. Returns base64. */
  async function encryptPhoto(key, id, jpegBase64) {
    return toBase64(await seal(key, fromBase64(jpegBase64), 'sen:photo:' + id));
  }

  /** Unscrambles a downloaded photo back into base64 JPEG. */
  async function decryptPhoto(key, id, data) {
    return toBase64(await open(key, fromBase64(data), 'sen:photo:' + id));
  }

  // ---------------------------------------------------------------------
  // Remember on This Device (IndexedDB)
  // ---------------------------------------------------------------------

  /** Opens (and on first use creates) the small database. */
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('No IndexedDB'));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** Runs one read or write on the store and waits for it to finish. */
  async function withStore(mode, action) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request ? request.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  /**
   * Keeps this user's data key on this device. It is stored as a
   * non-extractable key: usable for encrypting and decrypting here, but its
   * bytes can't be read back out, even by code on this page.
   */
  async function remember(email, raw, keyId) {
    const key = await importDataKey(raw, false);
    await withStore('readwrite', (store) => store.put({ key, keyId }, email));
  }

  /** The remembered key for this user, as {key, keyId}, or null. */
  async function recall(email) {
    try {
      const saved = await withStore('readonly', (store) => store.get(email));
      return saved && saved.key ? saved : null;
    } catch (err) {
      return null; // private browsing or storage blocked: just ask for the passphrase
    }
  }

  /** Forgets this user's key on this device (Forget This Device). */
  async function forget(email) {
    try {
      await withStore('readwrite', (store) => store.delete(email));
    } catch (err) {
      // nothing stored, or storage blocked: nothing to forget
    }
  }

  return {
    MIN_PASSPHRASE, CODE_LENGTH, WrongSecretError,
    create, buildBox, withNewPassphrase, withNewCode, openWithPassphrase, openWithCode, boxKeyId,
    makeRecoveryCode, cleanCode, looksLikeCode, codeGroups, strength,
    encryptEntry, decryptEntry, encryptPhoto, decryptPhoto, importDataKey,
    remember, recall, forget,
  };
})();
