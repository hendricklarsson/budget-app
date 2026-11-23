// passphrase.js — the screens around encryption.
//
//   First sign-in, for everyone:
//     Create Your Passphrase → Your Recovery Code → (existing users only)
//     Securing Your Data → Overview
//   New phone, or signed out with "Remember on This Device" off:
//     Overview and History show "Unlock Sen Tracker" until the passphrase is typed.
//   Passphrase forgotten:
//     Use Recovery Code Instead → Choose a New Passphrase → Unlocked
//   Both forgotten:
//     Forgot Both? → type DELETE → Start Fresh → Create Your Passphrase
//   Settings:
//     Change Passphrase, New Recovery Code, Forget This Device (in app.js)
//
// The steps draw into #vault-screen, a full screen with no tab bar. The
// current step lives in state.flow: {kind, step, ...}. The maths is in
// crypto.js (SenVault); this file only draws and moves between steps.

'use strict';

state.flow = null;
state.lockDraft = { show: false, error: '' };

// ---------------------------------------------------------------------------
// Starting each flow
// ---------------------------------------------------------------------------

/**
 * First sign-in since encryption arrived (or a brand-new user, or after
 * Start Fresh): make a passphrase. Does nothing if a flow is already on screen.
 */
function startSetup() {
  if (state.demo) return;
  if (!state.flow) state.flow = { kind: 'setup', step: 'create' };
  showVault();
}

/** "Finish Securing" on Overview: encrypt entries saved before encryption. */
function startSecuring() {
  state.flow = { kind: 'secure', step: 'securing', done: 0 };
  showVault();
  runSecuring();
}

/** Settings → Change Passphrase. Asks for the current one first unless it was just typed. */
function startChangePassphrase() {
  state.flow = { kind: 'change', step: state.vault.raw ? 'new-pass' : 'confirm', raw: state.vault.raw };
  showVault();
}

/** Settings → New Recovery Code. Asks for the passphrase first unless it was just typed. */
function startNewRecoveryCode() {
  state.flow = { kind: 'new-code', step: state.vault.raw ? 'code' : 'confirm', raw: state.vault.raw };
  if (state.flow.step === 'code') state.flow.code = SenVault.makeRecoveryCode();
  showVault();
}

/** Locked → Use Recovery Code Instead. */
function startRecovery() {
  state.flow = { kind: 'recover', step: 'recover-code' };
  showVault();
}

/** Shows the full-screen step and draws it. */
function showVault() {
  closeSheet();
  hideToast();
  $('signin-screen').hidden = true;
  $('app-screen').hidden = true;
  $('vault-screen').hidden = false;
  renderVault();
  window.scrollTo(0, 0);
}

/** Leaves the flow for a screen of the app. */
function finishFlow(screen = 'overview') {
  state.flow = null;
  state.screen = screen;
  showScreen(screen);
}

/** Draws the current step of state.flow. */
function renderVault() {
  const flow = state.flow;
  if (!flow) return;
  setWash('vault'); // a step can choose another (success, amber)
  const steps = {
    create: renderCreateStep, code: renderCodeStep, securing: renderSecuringStep, secured: renderSecuredStep,
    'secure-error': renderSecureErrorStep, confirm: renderConfirmStep, 'new-pass': renderNewPassStep,
    'recover-code': renderRecoverCodeStep, recovered: renderRecoveredStep,
  };
  setChildren($('vault-screen'), steps[flow.step]());
  const first = $('vault-screen').querySelector('[data-autofocus]');
  if (first) first.focus();
}

// ---------------------------------------------------------------------------
// Pieces shared by the steps
// ---------------------------------------------------------------------------

/** The top row: a Back pill, or nothing. */
function vaultTop(onBack) {
  return h('div', { class: 'vault-top' },
    onBack ? h('button', { type: 'button', class: 'btn btn-secondary btn-back', onclick: onBack }, icon('back', 20), 'Back') : h('span'));
}

/**
 * A passphrase (or code) field with a Show/Hide button and room for an
 * error under it. Returns {el, input, setError, clearError}. The error is
 * written in words with an icon and a thicker coral border, so it doesn't
 * rely on colour (WCAG 1.4.1, 3.3.1).
 */
