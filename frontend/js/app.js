/**
 * Ming Ramen Bar 排班意願申請 - 前端主邏輯（員工頁）
 * 依賴載入順序：config.js -> demo-data.js -> auth.js -> app.js
 *
 * 身分一律來自後端 whoami（Google ID Token 驗證後反查），
 * 前端不再讓使用者自己選姓名，也只會拿到「自己 + 與自己重疊的同事」。
 */
(async function () {
  const DOW_ZH = ['日', '一', '二', '三', '四', '五', '六'];

  // preset shift templates. end:null means "use that day's closing bound"
  const PRESET_DEFS = [
    { key: 'morning', name: '早班', start: '10:30', end: '15:30' },
    { key: 'midlate', name: '下午晚班', start: '15:30', end: null },
    { key: 'late', name: '晚班', start: '17:30', end: null },
    { key: 'full', name: '全班', start: '10:30', end: null },
  ];

  const state = {
    me: null,        // {name, role, email}
    days: [],        // 7 Date objects: next week's Mon..Sun
    requests: {},    // "YYYY-MM-DD" -> {off, text, raw}  (= server-confirmed state)
    overlaps: {},    // "YYYY-MM-DD" -> [{name, role, text}]
    weekErrors: {},  // "YYYY-MM-DD" -> error code
    month: null,     // {hours, days, offDays, month, note}
    openDate: null,
    saving: false,
    signingIn: false,  // 登入流程進行中（避免重複觸發）
    isAdmin: false,    // 管理員兼員工（店長）のとき true
  };

  /* ---------------- date helpers ---------------- */

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay(); // 0=Sun..6=Sat
  const diffFromMonday = dow === 0 ? 6 : dow - 1; // days since this week's Monday
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - diffFromMonday);
  const nextMonday = new Date(thisMonday);
  nextMonday.setDate(thisMonday.getDate() + 7);
  for (let i = 0; i < 7; i++) {
    const d = new Date(nextMonday);
    d.setDate(nextMonday.getDate() + i);
    state.days.push(d);
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function dayMax(d) { return d.getDay() === 6 ? '22:00' : '21:30'; } // Saturday=6
  function toMin(str) { const [h, m] = str.split(':').map(Number); return h * 60 + m; }
  function toStr(min) { const h = Math.floor(min / 60), m = min % 60; return pad(h) + ':' + pad(m); }
  function fmtMD(d) { return `${d.getMonth() + 1}/${d.getDate()}`; }
  function timeOptions(maxStr) {
    const arr = []; const max = toMin(maxStr);
    for (let t = toMin('10:30'); t <= max; t += 30) arr.push(toStr(t));
    return arr;
  }
  function mapRoleCls(role) {
    role = role || '';
    if (role.includes('經理') || role.includes('正職')) return 'mgr';
    if (role.includes('組長')) return 'chief';
    if (role.includes('支援')) return 'support';
    return 'pt';
  }
  function parseServerValue(raw) {
    if (!raw) return null;
    const t = String(raw).trim();
    if (!t) return null;
    if (t.startsWith('排休')) return { off: true, text: '排休', raw: 'off' };
    const times = t.match(/\d{1,2}:\d{2}/g);
    if (times && times.length >= 2) {
      const s = times[0], e = times[1];
      return { off: false, text: `${s} ${e}`, raw: `${s}-${e}` };
    }
    return null;
  }
  function rangesOverlap(a, b) { return a[0] < b[1] && b[0] < a[1]; }
  function parseRange(v) {
    if (!v || v === 'off') return null;
    const [s, e] = v.split('-');
    return [toMin(s), toMin(e)];
  }

  /* ---------------- dom shortcuts ---------------- */

  const $ = function (id) { return document.getElementById(id); };
  const authGate = $('authGate');
  const bindGate = $('bindGate');
  const adminGate = $('adminGate');
  const chooseGate = $('chooseGate');
  const appMain = $('appMain');
  const submitBar = $('submitBar');
  const syncBanner = $('syncBanner');

  function showOnly(el) {
    [authGate, bindGate, adminGate, chooseGate, appMain].forEach(function (node) {
      node.style.display = node === el ? 'block' : 'none';
    });
    submitBar.style.display = el === appMain ? 'flex' : 'none';
  }
  function showBanner(kind, text) {
    syncBanner.className = `sync-banner show ${kind}`;
    syncBanner.textContent = text;
  }
  function hideBanner() {
    syncBanner.className = 'sync-banner';
    syncBanner.onclick = null;
    syncBanner.style.cursor = '';
  }

  /** 失敗時は行き止まりにせず、バナー自体を押して再試行できるようにする */
  function showRetryBanner(text, retryFn) {
    showBanner('error', text + '　👉 點此重試');
    syncBanner.style.cursor = 'pointer';
    syncBanner.onclick = function () { hideBanner(); retryFn(); };
  }

  /* ============================================================
   * 登入流程
   * ========================================================== */

  async function boot() {
    if (isDemoMode) {
      $('demoBadge').style.display = 'inline-block';
      showBanner('warn', '⚠ 尚未設定後端／Google 登入，目前為示範模式');
      state.me = { name: DEMO_ME.name, role: DEMO_ME.role, email: DEMO_ME.email };
      await enterApp();
      return;
    }

    Auth.onAuthLost = function (code) {
      state.signingIn = false;
      showOnly(authGate);
      setAuthBusy(false);
      $('authError').textContent = Auth.describeError(code);
      startSignIn();
    };

    showOnly(authGate);
    await startSignIn();
  }

  /**
   * 登入處理中就把登入按鈕換成「處理中」。
   * Apps Script 第一次被叫醒要好幾秒，按鈕若一直留著，使用者會以為
   * 沒反應而再按一次 —— 那就是「要登入兩次」的來源。
   */
  function setAuthBusy(busy, text) {
    const slot = $('gsiButton');
    const busyEl = $('authBusy');
    if (slot) slot.style.display = busy ? 'none' : 'flex';
    if (busyEl) {
      busyEl.hidden = !busy;
      if (busy && text) $('authBusyText').textContent = text;
    }
  }

  async function startSignIn() {
    if (state.signingIn) return;   // 連按兩次不會跑兩套流程
    state.signingIn = true;
    $('authError').textContent = '';
    setAuthBusy(false);

    try {
      await Auth.signIn($('gsiButton'));
    } catch (err) {
      state.signingIn = false;
      setAuthBusy(false);
      $('authError').textContent = err.message;
      return;
    }

    setAuthBusy(true, '登入成功，確認身分中…');
    try {
      await routeByProfile();
    } finally {
      state.signingIn = false;
    }
  }

  async function routeByProfile() {
    showBanner('ok', '登入成功，讀取資料中…');
    const who = await Auth.whoami();
    setAuthBusy(false);
    if (!who.ok) {
      showOnly(authGate);
      $('authError').textContent = Auth.describeError(who.error);
      hideBanner();
      return;
    }

    // 名單に載っていない「純管理員」だけ管理頁へ誘導する。
    // 店長のように員工でもある場合は、そのまま員工頁で自分の班を出す。
    if (who.role === 'admin') {
      hideBanner();
      $('adminEmail').textContent = who.email;
      showOnly(adminGate);
      return;
    }
    if (who.role === 'unregistered') {
      hideBanner();
      $('bindEmail').textContent = who.email;
      buildBindOptions(who.unboundRoster || []);
      showOnly(bindGate);
      return;
    }

    state.me = { name: who.name, role: who.roleTitle || '', email: who.email };
    // 後端が古く isAdmin を返さない場合も考慮（その場合 role==='admin' で来る）
    state.isAdmin = !!(who.isAdmin || who.role === 'admin');
    // LINE 連携（後端が対応していなければ両方 undefined → 導線を出さない）
    state.lineLoginReady = !!who.lineLoginReady;
    state.lineLinked = !!who.lineLinked;

    // 管理員兼員工なら、どちらの畫面に入るかを選んでもらう
    if (state.isAdmin) {
      hideBanner();
      $('chooseName').textContent = `${state.me.name}${state.me.role ? '（' + state.me.role + '）' : ''}`;
      showOnly(chooseGate);
      return;
    }

    await enterApp();
  }

  $('chooseStaff').onclick = function () { enterApp(); };
  $('chooseSignOut').onclick = function () { Auth.signOut(); location.reload(); };

  /* ---------------- 首次登入：綁定姓名 ---------------- */

  const bindSelect = $('bindSelect');
  const bindBtn = $('bindBtn');

  function buildBindOptions(list) {
    bindSelect.innerHTML = '<option value="" disabled selected>請選擇姓名</option>';
    list.forEach(function (s) {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.role ? `${s.name}（${s.role}）` : s.name;
      bindSelect.appendChild(opt);
    });
    bindBtn.disabled = true;
    if (!list.length) {
      $('bindError').textContent = '名單裡已經沒有未綁定的員工了，請聯絡店長確認 C 欄 Email。';
    }
  }

  bindSelect.onchange = function () { bindBtn.disabled = !bindSelect.value; };

  bindBtn.onclick = async function () {
    if (!bindSelect.value || bindBtn.disabled) return;
    bindBtn.disabled = true;
    bindBtn.textContent = '綁定中…';
    $('bindError').textContent = '';

    const res = await Auth.post({ action: 'linkAccount', name: bindSelect.value });

    bindBtn.textContent = '確認綁定';
    if (!res.ok) {
      bindBtn.disabled = false;
      $('bindError').textContent = Auth.describeError(res.error);
      return;
    }
    state.me = { name: res.name, role: res.roleTitle || '', email: Auth.profile.email };

    // 綁定直後は whoami の結果が「未綁定」のままなので、LINE 連携の状態だけ
    // 取り直す（失敗しても本題ではないので握りつぶす）
    const who = await Auth.whoami();
    if (who.ok) {
      state.lineLoginReady = !!who.lineLoginReady;
      state.lineLinked = !!who.lineLinked;
    }

    await enterApp();
  };

  $('bindSignOut').onclick = function () { Auth.signOut(); location.reload(); };
  $('adminSignOut').onclick = function () { Auth.signOut(); location.reload(); };
  $('signOutBtn').onclick = function () { Auth.signOut(); location.reload(); };

  /* ============================================================
   * 主畫面
   * ========================================================== */

  async function enterApp() {
    $('meName').textContent = state.me.name;
    $('meEmail').textContent = state.me.email || '';
    const roleChip = $('roleChip');
    if (state.me.role) {
      roleChip.style.display = 'inline-block';
      roleChip.className = `role-chip role ${mapRoleCls(state.me.role)}`;
      roleChip.textContent = state.me.role;
    } else {
      roleChip.style.display = 'none';
    }

    $('adminLinkRow').style.display = state.isAdmin ? 'block' : 'none';
    renderLineRow();

    $('weekNote').innerHTML =
      `開放申請下週班表：<b>${fmtMD(state.days[0])}（一）〜 ${fmtMD(state.days[6])}（日）</b>`;

    showOnly(appMain);

    // 先把骨架畫出來再去要資料。Apps Script 冷啟動要好幾秒，
    // 等資料回來才第一次 render 的話，那幾秒畫面幾乎是空白的。
    renderAll();
    showBanner('ok', '讀取班表中…');

    await loadWeek();
    renderAll();
    loadMonthHours();
  }

  /* ---------------- LINE 連結 ----------------
   * userId は LINE Login（同じ provider の LINE Login チャネル）から取る。
   * 自分の姓名は後端が Google ログインから割り出しているので、
   * LINE の表示名が班表の姓名と違っていても関係ない。
   */

  function renderLineRow() {
    const row = $('lineRow');
    if (!isDemoMode && !state.lineLoginReady) { row.style.display = 'none'; return; }
    row.style.display = 'block';

    const linked = !!state.lineLinked;
    $('lineStatus').textContent = linked ? '已連結 LINE' : '尚未連結 LINE';
    $('lineDesc').textContent = linked
      ? '忘記填班表時，群組的提醒訊息會直接 @ 你。'
      : '連結後，忘記填班表時 LINE 群組的提醒會直接 @ 你。';
    $('lineBadge').className = 'line-badge' + (linked ? ' on' : '');
    $('lineLinkBtn').style.display = linked ? 'none' : 'block';
    $('lineUnlinkBtn').style.display = linked ? 'inline-block' : 'none';
    $('lineError').textContent = '';
  }

  $('lineLinkBtn').onclick = async function () {
    if (isDemoMode) {
      $('lineError').textContent = '示範模式無法連結 LINE。';
      return;
    }
    const btn = $('lineLinkBtn');
    btn.disabled = true;
    btn.textContent = '準備中…';
    $('lineError').textContent = '';

    const res = await Auth.get('startLineLink');
    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = '連結 LINE 帳號';
      $('lineError').textContent = Auth.describeError(res.error);
      return;
    }
    // LINE の同意画面へ。戻り先は後端（/exec）で、そこで結果ページが出る。
    location.href = res.url;
  };

  $('lineUnlinkBtn').onclick = async function () {
    if (isDemoMode) return;
    if (!confirm('解除連結後，提醒訊息就不會再 @ 你（但還是會列出你的姓名）。要解除嗎？')) return;

    const btn = $('lineUnlinkBtn');
    btn.disabled = true;
    const res = await Auth.post({ action: 'unlinkLine' });
    btn.disabled = false;

    if (!res.ok) {
      $('lineError').textContent = Auth.describeError(res.error);
      return;
    }
    state.lineLinked = false;
    renderLineRow();
  };

  /* ---------------- 讀取本週資料 ---------------- */

  async function loadWeek() {
    if (isDemoMode) { loadWeekDemo(); return; }

    const res = await Auth.get('getWeek', { dates: state.days.map(ymd).join(',') });
    if (!res.ok) {
      showRetryBanner('⚠ 無法讀取班表：' + Auth.describeError(res.error), async function () {
        await loadWeek();
        renderAll();
      });
      return;
    }

    state.overlaps = res.overlaps || {};
    state.weekErrors = res.errors || {};
    state.requests = {};
    Object.keys(res.mine || {}).forEach(function (date) {
      const parsed = parseServerValue(res.mine[date]);
      if (parsed) state.requests[date] = parsed;
    });

    const missing = Object.keys(state.weekErrors);
    if (missing.length) {
      showBanner('warn', `⚠ ${missing.length} 天所屬的月份分頁尚未建立，請聯絡店長`);
    } else {
      hideBanner();
    }
  }

  /** 示範模式：用 DEMO_PATTERNS 在前端模擬後端的重疊比對 */
  function loadWeekDemo() {
    state.demoWeek = {};
    state.days.forEach(function (d, i) {
      const key = ymd(d);
      state.demoWeek[key] = {};
      Object.keys(DEMO_PATTERNS).forEach(function (name) {
        state.demoWeek[key][name] = DEMO_PATTERNS[name][i];
      });
    });
    recomputeDemoOverlaps();
  }

  function recomputeDemoOverlaps() {
    state.overlaps = {};
    state.days.forEach(function (d) {
      const key = ymd(d);
      const mine = state.requests[key];
      if (!mine || mine.off) return;
      const myRange = parseRange(mine.raw);
      if (!myRange) return;

      const matches = [];
      DEMO_STAFF.forEach(function (person) {
        if (person.name === state.me.name) return;
        const parsed = parseServerValue(state.demoWeek[key] && state.demoWeek[key][person.name]);
        if (!parsed || parsed.off) return;
        const other = parseRange(parsed.raw);
        if (other && rangesOverlap(myRange, other)) {
          matches.push({ name: person.name, role: person.role, text: parsed.text });
        }
      });
      if (matches.length) state.overlaps[key] = matches;
    });
  }

  /** 存檔後在背景重新整理，讓重疊資訊跟著更新 */
  async function refreshOverlaps() {
    if (isDemoMode) { recomputeDemoOverlaps(); renderAll(); return; }
    const res = await Auth.get('getWeek', { dates: state.days.map(ymd).join(',') });
    if (!res.ok) return;
    state.overlaps = res.overlaps || {};
    renderAll();
  }

  /* ---------------- 工時試算 ---------------- */

  function weekSubtotal() {
    let minutes = 0, days = 0, offDays = 0;
    state.days.forEach(function (d) {
      const r = state.requests[ymd(d)];
      if (!r) return;
      if (r.off) { offDays++; return; }
      const range = parseRange(r.raw);
      if (range && range[1] > range[0]) { minutes += range[1] - range[0]; days++; }
    });
    return { hours: Math.round((minutes / 60) * 10) / 10, days: days, offDays: offDays };
  }

  async function loadMonthHours() {
    if (isDemoMode) {
      state.month = {
        hours: Math.round((DEMO_MONTH_MINUTES / 60) * 10) / 10,
        days: DEMO_MONTH_DAYS,
        month: `${today.getFullYear()}-${pad(today.getMonth() + 1)}`,
        throughDay: today.getDate(),
      };
      renderHours();
      return;
    }

    const res = await Auth.get('getMonthHours');
    if (!res.ok) {
      $('monthHoursSub').textContent = Auth.describeError(res.error);
      return;
    }
    state.month = res;
    renderHours();
  }

  function renderHours() {
    const wk = weekSubtotal();
    $('weekHours').textContent = wk.hours;
    $('weekHoursSub').textContent = wk.days
      ? `上班 ${wk.days} 天${wk.offDays ? ` ・ 排休 ${wk.offDays} 天` : ''}`
      : (wk.offDays ? `全部排休 ${wk.offDays} 天` : '尚未選擇');

    const m = state.month;
    if (!m) return;

    $('monthHours').textContent = m.hours;
    $('hoursMonthLabel').textContent = m.month ? `${Number(m.month.split('-')[1])} 月` : '';
    if (m.note === 'month_sheet_not_found') {
      $('monthHoursSub').textContent = '本月分頁尚未建立';
    } else if (m.note === 'staff_not_found_in_month_sheet') {
      $('monthHoursSub').textContent = '本月分頁找不到你的姓名';
    } else {
      $('monthHoursSub').textContent =
        `1 日〜${m.throughDay} 日 ・ 上班 ${m.days} 天${m.offDays ? ` ・ 排休 ${m.offDays} 天` : ''}`;
    }
  }

  /* ---------------- 7-day strip ---------------- */

  const dayStrip = $('dayStrip');
  function renderDayStrip() {
    dayStrip.innerHTML = '';
    state.days.forEach(function (d) {
      const key = ymd(d);
      const card = document.createElement('div');
      const w = d.getDay();
      card.className = 'day-card' + (w === 6 ? ' sat' : '') + (w === 0 ? ' sun' : '');

      let markText = '';
      const r = state.requests[key];
      if (r) {
        if (r.off) { card.classList.add('has-off'); markText = '排休'; }
        else { card.classList.add('has-shift'); markText = r.text; }
      }
      if (state.weekErrors[key]) card.classList.add('unavailable');

      card.innerHTML =
        `<span class="dow">${DOW_ZH[w]}</span><span class="dnum">${d.getDate()}</span><span class="mark">${markText}</span>`;
      card.onclick = function () {
        if (state.weekErrors[key]) {
          alert('這天所屬的月份分頁還沒建立，請先請店長建立分頁。');
          return;
        }
        openSheet(d);
      };
      dayStrip.appendChild(card);
    });
  }

  /* ---------------- bottom sheet ---------------- */

  const overlay = $('overlay');
  const sheet = $('sheet');
  const sheetDate = $('sheetDate');
  const presetGrid = $('presetGrid');
  const startField = $('startField');
  const endField = $('endField');
  const startSelect = $('startSelect');
  const endSelect = $('endSelect');
  const rangeHint = $('rangeHint');
  const offBtn = $('offBtn');

  function populateTimeSelects(maxStr, startVal, endVal) {
    const opts = timeOptions(maxStr);
    const html = opts.map(function (t) { return `<option value="${t}">${t}</option>`; }).join('');
    startSelect.innerHTML = html;
    endSelect.innerHTML = html;
    startSelect.value = startVal || '10:30';
    endSelect.value = endVal || maxStr;
  }
  function fixEndAfterStart() {
    if (toMin(endSelect.value) <= toMin(startSelect.value)) {
      const opts = [...endSelect.options].map(function (o) { return o.value; });
      const next = opts.find(function (v) { return toMin(v) > toMin(startSelect.value); });
      if (next) endSelect.value = next;
    }
  }
  function clearActiveStates() {
    offBtn.classList.remove('active');
    [...presetGrid.children].forEach(function (c) { c.classList.remove('active'); });
    startField.classList.remove('custom-active');
    endField.classList.remove('custom-active');
  }
  startSelect.onchange = function () {
    fixEndAfterStart(); clearActiveStates();
    startField.classList.add('custom-active'); endField.classList.add('custom-active');
  };
  endSelect.onchange = function () {
    clearActiveStates();
    startField.classList.add('custom-active'); endField.classList.add('custom-active');
  };
  offBtn.onclick = function () { clearActiveStates(); offBtn.classList.add('active'); };

  function buildPresetGrid(max) {
    presetGrid.innerHTML = '';
    PRESET_DEFS.forEach(function (p) {
      const end = p.end || max;
      const el = document.createElement('button');
      el.className = 'preset';
      el.innerHTML = `<span class="p-name">${p.name}</span><span class="p-time">${p.start}-${end}</span>`;
      el.onclick = function () {
        clearActiveStates();
        el.classList.add('active');
        startSelect.value = p.start;
        endSelect.value = end;
      };
      el.dataset.start = p.start; el.dataset.end = end;
      presetGrid.appendChild(el);
    });
  }

  function openSheet(d) {
    state.openDate = d;
    const max = dayMax(d);
    const w = DOW_ZH[d.getDay()];
    sheetDate.textContent = `${d.getMonth() + 1}月${d.getDate()}日（${w}）`;
    rangeHint.innerHTML = `本日可選時段：<b>10:30 〜 ${max}</b>`;

    buildPresetGrid(max);
    populateTimeSelects(max);
    clearActiveStates();

    const existing = state.requests[ymd(d)];
    if (existing && existing.off) {
      offBtn.classList.add('active');
    } else if (existing && !existing.off) {
      const [s, e] = existing.raw.split('-');
      startSelect.value = s; endSelect.value = e;
      const matchPreset = [...presetGrid.children].find(function (c) {
        return c.dataset.start === s && c.dataset.end === e;
      });
      if (matchPreset) { matchPreset.classList.add('active'); }
      else { startField.classList.add('custom-active'); endField.classList.add('custom-active'); }
    }

    overlay.classList.add('show');
    sheet.classList.add('show');
  }
  function closeSheet() { overlay.classList.remove('show'); sheet.classList.remove('show'); }
  overlay.onclick = closeSheet;

  const clearBtn = $('clearBtn');
  const okBtn = $('okBtn');

  /** 送出排班：只帶日期與時間，姓名由後端用 ID Token 反查 */
  async function saveToServer(payload) {
    if (isDemoMode) return { ok: true };
    return Auth.post(Object.assign({ action: 'submitShift' }, payload));
  }

  function setSheetBusy(busy, label) {
    state.saving = busy;
    okBtn.disabled = busy; clearBtn.disabled = busy;
    okBtn.textContent = busy ? (label || '儲存中…') : '確認設定';
  }

  clearBtn.onclick = async function () {
    if (state.saving) return;
    const key = ymd(state.openDate);
    setSheetBusy(true, '刪除中…');
    const result = await saveToServer({ date: key, clear: true });
    setSheetBusy(false);
    if (!result.ok) { alert('刪除失敗，請稍後再試\n' + Auth.describeError(result.error)); return; }

    delete state.requests[key];
    if (isDemoMode && state.demoWeek[key]) state.demoWeek[key][state.me.name] = '';
    closeSheet(); renderAll(); refreshOverlaps();
  };

  okBtn.onclick = async function () {
    if (state.saving) return;
    const key = ymd(state.openDate);

    let payload, entry;
    if (offBtn.classList.contains('active')) {
      payload = { date: key, off: true };
      entry = { off: true, text: '排休', raw: 'off' };
    } else {
      fixEndAfterStart();
      const s = startSelect.value, e = endSelect.value;
      payload = { date: key, off: false, start: s, end: e };
      entry = { off: false, text: `${s} ${e}`, raw: `${s}-${e}` };
    }

    setSheetBusy(true);
    const result = await saveToServer(payload);
    setSheetBusy(false);
    if (!result.ok) { alert('儲存失敗，請稍後再試\n' + Auth.describeError(result.error)); return; }

    state.requests[key] = entry;
    if (isDemoMode) {
      if (!state.demoWeek[key]) state.demoWeek[key] = {};
      state.demoWeek[key][state.me.name] = entry.off ? '排休\nday off' : entry.raw.replace('-', '\n');
    }
    closeSheet(); renderAll(); refreshOverlaps();
  };

  /* ---------------- 預覽矩陣（自己 + 重疊同事） ---------------- */

  function overlapColleagues() {
    const seen = {};
    const list = [];
    state.days.forEach(function (d) {
      (state.overlaps[ymd(d)] || []).forEach(function (m) {
        if (seen[m.name]) return;
        seen[m.name] = true;
        list.push({ name: m.name, role: m.role || '' });
      });
    });
    return list;
  }

  function renderMatrix() {
    const table = $('matrixTable');
    table.innerHTML = '';
    const colleagues = overlapColleagues();

    const thead = document.createElement('tr');
    thead.innerHTML = `<th class="name-col">員工</th>` +
      state.days.map(function (d) { return `<th>${fmtMD(d)}</th>`; }).join('');
    table.appendChild(thead);

    colleagues.forEach(function (person) {
      const tr = document.createElement('tr');
      let cells = `<td class="name-col">${person.name}</td>`;
      state.days.forEach(function (d) {
        const match = (state.overlaps[ymd(d)] || []).find(function (m) { return m.name === person.name; });
        cells += match ? `<td class="overlap">${match.text}</td>` : `<td>　</td>`;
      });
      tr.innerHTML = cells;
      table.appendChild(tr);
    });

    const tr = document.createElement('tr');
    tr.className = 'me';
    let cells = `<td class="name-col">${state.me.name} ←你</td>`;
    state.days.forEach(function (d) {
      const key = ymd(d);
      const r = state.requests[key];
      const isOverlap = !!state.overlaps[key];
      if (!r) { cells += `<td>　</td>`; }
      else if (r.off) { cells += `<td class="off new">休</td>`; }
      else { cells += `<td class="new${isOverlap ? ' overlap' : ''}">${r.text}</td>`; }
    });
    tr.innerHTML = cells;
    table.appendChild(tr);

    renderOverlapSummary();
  }

  function renderOverlapSummary() {
    const box = $('overlapSummary');

    const hasAnyShift = state.days.some(function (d) {
      const r = state.requests[ymd(d)];
      return r && !r.off;
    });
    if (!hasAnyShift) { box.innerHTML = ''; return; }

    const withOverlap = state.days
      .map(function (d, i) { return { d: d, i: i }; })
      .filter(function (x) { return state.overlaps[ymd(x.d)]; });

    let html = `<p class="ov-title">👥 與你時段重疊的同事</p>`;
    if (!withOverlap.length) {
      html += `<p class="ov-empty">目前選擇的時段，暫無其他人重疊班別。</p>`;
    } else {
      withOverlap.forEach(function (x) {
        const key = ymd(x.d);
        const r = state.requests[key];
        const w = DOW_ZH[x.d.getDay()];
        const names = state.overlaps[key]
          .map(function (m) { return `<b>${m.name}</b>`; }).join('、');
        html += `<div class="ov-row">
          <span class="ov-date">${fmtMD(x.d)}（${w}）</span>
          <span class="ov-time">${r.text}</span>
          <span class="ov-names">${names}</span>
        </div>`;
      });
    }
    box.innerHTML = html;
  }

  /* ---------------- submit bar ---------------- */

  const pickedName = $('pickedName');
  const pickedCount = $('pickedCount');
  const submitBtn = $('submitBtn');

  function updateBar() {
    pickedName.textContent = state.me ? state.me.name : '—';
    const n = Object.keys(state.requests).length;
    pickedCount.textContent = n;
    submitBtn.disabled = n === 0;
  }

  function renderAll() {
    renderDayStrip();
    renderMatrix();
    renderHours();
    updateBar();
  }

  const stampToast = $('stampToast');
  submitBtn.onclick = async function () {
    if (submitBtn.disabled) return;
    // 每個日期在按下「確認設定」時就已即時寫入試算表；
    // 這裡重新讀取一次確認雲端已同步，並顯示完成戳章。
    submitBtn.disabled = true;
    await loadWeek();
    renderAll();
    loadMonthHours();
    stampToast.classList.add('show');
    setTimeout(function () { stampToast.classList.remove('show'); }, 1300);
  };

  /* ---------------- init ---------------- */
  await boot();
})();
