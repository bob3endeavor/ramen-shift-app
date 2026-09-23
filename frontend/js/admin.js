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
    sheetUrl: '',      // 試算表への直リンク（管理員限定で後端から届く）
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
  function hideBanner() {
    syncBanner.className = 'sync-banner';
    syncBanner.onclick = null;
    syncBanner.style.cursor = '';
  }

  /** 失敗時は行き止まりにせず、バナー自体を押して再試行できるようにする */
  function showRetryBanner(text, retryFn) {
    showBanner('error', text + '　👉 點此重試');
    syncBanner.style.cursor = 'pointer';
    syncBanner.onclick = function () {
      hideBanner();
      state.loading = false;
      retryFn();
    };
  }

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
      // isAdmin は後端を更新してから返るフィールド。
      // 後端が古いままでも管理員が締め出されないよう role でも判定する。
      const isAdmin = !!(who.isAdmin || who.role === 'admin');
      if (!isAdmin) {
        hideBanner();
        $('denyEmail').textContent = who.email;
        showOnly(denyGate);
        return;
      }

      state.email = who.email;
      // 員工でもある管理員（店長）には、員工畫面へ戻る導線を出す
      if (who.role === 'employee') $('toStaffLink').style.display = 'inline';
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

    // getWeek（管理視角）は名單も試算表リンクも一緒に返すので、
    // 初期表示はこの 1 本で足りる。呼び出しが減るぶん速く、失敗点も減る。
    await loadWeek();

    // 名單が取れなかったとき（週の分頁が無い）や、sheetName を返さない
    // 古い後端のときだけ、名單を単独で取りにいく
    if (!state.roster.length || !$('rosterSheetLabel').textContent) {
      await loadRoster();
    }

    // 班表より後でよい（失敗しても班表の表示は生かしたい）
    await loadReminder();
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
    setSheetLink(res.sheetUrl || res.spreadsheetUrl);
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
      showRetryBanner('⚠ 無法讀取班表：' + Auth.describeError(res.error), loadWeek);
      return;
    }
    if (res.roster && res.roster.length) state.roster = res.roster;
    state.data = res.data || {};
    if (res.sheetName) $('rosterSheetLabel').textContent = res.sheetName;
    if (res.sheetUrl) setSheetLink(res.sheetUrl);

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

  /** 試算表へのリンクを出す。URL が無ければ（示範模式など）非表示のまま */
  function setSheetLink(url) {
    const row = $('sheetLinkRow');
    const link = $('sheetLink');
    if (!url) { row.style.display = 'none'; return; }
    state.sheetUrl = url;
    link.href = url;
    row.style.display = 'flex';
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

  /* ============================================================
   * LINE 催繳提醒
   * ------------------------------------------------------------
   * 設定值（開關／星期／時段）存在 Script Properties，實際的排程是
   * Apps Script 的時間驅動觸發器。這個面板只是把它包成店長也能改的樣子，
   * 權限一樣由後端的 ADMIN_EMAILS 把關。
   * ========================================================== */

  const WEEKDAY_OPTIONS = [
    { v: 1, label: '星期一' }, { v: 2, label: '星期二' }, { v: 3, label: '星期三' },
    { v: 4, label: '星期四' }, { v: 5, label: '星期五' }, { v: 6, label: '星期六' },
    { v: 7, label: '星期日' },
  ];

  function fillRemindSelects() {
    $('remindWeekday').innerHTML = WEEKDAY_OPTIONS.map(function (o) {
      return `<option value="${o.v}">${o.label}</option>`;
    }).join('');
    let hours = '';
    for (let h = 0; h < 24; h++) hours += `<option value="${h}">${h} 時台</option>`;
    $('remindHour').innerHTML = hours;
  }

  function weekdayLabel(v) {
    const hit = WEEKDAY_OPTIONS.find(function (o) { return o.v === Number(v); });
    return hit ? hit.label : '—';
  }

  function setRemindMsg(kind, text) {
    const el = $('remindMsg');
    el.className = 'remind-msg' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }

  function remindBusy(busy) {
    ['remindSave', 'remindTestBtn'].forEach(function (id) { $(id).disabled = busy; });
  }

  async function loadReminder() {
    fillRemindSelects();

    if (isDemoMode) {
      renderReminder({
        config: { enabled: false, weekday: 5, hour: 12 },
        line: { tokenSet: false, targetSet: false, webhookKeySet: false, webhookUrl: '', linkedCount: 0 },
        // 「可提醒」「無法提醒」が両方出るようにしておく（UIの確認用）
        remindable: [{ name: '林欣霈', remindable: true }, { name: '王小明', remindable: false }],
        preview: { ok: true, count: 2, dates: state.days.map(ymd), targets: [
          { name: '林欣霈', missing: 7 }, { name: '王小明', missing: 2 },
        ] },
      });
      remindBusy(true);
      setRemindMsg('warn', '示範模式：設定不會真的儲存。');
      return;
    }

    const res = await Auth.get('getReminderConfig');
    if (!res.ok) {
      // 後端がまだ古い（この機能を貼っていない）ときは責めずに案内だけ出す
      $('remindStatus').textContent = '尚未啟用';
      $('remindPreview').innerHTML = '';
      $('remindSetup').innerHTML = res.error === 'unknown action'
        ? '後端（Apps Script）還沒更新到含有這個功能的版本。請把 <code>apps-script/Code.gs</code> 重新貼上，並「部署 &gt; 管理部署作業」建立新版本。'
        : '無法讀取提醒設定：' + Auth.describeError(res.error);
      remindBusy(true);
      renderNotify(null);
      return;
    }
    renderReminder(res);
  }

  function renderReminder(res) {
    const cfg = res.config || {};
    const line = res.line || {};

    $('remindEnabled').checked = !!cfg.enabled;
    $('remindWeekday').value = String(cfg.weekday || 5);
    $('remindHour').value = String(cfg.hour == null ? 12 : cfg.hour);

    $('remindStatus').textContent = cfg.enabled
      ? `每${weekdayLabel(cfg.weekday)} ${cfg.hour} 時台`
      : '目前未啟用';

    renderRemindPreview(res.preview, res.remindable || []);
    renderRemindSetup(line, res);
    renderNotify(res.notify);
    remindBusy(false);
  }

  /** 現在の「未提出者」一覧（＝いま送ったら誰が名指しされるか） */
  function renderRemindPreview(preview, remindable) {
    const box = $('remindPreview');
    if (!preview) { box.innerHTML = ''; return; }

    if (!preview.ok && preview.error === 'no_month_sheet_for_next_week') {
      box.innerHTML = `<div class="remind-empty">下週所屬的月份分頁還沒建立，現在無法計算未提出名單。</div>`;
      return;
    }

    const range = preview.dates && preview.dates.length
      ? `${fmtMD(new Date(preview.dates[0] + 'T00:00:00'))}〜${fmtMD(new Date(preview.dates[preview.dates.length - 1] + 'T00:00:00'))}`
      : '下週';

    if (!preview.targets || !preview.targets.length) {
      box.innerHTML = `<div class="remind-empty">✓ ${range} 全員都填完了，這週不會發出提醒。</div>`;
      return;
    }

    const canRemind = {};
    remindable.forEach(function (m) { canRemind[m.name] = m.remindable; });

    // 個別 DM になったので、行ごとにチェックボックスを置く。
    // 「立刻試送」はここで選んだ人にだけ送る（全員に迷惑をかけないため）。
    box.innerHTML = `<div class="remind-preview-head">${range} 尚未填完：${preview.targets.length} 人</div>` +
      preview.targets.map(function (t) {
        const ok = canRemind[t.name];
        return `<label class="remind-row${ok ? '' : ' off'}">
          <input type="checkbox" class="rr-pick" value="${t.name}"${ok ? '' : ' disabled'}>
          <span class="rr-name">${t.name}</span>
          <span class="rr-missing">還有 ${t.missing} 天沒填</span>
          <span class="rr-mention${ok ? ' on' : ''}">${ok ? '可提醒' : '無法提醒'}</span>
        </label>`;
      }).join('') +
      (preview.targets.some(function (t) { return !canRemind[t.name]; })
        ? `<div class="remind-empty">「無法提醒」的人還沒用 LINE 開過排班頁，
            系統不知道要傳給誰。請另外用口頭或群組告知他們開一次。</div>`
        : '');
  }

  /** 試送で選ばれている姓名 */
  function pickedForTest() {
    return [...document.querySelectorAll('#remindPreview .rr-pick:checked')]
      .map(function (el) { return el.value; });
  }

  /** LINE 側のセットアップがどこまで済んでいるかを出す */
  function renderRemindSetup(line, res) {
    // 提醒が個別 DM になったので、必須はトークンだけ。
    // 群組と Webhook は「綁定」指令と群組 ID の記録のために残っている。
    const required = [['Channel access token', line.tokenSet]];
    const done = required.every(function (r) { return r[1]; });
    const rows = required.concat([
      ['LIFF（員工從 LINE 開班表）', !!line.loginReady],
      ['提醒的 LINE 群組（綁定指令用）', line.targetSet],
      ['Webhook 密鑰', line.webhookKeySet],
    ]);

    let html = rows.map(function (r) {
      return `<div class="setup-row"><span>${r[0]}</span><b class="${r[1] ? 'ok' : 'ng'}">${r[1] ? '已設定' : '未設定'}</b></div>`;
    }).join('');

    if (line.webhookUrl) {
      html += `<div class="setup-hint">Webhook URL：<code class="wrap">${line.webhookUrl}</code></div>`;
    }
    // WEBAPP_URL の形が違うと空で返る。LINE Login が 400 になる原因なので明示する
    html += line.callbackUrl
      ? `<div class="setup-hint">LINE Login 的 callback URL：<code class="wrap">${line.callbackUrl}</code></div>`
      : `<div class="setup-hint">⚠ Script Properties 的 <code>WEBAPP_URL</code> 是空的或格式不對，
          LINE Login 會失敗。要填 <code>script.google.com/macros/s/…/exec</code>
          （不是在瀏覽器打開後網址列上的 googleusercontent 網址）。</div>`;
    if (!done) {
      html += `<div class="setup-hint">設定步驟見 <code>docs/LINE-REMINDER.md</code>。Channel access token 設好之後才能打開自動提醒。</div>`;
    } else {
      html += `<div class="setup-hint">
        提醒是一對一私訊，所以沒用過 LIFF 的人收不到（名單上會標「無法提醒」）。目前已連結 ${line.linkedCount || 0} 人。<br>
        ${line.loginReady
          ? '請員工從 LINE 的選單開一次排班頁，開過就會自動連結。'
          : '設定 LINE Login 之後，員工就能在員工頁自己按一顆按鈕完成連結；' +
            '在那之前只能請他們在群組裡傳「綁定 你的姓名」。'}
      </div>`;
    }
    if (res && res.lastSent) {
      html += `<div class="setup-hint">上次送出：${new Date(res.lastSent).toLocaleString()}</div>`;
    }
    $('remindSetup').innerHTML = html;
  }

  $('remindSave').onclick = async function () {
    remindBusy(true);
    setRemindMsg('', '儲存中…');
    const res = await Auth.post({
      action: 'setReminderConfig',
      enabled: $('remindEnabled').checked,
      weekday: Number($('remindWeekday').value),
      hour: Number($('remindHour').value),
    });
    remindBusy(false);

    if (!res.ok) {
      setRemindMsg('error', '⚠ ' + Auth.describeError(res.error));
      return;
    }
    const cfg = res.config || {};
    $('remindStatus').textContent = cfg.enabled
      ? `每${weekdayLabel(cfg.weekday)} ${cfg.hour} 時台`
      : '目前未啟用';
    setRemindMsg('ok', cfg.enabled
      ? `已設定：每${weekdayLabel(cfg.weekday)} ${cfg.hour} 時台自動提醒`
      : '已關閉自動提醒');
  };

  $('remindTestBtn').onclick = async function () {
    // 試送で全員に本物の催促が飛ぶと迷惑なので、勾選した人だけに送る
    const names = pickedForTest();
    if (!names.length) {
      setRemindMsg('warn', '請先在上面的名單勾選 1～2 位當作試送對象。');
      return;
    }
    if (!confirm(`現在就傳提醒給這 ${names.length} 位：\n\n${names.join('\n')}\n\n` +
      '這是真的私訊，不是預覽。要繼續嗎？')) return;

    remindBusy(true);
    setRemindMsg('', '傳送中…');
    const res = await Auth.post({ action: 'sendReminderTest', names: names });
    remindBusy(false);

    if (!res.ok) {
      setRemindMsg('error', '⚠ 傳送失敗：' + Auth.describeError(res.error) +
        (res.detail ? `（${res.detail}）` : ''));
      return;
    }
    if (res.skipped === 'all_submitted') {
      setRemindMsg('ok', '全員都填完了，所以沒有送出訊息。');
    } else {
      // push は「友だちでない相手」にも 200 を返すので、届いたことは保証できない
      setRemindMsg('ok',
        `已傳給 ${(res.sentTo || []).length} 位：${(res.sentTo || []).join('、')}。` +
        `請向對方確認真的有收到 —— 沒加官方帳號好友的話，LINE 不會報錯但訊息不會出現。`);
    }
    await loadReminder();
  };

  /* ============================================================
   * 提交通知（員工が送出したら店主の個人 LINE に届く）
   * ------------------------------------------------------------
   * 宛先は LINE Login で取った店主自身の userId。班表の姓名とは無関係
   * なので、員工の連結とは別枠（Script Properties）で持っている。
   * ========================================================== */

  function setNotifyMsg(kind, text) {
    const el = $('notifyMsg');
    el.className = 'remind-msg' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }

  function renderNotify(notify) {
    const linked = !!(notify && notify.linked);

    $('notifyStatus').textContent = linked ? '已開啟' : '未設定';
    $('notifyState').textContent = linked ? '已連結，會通知到你的 LINE' : '尚未連結';
    $('notifyDesc').textContent = linked && notify.email
      ? `目前的收件帳號：${notify.email}`
      : '員工按下「送出班表」時，用官方帳號通知你的個人 LINE。';
    $('notifyBadge').className = 'line-badge' + (linked ? ' on' : '');
    $('notifyLinkBtn').style.display = linked ? 'none' : 'block';
    $('notifyActions').style.display = linked ? 'flex' : 'none';
  }

  $('notifyLinkBtn').onclick = async function () {
    if (isDemoMode) { setNotifyMsg('warn', '示範模式無法連結 LINE。'); return; }

    const btn = $('notifyLinkBtn');
    btn.disabled = true;
    btn.textContent = '準備中…';
    setNotifyMsg('', '');

    const res = await Auth.get('startLineLink', { kind: 'admin' });
    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = '連結我的 LINE';
      setNotifyMsg('error', '⚠ ' + Auth.describeError(res.error));
      return;
    }
    location.href = res.url;
  };

  $('notifyTestBtn').onclick = async function () {
    if (isDemoMode) return;
    $('notifyTestBtn').disabled = true;
    setNotifyMsg('', '傳送中…');

    const res = await Auth.post({ action: 'testAdminNotify' });
    $('notifyTestBtn').disabled = false;

    if (!res.ok) {
      setNotifyMsg('error', '⚠ ' + Auth.describeError(res.error) +
        (res.detail ? `（${res.detail}）` : ''));
      return;
    }
    // push は「友だちでない相手」にも 200 を返してしまうので、
    // 送れたことではなく「実際に届いたか」を本人に確かめてもらう
    setNotifyMsg('ok', '已送出。請打開 LINE 確認有沒有收到；沒收到的話代表還沒加這個官方帳號為好友。');
  };

  $('notifyUnlinkBtn').onclick = async function () {
    if (isDemoMode) return;
    if (!confirm('解除後就不會再收到員工送出排班的通知。要解除嗎？')) return;

    $('notifyUnlinkBtn').disabled = true;
    const res = await Auth.post({ action: 'unlinkAdminNotify' });
    $('notifyUnlinkBtn').disabled = false;

    if (!res.ok) { setNotifyMsg('error', '⚠ ' + Auth.describeError(res.error)); return; }
    renderNotify({ linked: false });
    setNotifyMsg('ok', '已解除。');
  };

  /* ---------------- init ---------------- */
  await boot();
})();