function secretField(options) {
  const input = h('input', {
    id: options.id, type: options.plain ? 'text' : 'password', autocomplete: options.autocomplete || 'off',
    class: options.mono ? 'mono' : null, spellcheck: 'false', autocapitalize: options.mono ? 'characters' : 'none',
    'aria-describedby': (options.help ? options.id + '-help ' : '') + options.id + '-error',
    'data-autofocus': options.autofocus ? 'true' : null, placeholder: options.placeholder || null,
  });
  const box = h('div', { class: 'input-box' }, input);
  if (!options.plain) {
    const toggle = h('button', { type: 'button', class: 'link-button', 'aria-pressed': 'false', 'aria-label': 'Show ' + options.label.toLowerCase() }, 'Show');
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Hide' : 'Show';
      toggle.setAttribute('aria-pressed', String(show));
    });
    box.append(toggle);
  }
  const error = h('p', { class: 'field-error', id: options.id + '-error', role: 'alert', hidden: true });
  const el = h('div', { class: 'field' },
    h('label', { class: 'field-label', for: options.id }, options.label),
    options.help ? h('span', { class: 'help', id: options.id + '-help' }, options.help) : null,
    box, options.after || null, error);
  return {
    el, input,
    setError(message) {
      setChildren(error, icon('alert', 18), h('span', null, message));
      error.hidden = false;
      box.classList.add('is-invalid');
      input.setAttribute('aria-invalid', 'true');
    },
    clearError() {
      error.hidden = true;
      box.classList.remove('is-invalid');
      input.removeAttribute('aria-invalid');
    },
  };
}

/** The "Remember on This Device" switch (on by default). Reads and writes state.remember. */
function rememberToggle() {
  const state_ = h('span', { class: 'state', 'aria-hidden': 'true' }, state.remember ? 'On' : 'Off');
  const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(state.remember), 'aria-label': 'Remember on This Device' }, h('span'));
  sw.addEventListener('click', () => {
    state.remember = !state.remember;
    sw.setAttribute('aria-checked', String(state.remember));
    state_.textContent = state.remember ? 'On' : 'Off';
  });
  return h('div', { class: 'toggle-row' },
    h('span', { class: 'grow' }, h('span', { class: 'k', style: 'font-size:15px;font-weight:600' }, 'Remember on This Device'),
      h('span', { class: 'help' }, "You won't need to type it again on this phone.")),
    state_, sw);
}

/** The warning that nobody can recover the entries without the passphrase or code. */
function noRecoveryNotice(tone, words) {
  return h('div', { class: 'notice notice-' + tone, role: tone === 'red' ? 'alert' : 'status' },
    icon('alert', 20),
    h('span', { class: 'text' }, h('b', null, words || "Without your passphrase or recovery code, your entries can't be recovered."), ' Not even by the developer.'));
}

/** Saves the unlocked key on this device (or forgets it) as the switch says. */
async function applyRemember(raw, keyId) {
  if (state.demo || !state.user) return;
  if (state.remember) {
    try { await SenVault.remember(state.user.email, raw, keyId); } catch (err) { console.warn('Could not remember the key:', err); }
  } else {
    await SenVault.forget(state.user.email);
  }
}

/**
 * After unlocking: decrypt the entries that were waiting, send a delete
 * left over from before, and refresh from the server.
 */
async function afterUnlock() {
  const rows = state.storedRows || [];
  state.storedRows = null;
  state.lockDraft = { show: false, error: '' };
  await applyRows(rows);
  sendLeftoverDelete();
  renderAll();
  loadExpenses();
}

// ---------------------------------------------------------------------------
// Create Your Passphrase (and Choose a New Passphrase)
// ---------------------------------------------------------------------------

/**
 * Two fields, the rule stated before typing (WCAG 3.3.2), a strength word,
 * and a button that says why it's off until both are right. Length is the
 * only rule (at least 12 characters, NIST 800-63B). Paste and password
 * managers work (autocomplete="new-password").
 */
