/**
 * Ming Ramen Bar - 管理員頁邏輯（admin.html）
 * 依賴載入順序：config.js -> demo-data.js -> auth.js -> admin.js
 *
 * 管理員資格完全由後端判斷（Email 是否在 Script Properties 的
 * ADMIN_EMAILS 內），前端只是把畫面藏起來，不構成安全邊界。
 */
(async function () {
  const DOW_ZH = ['日', '一', '二', '三', '四', '五', '六'];

  const state = {
    email: null,
    weekOffset: 1,   // 0=本週, 1=下週（預設看下週，也就是員工正在填的那一週）
    days: [],
    roster: [],      // [{name, role, email}]
    data: {},        // { "YYYY-MM-DD": { name: rawCellText } }
    loading: false,
    signingIn: false,  // 登入流程進行中（避免重複觸發）
  };

  /* ---------------- helpers ---------------- */

  const $ = function (id) { return document.getElementById(id); };

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function fmtMD(d) { return `${d.getMonth() + 1}/${d.getDate()}`; }
  function toMin(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }

  function parseServerValue(raw) {
    if (!raw) return null;
    const t = String(raw).trim();
    if (!t) return null;
    if (t.startsWith('排休')) return { off: true, text: '休', raw: 'off' };
    const times = t.match(/\d{1,2}:\d{2}/g);
    if (times && times.length >= 2) {
      return { off: false, text: `${times[0]} ${times[1]}`, start: times[0], end: times[1] };
    }
    return null;
  }

  /** 以「本週一」為基準，offset 週後的 Mon..Sun */
  function buildDays(offset) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + offset * 7);

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      days.push(d);
    }
    return days;
  }

  const syncBanner = $('syncBanner');
  function showBanner(kind, text) {
    syncBanner.className = `sync-banner show ${kind}`;
    syncBanner.textContent = text;
  }
  function hideBanner() { syncBanner.className = 'sync-banner'; }

  const authGate = $('authGate');
  const denyGate = $('denyGate');
  const adminMain = $('adminMain');
  function showOnly(el) {
    [authGate, denyGate, adminMain].forEach(function (node) {
      node.style.display = node === el ? 'block' : 'none';
    });
  }

  /* ============================================================
   * 登入
   * ========================================================== */

  async function boot() {
    if (isDemoMode) {
      $('demoBadge').style.display = 'inline-block';
      showBanner('warn', '⚠ 尚未設定後端／Google 登入，目前為示範模式');
      state.email = DEMO_ADMIN.email;
      await enterAdmin();
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
   * Apps Script 第一次被叫醒要好幾秒，按鈕留著的話會被按第二次。
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
    showBanner('ok', '登入成功，讀取資料中…');
    try {
      const who = await Auth.whoami();
      setAuthBusy(false);
      if (!who.ok) {
        hideBanner();
        showOnly(authGate);
        $('authError').textContent = Auth.describeError(who.error);
        return;
      }
      if (!who.isAdmin) {
        hideBanner();
        $('denyEmail').textContent = who.email;
        showOnly(denyGate);
        return;
      }

      state.email = who.email;
      await enterAdmin();
    } finally {
      state.signingIn = false;
    }
  }

  $('denySignOut').onclick = function () { Auth.signOut(); location.reload(); };
  $('signOutBtn').onclick = function () { Auth.signOut(); location.reload(); };

  /* ============================================================
   * 主畫面
   * ========================================================== */

  async function enterAdmin() {
    $('meEmail').textContent = state.email;
    showOnly(adminMain);
    await loadRoster();
    await loadWeek();
  }

  async function loadRoster() {
    if (isDemoMode) {
      state.roster = DEMO_STAFF.map(function (s) {
        return { name: s.name, role: s.role, email: DEMO_EMAILS[s.name] || '' };
      });
      $('rosterSheetLabel').textContent = '示範資料';
      renderRoster();
      return;
    }

    const res = await Auth.get('getAdminRoster');
    if (!res.ok) {
      showBanner('error', '⚠ 無法讀取員工名單：' + Auth.describeError(res.error));
      return;
    }
    state.roster = res.roster || [];
    $('rosterSheetLabel').textContent = res.sheetName || '';
    renderRoster();
  }

  async function loadWeek() {
    if (state.loading) return;
    state.loading = true;

    state.days = buildDays(state.weekOffset);
    $('weekLabel').textContent =
      `${fmtMD(state.days[0])}（一）〜 ${fmtMD(state.days[6])}（日）`;

    if (isDemoMode) {
      state.data = {};
      state.days.forEach(function (d, i) {
        const key = ymd(d);
        state.data[key] = {};
        Object.keys(DEMO_PATTERNS).forEach(function (name) {
          state.data[key][name] = DEMO_PATTERNS[name][i];
        });
      });
      state.loading = false;
      renderMatrix();
      return;
    }

    showBanner('ok', '讀取班表中…');
    const res = await Auth.get('getWeek', {
      dates: state.days.map(ymd).join(','),
      view: 'admin',   // 店長は員工でもあるので、管理視角だと明示する
    });
    state.loading = false;

    if (!res.ok) {
      showBanner('error', '⚠ 無法讀取班表：' + Auth.describeError(res.error));
      return;
    }
    if (res.roster && res.roster.length) state.roster = res.roster;
    state.data = res.data || {};

    const missing = state.days.filter(function (d) {
      const cell = state.data[ymd(d)];
      return cell && cell.__error;
    });
    if (missing.length) {
      showBanner('warn', `⚠ 有 ${missing.length} 天所屬的月份分頁尚未建立`);
    } else {
      hideBanner();
    }
    renderMatrix();
    renderRoster();
  }

  /* ---------------- 週次切換 ---------------- */

  $('prevWeek').onclick = function () { state.weekOffset--; loadWeek(); };
  $('nextWeek').onclick = function () { state.weekOffset++; loadWeek(); };
  [...document.querySelectorAll('.quick-btn')].forEach(function (btn) {
    btn.onclick = function () {
      state.weekOffset = Number(btn.dataset.offset);
      loadWeek();
    };
  });

  /* ---------------- 全員班表矩陣 ---------------- */

  function renderMatrix() {
    const table = $('matrixTable');
    table.innerHTML = '';

    const thead = document.createElement('tr');
    thead.innerHTML = `<th class="name-col">員工</th>` +
      state.days.map(function (d) {
        const w = d.getDay();
        const cls = w === 6 ? 'sat' : (w === 0 ? 'sun' : '');
        return `<th class="${cls}">${fmtMD(d)}<br><span class="th-dow">${DOW_ZH[w]}</span></th>`;
      }).join('') +
      `<th class="total-col">時數</th>`;
    table.appendChild(thead);

    let grandMinutes = 0;

    state.roster.forEach(function (person) {
      const tr = document.createElement('tr');
      let cells = `<td class="name-col">${person.name}</td>`;
      let minutes = 0;

      state.days.forEach(function (d) {
        const dayData = state.data[ymd(d)];
        if (!dayData || dayData.__error) { cells += `<td class="na">–</td>`; return; }

        const parsed = parseServerValue(dayData[person.name]);
        if (!parsed) { cells += `<td>　</td>`; return; }
        if (parsed.off) { cells += `<td class="off">休</td>`; return; }

        const mins = toMin(parsed.end) - toMin(parsed.start);
        if (mins > 0) minutes += mins;
        cells += `<td>${parsed.text}</td>`;
      });

      grandMinutes += minutes;
      const hours = Math.round((minutes / 60) * 10) / 10;
      cells += `<td class="total-col">${hours ? hours : '　'}</td>`;
      tr.innerHTML = cells;
      table.appendChild(tr);
    });

    const total = Math.round((grandMinutes / 60) * 10) / 10;
    $('weekStatLabel').textContent = `全店合計 ${total} 小時`;
  }

  /* ---------------- 員工帳號綁定狀態 ---------------- */

  function renderRoster() {
    const box = $('rosterList');
    if (!state.roster.length) { box.innerHTML = ''; return; }

    box.innerHTML = state.roster.map(function (p) {
      const bound = !!p.email;
      return `<div class="roster-row${bound ? '' : ' unbound'}">
        <span class="r-name">${p.name}</span>
        <span class="r-role">${p.role || ''}</span>
        <span class="r-email">${bound ? p.email : '尚未綁定'}</span>
      </div>`;
    }).join('');
  }

  /* ---------------- init ---------------- */
  await boot();
})();
