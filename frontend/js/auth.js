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
  };

  const state = {
    idToken: null,
    profile: null,     // { role, email, name, roleTitle, unboundRoster }
    onAuthLost: null,  // 憑證失效時呼叫
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

  /** GET {API_URL}?action=...&id_token=...&token=... */
  async function get(action, params) {
    if (!isConfigured) return { ok: false, error: 'not_configured' };

    const qs = new URLSearchParams(Object.assign({
      action: action,
      token: CONFIG.API_TOKEN,
      id_token: state.idToken || '',
    }, params || {}));

    let json;
    try {
      const res = await fetch(CONFIG.API_URL + '?' + qs.toString());
      json = await res.json();
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
    if (!json.ok && isAuthError(json.error)) loseAuth(json.error);
    return json;
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
        }, payload)),
      });
      json = await res.json();
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
    if (!json.ok && isAuthError(json.error)) loseAuth(json.error);
    return json;
  }

  /** 登入後向後端確認身分，結果存在 Auth.profile */
  async function whoami() {
    const res = await get('whoami');
    if (res.ok) state.profile = res;
    return res;
  }

  return {
    get state() { return state; },
    get idToken() { return state.idToken; },
    get profile() { return state.profile; },
    set onAuthLost(fn) { state.onAuthLost = fn; },
    signIn: signIn,
    signOut: signOut,
    whoami: whoami,
    get: get,
    post: post,
    describeError: describeError,
    isAuthError: isAuthError,
  };
})();