function passphraseForm(options) {
  const strengthBars = h('span', { class: 'bars', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'));
  const strengthWord = h('span', { class: 'word' });
  const strength = h('div', { class: 'strength', hidden: true }, strengthBars, strengthWord);
  const first = secretField({ id: 'pass-new', label: options.newLabel || 'Passphrase', help: options.help || 'At least 12 characters. A short sentence works.', autocomplete: 'new-password', after: strength, autofocus: true });
  const matchOk = h('p', { class: 'field-ok', role: 'status', hidden: true }, icon('check', 18, 2.6), 'Both match');
  const second = secretField({ id: 'pass-confirm', label: options.confirmLabel || 'Confirm Passphrase', autocomplete: 'new-password', after: matchOk });
  const failure = h('div', { class: 'notice notice-red', role: 'alert', hidden: true });
  const button = h('button', { type: 'submit', class: 'btn btn-block' });
  let busy = false;
  let leftFirst = false;
  let leftSecond = false;

  /** Updates the meter, the messages and the button as the user types. */
  const update = () => {
    const a = first.input.value;
    const b = second.input.value;
    const s = SenVault.strength(a);
    strength.hidden = !a;
    strengthBars.querySelectorAll('span').forEach((bar, i) => bar.classList.toggle('on', i < s.level));
    strengthWord.textContent = 'Strength: ' + s.word;
    const length = [...a].length;
    const tooShort = length > 0 && length < SenVault.MIN_PASSPHRASE;
    if (tooShort && (leftFirst || b)) first.setError('Too short. Use at least ' + SenVault.MIN_PASSPHRASE + ' characters. You have ' + length + '.');
    else first.clearError();
    const mismatch = b && a !== b && (leftSecond || b.length >= a.length);
    if (mismatch) second.setError("These don't match. Tap Show to check both.");
    else second.clearError();
    matchOk.hidden = !(b && a === b && !tooShort);
    let label = options.buttonLabel;
    let ok = false;
    if (!a) label = 'Type a Passphrase First';
    else if (length < SenVault.MIN_PASSPHRASE) label = 'Passphrase Too Short';
    else if (!b) label = 'Confirm Your Passphrase';
    else if (a !== b) label = "Passphrases Don't Match";
    else ok = true;
    if (busy) { label = options.busyLabel || 'Saving…'; ok = false; }
    button.textContent = label;
    button.disabled = !ok;
    button.className = 'btn btn-block' + (ok ? ' btn-primary' : '');
  };
  first.input.addEventListener('input', update);
  second.input.addEventListener('input', update);
  first.input.addEventListener('blur', () => { leftFirst = true; update(); });
  second.input.addEventListener('blur', () => { leftSecond = true; update(); });

  const form = h('form', { class: 'vault-main', novalidate: true },
    h('h1', { class: 'title' }, options.title1, ' ', h('span', { class: 'sub' }, options.title2)),
    options.step ? h('p', { class: 'step' }, options.step) : null,
    options.lede ? h('p', { class: 'lede' }, options.lede) : null,
    options.accepted ? h('p', { class: 'field-ok', style: 'padding:0 8px', role: 'status' }, icon('check', 18, 2.6), options.accepted) : null,
    h('div', { class: 'card card-pad' }, first.el, second.el),
    options.warning ? noRecoveryNotice('amber') : null,
    failure,
    h('div', { class: 'spacer' }),
    rememberToggle(),
    button);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    busy = true;
    failure.hidden = true;
    update();
    try {
      await options.onSubmit(first.input.value);
    } catch (err) {
      busy = false;
      update();
      setChildren(failure, icon('alert', 20), h('span', { class: 'text' }, err.code === 'NETWORK'
        ? "Couldn't reach the server. Check your internet, then try again. Nothing was changed."
        : 'Something went wrong: ' + err.message));
      failure.hidden = false;
    }
  });
  update();
  return form;
}

/** Step: Create Your Passphrase (first sign-in, or after Start Fresh). */
function renderCreateStep() {
  return [
    vaultTop(() => { state.flow = null; clearUserData(); showSignIn('You have signed out.', 'info'); }),
    passphraseForm({
      title1: 'Create Your', title2: 'Passphrase',
      lede: 'Every entry is encrypted on this phone.',
      buttonLabel: 'Create Passphrase', busyLabel: 'Creating…', warning: true,
      onSubmit: async (passphrase) => {
        const vault = await SenVault.create(passphrase);
        Object.assign(state.flow, { step: 'code', vault, code: vault.code, saved: false });
        renderVault();
      },
    }),
  ];
}

