/**
 * Ming Ramen Bar - Google 登入與 API 呼叫的共用模組
 * -----------------------------------------------------------
 * index.html（員工）與 admin.html（管理員）都載入這支。
 * 依賴 config.js (CONFIG / isConfigured / isAuthConfigured)，
 * 以及 Google Identity Services: https://accounts.google.com/gsi/client
 *
 * 前端只負責取得 ID Token 並附在每次請求上；「你是誰、能做什麼」
 * 一律由 Apps Script 驗證 token 後決定，前端不自行宣稱身分。
 */
const Auth = (function () {
  const AUTH_ERRORS = [
    'missing_id_token',
    'invalid_token',
    'token_expired',
    'token_audience_mismatch',
    'email_not_verified',
    'no_email_in_token',
    'token_verify_failed',
  ];

  const ERROR_TEXT = {
    missing_id_token: '尚未登入，請重新使用 Google 帳號登入。',
    invalid_token: '登入憑證無效，請重新登入。',
    token_expired: '登入已逾時，請重新登入。',
    token_audience_mismatch: '登入設定不符（OAuth 用戶端 ID 對不上），請聯絡管理員。',
    email_not_verified: '這個 Google 帳號的 Email 尚未驗證，無法使用。',
    server_missing_client_id: '後端尚未設定 GOOGLE_CLIENT_ID，請聯絡管理員。',
    token_verify_failed: '無法驗證登入憑證，請稍後再試。',
    unauthorized: 'API 密鑰不符，請檢查 config.js 的 API_TOKEN。',
    not_registered: '這個帳號還沒綁定員工姓名。',
    admin_only: '這個頁面僅限管理員使用。',
    employee_only: '這項功能僅限員工本人使用。',
    admin_is_read_only: '管理員帳號為唯讀，無法代為送出排班。',
    email_already_linked: '這個 Google 帳號已經綁定過其他姓名了。',
    name_already_linked: '這位員工已經被其他 Google 帳號綁定，請聯絡店長。',
    staff_not_found: '在試算表裡找不到這位員工，請聯絡店長。',
    roster_sheet_not_found: '找不到排班分頁，請聯絡店長。',
    sheet_or_date_not_found: '試算表裡還沒有這個日期所屬的月份分頁。',
    end_before_start: '下班時間必須晚於上班時間。',
    busy_try_again: '系統忙碌中，請稍後再試一次。',
    // LINE 催繳提醒
    line_token_missing: '後端還沒設定 LINE 的 Channel access token。',
    line_target_missing: '還不知道要發到哪個 LINE 群組（請先把官方帳號拉進群組，並在群組裡傳「綁定」）。',
    line_request_failed: '連不上 LINE 伺服器，請稍後再試。',
    line_api_400: 'LINE 退回了這則訊息（400）：多半是群組 ID 或 @提及 的對象不正確。',
    line_api_401: 'LINE 的 Channel access token 無效或已過期（401）。',
    line_api_403: 'LINE 拒絕了這次發送（403）：請確認頻道已啟用 Messaging API。',
    line_api_429: '這個月的 LINE 訊息額度已用完（429）。',
    no_month_sheet_for_next_week: '下週所屬的月份分頁還沒建立，無法計算未提出名單。',
    line_login_not_configured: '後端還沒設定 LINE Login，請聯絡店長。',
    admin_line_not_linked: '還沒連結要收通知的 LINE 帳號。',
    webapp_url_unknown: '後端不知道自己的網址，請店長在 Script Properties 補上 WEBAPP_URL。',
    webapp_url_invalid: 'Script Properties 的 WEBAPP_URL 格式不對（要用 script.google.com/macros/s/…/exec，不是在瀏覽器打開後網址列上的 googleusercontent 網址）。',
    bad_weekday: '星期的設定值不正確。',
    bad_hour: '時段的設定值不正確。',
  };

  const state = {
    idToken: null,
    profile: null,     // { role, email, name, roleTitle, unboundRoster }
    onAuthLost: null,  // 憑證失效時呼叫
    // 'google'（既定・管理頁）か 'line'（LIFF の員工頁）。
    // 後端はこの値で「どちらの id_token として検証するか」を決める。
    authKind: 'google',
  };

  /* ---------- ID Token 的暫存 ----------
   * ID Token 只放在 sessionStorage：同一個分頁在 index.html 與 admin.html
   * 之間切換時不用重新登入，分頁一關就消失。
   * Google One Tap 會抑制連續彈出，所以不能指望換頁後自動登入。
   */
  const TOKEN_KEY = 'mrb_id_token';

  function b64urlToUtf8(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
    return new TextDecoder().decode(bytes);
  }

  /** 解析 JWT 的 exp，確認還有 2 分鐘以上才算可用 */
  function isTokenFresh(jwt) {
    try {
      const payload = JSON.parse(b64urlToUtf8(String(jwt).split('.')[1]));
      return Number(payload.exp) * 1000 - Date.now() > 120000;
    } catch (err) {
      return false;
    }
  }

  function storeToken(t) {
    try { sessionStorage.setItem(TOKEN_KEY, t); } catch (err) { /* 無痕模式等情況 */ }
  }
  function clearStoredToken() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (err) { /* 同上 */ }
  }
  function readStoredToken() {
    let raw = null;
    try { raw = sessionStorage.getItem(TOKEN_KEY); } catch (err) { return null; }
    if (!raw || !isTokenFresh(raw)) { clearStoredToken(); return null; }
    return raw;
  }

  function describeError(code) {
    return ERROR_TEXT[code] || code || '未知的錯誤';
  }

  function isAuthError(code) {
    return AUTH_ERRORS.indexOf(code) !== -1;
  }

  /** 等 GSI script 載入完成（最多約 8 秒） */
  function waitForGsi() {
    return new Promise(function (resolve, reject) {
      if (window.google && google.accounts && google.accounts.id) return resolve();
      let waited = 0;
      const timer = setInterval(function () {
        if (window.google && google.accounts && google.accounts.id) {
          clearInterval(timer);
          resolve();
        } else if ((waited += 100) >= 8000) {
          clearInterval(timer);
          reject(new Error('Google 登入元件載入失敗，請檢查網路或改用非無痕視窗。'));
        }
      }, 100);
    });
  }

  /**
   * 渲染 Google 登入按鈕，登入成功後 resolve 出 idToken。
   * buttonEl: 放置按鈕的容器元素
   */
  async function signIn(buttonEl) {
    if (!isAuthConfigured) throw new Error('尚未設定 GOOGLE_CLIENT_ID');

    // 同一個分頁內換頁時直接沿用上次登入的 token，不再彈登入視窗
    const stored = readStoredToken();
    if (stored) {
      state.idToken = stored;
      return stored;
    }

    await waitForGsi();

    return new Promise(function (resolve) {
      google.accounts.id.initialize({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        callback: function (response) {
          state.idToken = response.credential;
          storeToken(response.credential);
          // 拿到憑證後立刻收掉還開著的 One Tap，
          // 不然畫面上會同時留著「One Tap」跟登入按鈕，看起來像要登入兩次
          try { google.accounts.id.cancel(); } catch (err) { /* 沒開著就忽略 */ }
          resolve(response.credential);
        },
        auto_select: true,
        cancel_on_tap_outside: false,
        use_fedcm_for_prompt: true,
      });

      if (buttonEl) {
        buttonEl.innerHTML = '';
        google.accounts.id.renderButton(buttonEl, {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text: 'signin_with',
          locale: 'zh_TW',
          width: 260,
        });
      }
      // 回訪使用者可以直接用 One Tap 免點擊登入
      google.accounts.id.prompt();
    });
  }

  function signOut() {
    state.idToken = null;
    state.profile = null;
    clearStoredToken();
    try {
      // 示範模式下 GSI 從未 initialize，呼叫可能會丟例外
      if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.disableAutoSelect();
      }
    } catch (err) { /* 忽略：登出只是清掉本地狀態 */ }
  }

  /** 憑證失效時統一處理：清掉身分並通知頁面回到登入畫面 */
  function loseAuth(code) {
    state.idToken = null;
    state.profile = null;
    clearStoredToken();
    if (typeof state.onAuthLost === 'function') state.onAuthLost(code);
  }

  /**
   * GET {API_URL}?action=...&id_token=...&token=...
   *
   * Apps Script は冷えていると 10 秒以上かかることがあり、そのあたりで
   * 通信が落ちることがある。読み取りは何度やっても副作用がないので、
   * 通信レベルの失敗（fetch が投げた／JSON が返らない）だけ自動で再試行する。
   * サーバーがエラー内容を返してきた場合は、正しい応答なので再試行しない。
   */
  async function get(action, params) {
    if (!isConfigured) return { ok: false, error: 'not_configured' };

    const qs = new URLSearchParams(Object.assign({
      action: action,
      token: CONFIG.API_TOKEN,
      id_token: state.idToken || '',
      auth: state.authKind,
    }, params || {}));
    const url = CONFIG.API_URL + '?' + qs.toString();

    let lastErr = 'unknown';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise(function (r) { setTimeout(r, attempt * 1200); });
      }
      let json;
      try {
        const res = await fetch(url);
        json = await res.json();
      } catch (err) {
        lastErr = String(err && err.message ? err.message : err);
        continue;   // 通信の失敗 → 再試行
      }
      if (!json.ok && isAuthError(json.error)) loseAuth(json.error);
      return json;  // サーバーが答えた以上、内容が何であれそれが答え
    }
    return { ok: false, error: lastErr };
  }

  /** POST（text/plain 以避開 CORS 預檢） */
  async function post(payload) {
    if (!isConfigured) return { ok: false, error: 'not_configured' };

    let json;
    try {
      const res = await fetch(CONFIG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({
          token: CONFIG.API_TOKEN,
          id_token: state.idToken || '',
          auth: state.authKind,
        }, payload)),
      });
      json = await res.json();
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
    if (!json.ok && isAuthError(json.error)) loseAuth(json.error);
    return json;
  }

  /**
   * bootstrap のように whoami を単独で叩かずに身分が判った場合、
   * 同じ場所に入れておく（前端の他の箇所が Auth.profile を見ているため）。
   */
  function setProfile(p) { state.profile = p; }

  /** 登入後向後端確認身分，結果存在 Auth.profile */
  async function whoami() {
    const res = await get('whoami');
    if (res.ok) state.profile = res;
    return res;
  }

  /**
   * LIFF（員工頁）用：Google ログインの代わりに LINE の id_token を使う。
   * GSI も sessionStorage も経由しない —— トークンの持ち主は LIFF SDK で、
   * 期限切れたら liff.login() でやり直すのが正しい復帰方法だから。
   */
  function useLineToken(idToken) {
    state.authKind = 'line';
    state.idToken = idToken;
    clearStoredToken();
  }

  return {
    get state() { return state; },
    get idToken() { return state.idToken; },
    get profile() { return state.profile; },
    get authKind() { return state.authKind; },
    set onAuthLost(fn) { state.onAuthLost = fn; },
    useLineToken: useLineToken,
    setProfile: setProfile,
    signIn: signIn,
    signOut: signOut,
    whoami: whoami,
    get: get,
    post: post,
    describeError: describeError,
    isAuthError: isAuthError,
  };
})();