/** Step: Choose a New Passphrase (after the recovery code, or Settings → Change Passphrase). */
function renderNewPassStep() {
  const flow = state.flow;
  const recovering = flow.kind === 'recover';
  return [
    vaultTop(() => (recovering ? finishFlow('overview') : finishFlow('settings'))),
    passphraseForm({
      title1: recovering ? 'Choose a New' : 'Change Your', title2: 'Passphrase',
      step: recovering ? 'Step 2 of 2' : null,
      accepted: recovering ? 'Code accepted.' : null,
      newLabel: 'New Passphrase', confirmLabel: 'Confirm New Passphrase', help: 'At least 12 characters.',
      buttonLabel: 'Save New Passphrase',
      onSubmit: async (passphrase) => {
        const box = await SenVault.withNewPassphrase(state.keys, flow.raw, passphrase);
        await callApi('setKeys', { box, replace: true });
        state.keys = box;
        const key = await SenVault.importDataKey(flow.raw, false);
        state.vault = { key, keyId: SenVault.boxKeyId(box), raw: flow.raw };
        await applyRemember(flow.raw, state.vault.keyId);
        saveCache();
        if (recovering) {
          flow.step = 'recovered';
          await afterUnlock();
          renderVault();
        } else {
          finishFlow('settings');
          showToast('Passphrase changed. Use the new one from now on.');
        }
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Your Recovery Code
// ---------------------------------------------------------------------------

/**
 * Six groups of four, with no look-alike characters, in plain monospace.
 * Copy and Download help save it; Continue stays off until "I've Saved My
 * Recovery Code" is ticked (a forcing function). Continue then saves the
 * key box on the server.
 */
function renderCodeStep() {
  const flow = state.flow;
  const groups = SenVault.codeGroups(flow.code);
  const formatted = groups.join('-');
  const status = h('p', { class: 'field-ok', role: 'status', style: 'margin-top:-4px;padding:0 8px;font-size:14px' });
  const copy = h('button', { type: 'button', class: 'btn btn-secondary btn-block' }, icon('copy', 18), 'Copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(formatted);
      setChildren(copy, icon('check', 18, 2.6), 'Copied');
      status.style.color = '';
      status.textContent = 'Code copied. Paste it somewhere safe.';
    } catch (err) {
      status.style.color = 'var(--error)';
      status.textContent = "Couldn't copy. Write the code down or use Download.";
    }
  });
  const download = h('button', { type: 'button', class: 'btn btn-secondary btn-block' }, icon('download', 18), 'Download');
  download.addEventListener('click', () => {
    const text = 'Sen Tracker recovery code\n\n' + formatted + '\n\n' +
      'If you forget your passphrase, this code lets you choose a new one.\n' +
      'Keep it somewhere away from your phone. Anyone with it and your Google sign-in can read your entries.\n\n' +
      (state.user && state.user.email ? 'Account: ' + state.user.email + '\n' : '') + 'Made: ' + formatDay(today(), true) + '\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = h('a', { href: url, download: 'sen-tracker-recovery-code.txt', hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.style.color = '';
    status.textContent = 'Saved to your downloads. Move it somewhere safe.';
  });

  const tick = h('button', { type: 'button', class: 'checkline', role: 'checkbox', 'aria-checked': String(Boolean(flow.saved)) },
    h('span', { class: 'checkbox', 'aria-hidden': 'true' }, flow.saved ? icon('check', 16, 3) : null), "I've Saved My Recovery Code");
  const failure = h('div', { class: 'notice notice-red', role: 'alert', hidden: true });
  const button = h('button', { type: 'button', class: 'btn btn-block' });
  const update = (busy) => {
    tick.setAttribute('aria-checked', String(Boolean(flow.saved)));
    setChildren(tick.querySelector('.checkbox'), flow.saved ? icon('check', 16, 3) : null);
    button.disabled = !flow.saved || busy;
    button.className = 'btn btn-block' + (flow.saved && !busy ? ' btn-primary' : '');
    button.textContent = busy ? 'Saving…' : !flow.saved ? 'Save Your Code First' : flow.failed ? 'Try Again' : 'Continue';
  };
  tick.addEventListener('click', () => { flow.saved = !flow.saved; update(false); });
  button.addEventListener('click', async () => {
    update(true);
    failure.hidden = true;
    try {
      await saveCodeStep();
    } catch (err) {
      flow.failed = true;
      update(false);
      setChildren(failure, icon('alert', 20), h('span', { class: 'text' }, err.code === 'NETWORK'
        ? "Couldn't reach the server. Check your internet, then try again. Your code is still the one above."
        : 'Something went wrong: ' + err.message));
      failure.hidden = false;
    }
  });
  update(false);

  return [
    vaultTop(flow.kind === 'new-code' ? () => finishFlow('settings') : null),
    h('div', { class: 'vault-main' },
      h('h1', { class: 'title' }, flow.kind === 'new-code' ? 'Your New ' : 'Your ', h('span', { class: 'sub' }, 'Recovery Code')),
      h('p', { class: 'lede' }, 'Save it somewhere away from this phone: a password manager, or written on paper.'),
      h('div', { class: 'card card-pad', style: 'padding:20px 12px' },
        h('p', { class: 'code-grid', 'aria-label': 'Recovery code: ' + groups.map((g) => g.split('').join(' ')).join(', ') },
          groups.map((g) => h('span', { 'aria-hidden': 'true' }, g))),
        h('div', { class: 'two-buttons' }, copy, download)),
      status,
      noRecoveryNotice('red', flow.kind === 'new-code'
        ? "Once you continue, your old code stops working. Without this code or your passphrase, your entries can't be recovered."
        : "Without this code or your passphrase, your entries can't be recovered."),
      failure,
      h('div', { class: 'spacer' }),
      tick,
      button),
  ];
}

/**
 * Continue on the code step. First setup: saves the new key box (if one
 * already exists, e.g. made on another phone a moment ago, that one wins
 * and the user unlocks with its passphrase). New code: replaces the code
 * half of the box.
 */
async function saveCodeStep() {
  const flow = state.flow;
  if (flow.kind === 'new-code') {
    const box = await SenVault.withNewCode(state.keys, flow.raw, flow.code);
    await callApi('setKeys', { box, replace: true });
    state.keys = box;
    saveCache();
    finishFlow('settings');
    showToast('New recovery code saved. The old one no longer works.');
    return;
  }

  const vault = flow.vault;
  try {
    await callApi('setKeys', { box: vault.box });
  } catch (err) {
    if (err.code !== 'CONFLICT') throw err;
    state.keys = err.keys;
    state.flow = null;
    state.storedRows = [];
    finishFlow('overview');
    showToast('A passphrase was already made for this account. Type it to unlock.', { isError: true });
    loadExpenses();
    return;
  }
  state.keys = vault.box;
  state.vault = { key: vault.key, keyId: vault.keyId, raw: vault.raw };
  await applyRemember(vault.raw, vault.keyId);
  await applyRows(state.legacyRows || []);
  state.legacyRows = null;
  state.hasLoaded = true;
  saveCache();
  if (state.expenses.some((e) => e.legacy)) {
    Object.assign(flow, { step: 'securing', done: 0 });
    renderVault();
    runSecuring();
  } else {
    finishFlow('overview');
  }
}

// ---------------------------------------------------------------------------
// Securing Your Data (existing users: encrypting entries saved before)
// ---------------------------------------------------------------------------

/** How many steps the job has: one per entry, plus one per photo. */
function securingTotals() {
  const flow = state.flow;
  if (!flow.total) {
    const legacy = state.expenses.filter((e) => e.legacy);
    flow.entries = legacy.length;
    flow.photos = legacy.filter((e) => e.hasReceipt).length;
    flow.total = flow.entries + flow.photos;
  }
  return flow;
}

/**
 * Encrypts every entry (and photo) saved before encryption, one at a time:
 * photo first (download, encrypt, re-upload), then the entry. Progress is a
 * real bar with a count. If it stops (no internet), nothing is lost, and
 * Try Again carries on from where it stopped.
 */
async function runSecuring() {
  const flow = securingTotals();
  if (flow.running) return;
  flow.running = true;
  try {
    for (const entry of state.expenses.filter((e) => e.legacy)) {
      let receipt;
      if (entry.hasReceipt) {
        const photo = await callApi('getReceipt', { id: entry.id });
        if (!photo.encrypted) receipt = { data: await SenVault.encryptPhoto(state.vault.key, entry.id, photo.data) };
        state.receiptCache.set(entry.id, 'data:image/jpeg;base64,' + photo.data);
      }
      const data = await SenVault.encryptEntry(state.vault.key, entry);
      const result = await callApi('migrate', { expense: { id: entry.id, data, receipt } });
      entry.data = result.expense.data;
      entry.hasReceipt = result.expense.hasReceipt;
      delete entry.legacy;
      flow.done += 1 + (entry.hasReceipt ? 1 : 0);
      saveCache();
      updateSecuringProgress();
    }
    flow.running = false;
    flow.done = flow.total;
    flow.step = 'secured';
    renderVault();
  } catch (err) {
    flow.running = false;
    flow.error = err;
    if (err.code === 'AUTH') return; // the sign-in screen is showing
    flow.step = 'secure-error';
    renderVault();
  }
}

/** Moves the bar and the count without redrawing the screen. */
function updateSecuringProgress() {
  const flow = state.flow;
  const bar = $('secure-bar');
  if (!bar) return;
  bar.setAttribute('aria-valuenow', String(flow.done));
  bar.firstChild.style.width = Math.round((flow.done / Math.max(1, flow.total)) * 100) + '%';
  $('secure-count').textContent = flow.done + ' of ' + flow.total + ' done';
}

/** "23 entries and 9 photos" (or just the entries). */
function entriesAndPhotos(entries, photos) {
  return plural(entries, 'entry', 'entries') + (photos ? ' and ' + plural(photos, 'photo', 'photos') : '');
}

/** The progress bar for the securing steps. */
function securingBar() {
  const flow = state.flow;
  return [
    h('div', { id: 'secure-bar', class: 'progress', role: 'progressbar', 'aria-label': 'Encrypting entries and photos',
      'aria-valuemin': '0', 'aria-valuemax': String(flow.total), 'aria-valuenow': String(flow.done) },
    h('span', { style: 'width:' + Math.round((flow.done / Math.max(1, flow.total)) * 100) + '%' })),
    h('span', { id: 'secure-count', style: 'font-size:15px;font-weight:600;font-variant-numeric:tabular-nums' }, flow.done + ' of ' + flow.total + ' done'),
  ];
}

/** Step: Securing Your Data, in progress. */
function renderSecuringStep() {
  const flow = securingTotals();
  setWash('vault');
  return [
    vaultTop(null),
    h('div', { class: 'vault-main' },
      h('h1', { class: 'title' }, 'Securing ', h('span', { class: 'sub' }, 'Your Data')),
      h('div', { class: 'card card-pad', style: 'gap:14px' },
        h('span', { class: 'big-status', role: 'status' }, 'Encrypting ' + entriesAndPhotos(flow.entries, flow.photos) + '…'),
        securingBar()),
      h('p', { class: 'lede' }, 'This takes about a minute. Keep Sen Tracker open.')),
  ];
}

/** Step: Your Data Is Secured. */
function renderSecuredStep() {
  const flow = state.flow;
  setWash('success');
  return [
    vaultTop(null),
    h('div', { class: 'vault-main' },
      h('h1', { class: 'title' }, 'Your Data ', h('span', { class: 'sub' }, 'Is Secured')),
      h('div', { class: 'notice notice-green', role: 'status' }, icon('check', 20, 2.6),
        h('span', { class: 'text' }, h('b', null, 'All encrypted.'), ' ' + entriesAndPhotos(flow.entries, flow.photos) + ' can now be read only on your devices.')),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn btn-primary btn-block', 'data-autofocus': 'true', onclick: () => finishFlow('overview') }, 'Done')),
  ];
}

/** Step: securing stopped. Leads with what people fear most: nothing was lost. */
function renderSecureErrorStep() {
  const flow = state.flow;
  setWash('amber');
  return [
    vaultTop(null),
    h('div', { class: 'vault-main' },
      h('h1', { class: 'title' }, 'Securing ', h('span', { class: 'sub' }, 'Your Data')),
      h('div', { class: 'notice notice-amber', role: 'alert' }, icon('alert', 20),
        h('span', { class: 'text' }, 'Encrypting stopped at ' + flow.done + ' of ' + flow.total + '. ', h('b', null, 'Nothing was lost.'), ' Your entries and photos are all still here.')),
      h('div', { class: 'card card-pad', style: 'gap:14px' }, securingBar()),
      h('p', { class: 'lede' }, flow.error && flow.error.code !== 'NETWORK'
        ? 'The server said: ' + flow.error.message + ' Try again in a moment.'
        : 'Check your internet, then try again. It carries on from where it stopped.'),
      h('div', { class: 'spacer' }),
      h('div', { class: 'two-buttons' },
        h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: () => finishFlow('overview') }, 'Do It Later'),
        h('button', {
          type: 'button', class: 'btn btn-primary btn-block', 'data-autofocus': 'true',
          onclick: () => { flow.step = 'securing'; renderVault(); runSecuring(); },
        }, 'Try Again'))),
  ];
}

// ---------------------------------------------------------------------------
// Confirm the current passphrase (before changing it or making a new code)
// ---------------------------------------------------------------------------

/** Step: Type Your Passphrase. Needed because a remembered key can't be re-locked without it. */
function renderConfirmStep() {
  const flow = state.flow;
  const field = secretField({ id: 'pass-current', label: 'Current Passphrase', autocomplete: 'current-password', autofocus: true });
  const button = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Continue');
  const form = h('form', { class: 'vault-main', novalidate: true },
    h('h1', { class: 'title' }, 'Type Your ', h('span', { class: 'sub' }, 'Passphrase')),
    h('p', { class: 'lede' }, flow.kind === 'change' ? 'To change it, first type the one you use now.' : 'To make a new recovery code, first type your passphrase.'),
    h('div', { class: 'card card-pad' }, field.el),
    h('div', { class: 'spacer' }),
    button);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!field.input.value) return field.setError('Type your passphrase first.');
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      const opened = await SenVault.openWithPassphrase(state.keys, field.input.value);
      flow.raw = opened.raw;
      state.vault.raw = opened.raw;
      if (flow.kind === 'new-code') {
        flow.code = SenVault.makeRecoveryCode();
        flow.step = 'code';
      } else {
        flow.step = 'new-pass';
      }
      renderVault();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Continue';
      field.setError(err instanceof SenVault.WrongSecretError ? "That passphrase isn't right. Check for typos." : err.message);
      field.input.focus();
    }
  });
  return [vaultTop(() => finishFlow('settings')), form];
}

// ---------------------------------------------------------------------------
// Recover With Your Code
// ---------------------------------------------------------------------------

/**
 * Step 1 of 2: type the recovery code. Case, spaces and dashes are all
 * accepted, so formatting can't cause an error. The whole code stays
 * visible so each group can be checked.
 */
function renderRecoverCodeStep() {
  const flow = state.flow;
  const startOver = h('button', { type: 'button', class: 'link-button coral', style: 'align-self:flex-start;padding:0', hidden: true, onclick: openForgotBoth }, 'Lost Both? Start Over');
  const field = secretField({ id: 'recovery-code', label: 'Recovery Code', help: "24 letters and numbers. Dashes and spaces don't matter.", plain: true, mono: true, autofocus: true, placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX', after: null });
  field.el.append(startOver);
  field.input.value = flow.typed || '';
  field.input.addEventListener('input', () => { flow.typed = field.input.value; field.clearError(); });
  const button = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Check Code');
  const form = h('form', { class: 'vault-main', novalidate: true },
    h('h1', { class: 'title' }, 'Recover With ', h('span', { class: 'sub' }, 'Your Code')),
    h('p', { class: 'step' }, 'Step 1 of 2'),
    h('div', { class: 'card card-pad' }, field.el),
    h('div', { class: 'spacer' }),
    button);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = field.input.value;
    if (!SenVault.looksLikeCode(text)) {
      const length = SenVault.cleanCode(text).length;
      field.setError(length !== SenVault.CODE_LENGTH
        ? 'A recovery code has 24 letters and numbers. This one has ' + length + '.'
        : "This code has a character that's never in a recovery code. Check each group of 4.");
      startOver.hidden = false;
      return;
    }
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      const opened = await SenVault.openWithCode(state.keys, text);
      flow.raw = opened.raw;
      flow.step = 'new-pass';
      renderVault();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Check Code';
      field.setError(err instanceof SenVault.WrongSecretError ? err.message : 'Something went wrong: ' + err.message);
      startOver.hidden = false;
    }
  });
  return [vaultTop(() => finishFlow('overview')), form];
}

/** Step: Sen Tracker Unlocked. States the result and what is unchanged. */
function renderRecoveredStep() {
  setWash('success');
  return [
    vaultTop(null),
    h('div', { class: 'vault-main' },
      h('h1', { class: 'title' }, 'Sen Tracker ', h('span', { class: 'sub' }, 'Unlocked')),
      h('div', { class: 'notice notice-green', role: 'status' }, icon('check', 20, 2.6),
        h('span', { class: 'text' }, 'New passphrase saved. Your entries are readable again.')),
      h('p', { class: 'lede' }, "Your recovery code hasn't changed. If you think someone has seen it, make a new one."),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: () => { state.flow = null; startNewRecoveryCode(); } }, 'Make a New Recovery Code'),
      h('button', { type: 'button', class: 'btn btn-primary btn-block', 'data-autofocus': 'true', onclick: () => finishFlow('overview') }, 'Done')),
  ];
}

// ---------------------------------------------------------------------------
// Locked: Unlock Sen Tracker (on Overview and History)
// ---------------------------------------------------------------------------

/**
 * The single panel shown instead of numbers until the passphrase is typed.
 * Unlocking on either tab unlocks the whole app. `where` is 'overview' or
 * 'history'. The typed passphrase
 * survives a redraw (e.g. when a refresh finishes while typing).
 */
function lockPanel(where) {
  const id = 'unlock-' + where; // each tab has its own panel, so ids stay unique
  const old = document.getElementById(id);
  const typed = old ? old.value : '';
  const hadFocus = old && document.activeElement === old;
  const field = secretField({ id, label: 'Passphrase', autocomplete: 'current-password' });
  field.input.value = typed;
  if (state.lockDraft.error) field.setError(state.lockDraft.error);
  field.input.addEventListener('input', () => { state.lockDraft.error = ''; field.clearError(); });
  const button = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Unlock');
  const form = h('form', { class: 'card lock-card', 'aria-labelledby': id + '-title', novalidate: true },
    h('div', { style: 'display:flex;flex-direction:column;gap:8px;padding:0 4px' },
      h('h2', { id: id + '-title' }, icon('lock', 24), 'Unlock Sen Tracker'),
      h('p', { class: 'lede' }, 'Your entries are encrypted. Type your passphrase to open them on this phone.')),
    field.el,
    rememberToggle(),
    button,
    h('div', { class: 'lock-links' },
      h('button', { type: 'button', class: 'link-button big', onclick: startRecovery }, 'Use Recovery Code Instead'),
      h('button', { type: 'button', class: 'link-button big', onclick: openForgotBoth }, 'Forgot Both?')));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!field.input.value) {
      field.setError('Type your passphrase first.');
      return field.input.focus();
    }
    button.disabled = true;
    button.textContent = 'Unlocking…';
    try {
      const opened = await SenVault.openWithPassphrase(state.keys, field.input.value);
      state.vault = { key: opened.key, keyId: opened.keyId, raw: opened.raw };
      await applyRemember(opened.raw, opened.keyId);
      await afterUnlock();
    } catch (err) {
      state.lockDraft.error = err instanceof SenVault.WrongSecretError ? err.message : 'Something went wrong: ' + err.message;
      button.disabled = false;
      button.textContent = 'Unlock';
      field.setError(state.lockDraft.error);
      field.input.focus();
    }
  });
  if (hadFocus) requestAnimationFrame(() => field.input.focus());
  return form;
}

/**
 * "Forgot Both?": says plainly that nothing can bring the entries back,
 * then offers the only way forward. Keep Trying is first; Start Fresh leads
 * to a typed confirmation.
 */
function openForgotBoth() {
  const rows = state.storedRows || [];
  const counts = plural(rows.length, 'entry', 'entries') + ', ' + plural(rows.filter((r) => r.hasReceipt).length, 'photo', 'photos');
  fillSheet(
    sheetHead('Forgot Both?', { noClose: true }),
    h('p', { class: 'lede sheet-message' }, "Without your passphrase or recovery code, your entries can't be opened. Not by you, and not by the developer."),
    h('div', { class: 'pair' },
      h('div', { class: 'pair-box' }, h('span', { class: 'k' }, "Can't Be Opened"), h('span', { class: 'v' }, counts)),
      h('div', { class: 'pair-box' }, h('span', { class: 'k' }, 'Stays the Same'), h('span', { class: 'v' }, 'Your account'))),
    h('p', { class: 'lede', style: 'padding:0 4px' }, 'Start Fresh deletes the locked entries. Then you create a new passphrase and carry on.'),
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: closeSheet }, 'Keep Trying'),
      h('button', { type: 'button', class: 'btn btn-quiet-danger btn-block', onclick: () => openStartFresh(counts) }, 'Start Fresh')));
  $('sheet').classList.add('is-danger');
  $('sheet').setAttribute('role', 'alertdialog');
  openSheet();
}

/** "Start Fresh?": deletes the locked entries and photos, then a new passphrase. */
function openStartFresh(counts) {
  openTypeDeleteSheet({
    title: 'Start Fresh?',
    message: "Your locked entries and receipt photos will be deleted for good. Then you'll create a new passphrase.",
    deleted: counts,
    kept: 'Your account',
    keepLabel: 'Keep Trying',
    actionLabel: 'Delete and Start Fresh',
    action: async () => {
      await callApi('deleteMyData');
      await SenVault.forget(state.user.email);
      localStorage.removeItem(CACHE_PREFIX + state.user.email);
      localStorage.removeItem(PENDING_DELETE_PREFIX + state.user.email);
      Object.assign(state, { keys: null, vault: null, storedRows: null, legacyRows: [], expenses: [], pendingDelete: null });
      closeSheet();
      state.flow = { kind: 'setup', step: 'create' };
      showVault();
    },
  });
}
