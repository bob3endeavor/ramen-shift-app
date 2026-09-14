/**
 * Ming Ramen Bar - 排班意願申請 API
 * -----------------------------------------------------------
 * 這支 Apps Script 綁定員工排班試算表（從試算表的「擴充功能 > Apps Script」
 * 建立），提供前端 (frontend/) 讀取/寫入班表資料的 Web App API。
 *
 * 身分驗證：Google Identity Services 的 ID Token（前端登入後取得），
 * 後端以 tokeninfo 端點驗證簽章/有效期/aud，再用 Email 反查員工姓名。
 * 所有寫入一律使用「驗證後反查出來的身分」，不接受前端傳來的姓名。
 *
 * 設定步驟（部署前，三個函式都要各跑一次）：
 * 1. 在試算表開啟 Extensions > Apps Script，貼上這份程式碼（取代預設內容）。
 * 2. 執行 setupNewSpreadsheet()：建立本月與下個月的排班分頁。
 * 3. 執行 setupProperties()：寫入下列三個 Script Properties
 *    （漏跑這一步的話，所有 API 都會回 server_missing_client_id）：
 *    - API_TOKEN        簡易共享密鑰（擋隨機亂打）
 *    - GOOGLE_CLIENT_ID Google Cloud Console 建立的網頁用戶端 ID
 *    - ADMIN_EMAILS     管理員 Email，逗號分隔
 * 4. 部署 > 新增部署作業 > 類型選「網頁應用程式」：
 *    - 執行身分：我 (你的帳號)
 *    - 誰可以存取：任何人 (Anyone) — 身分驗證由 ID Token 負責
 * 5. 把網址與 API_TOKEN、GOOGLE_CLIENT_ID 填進 frontend/js/config.js。
 */

/**
 * 留空 = 使用「這支指令碼所綁定的那個試算表」(container-bound)。
 * 在新試算表裡用「擴充功能 > Apps Script」開啟的話，留空即可，
 * 不需要填 ID。只有在獨立 (standalone) 指令碼想指定外部試算表時才填。
 */
const SPREADSHEET_ID = '';

const STAFF_START_ROW = 3;   // 員工資料從第 3 列開始
const ROLE_COL = 1;          // A 欄 = 職稱
const NAME_COL = 2;          // B 欄 = 姓名
const EMAIL_COL = 3;         // C 欄 = Email（首次登入綁定後寫入）
const MAX_STAFF_ROWS = 200;  // 讀取員工名單時的保險上限

const SHEET_NAME_RE = /排班班表\s*$/;
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo?id_token=';

/* ============================================================
 * Script Properties
 * ========================================================== */

function props_() { return PropertiesService.getScriptProperties(); }

/**
 * 執行一次即可：設定共享密鑰、OAuth 用戶端 ID、管理員名單。
 *
 * 目前只登記了店主一位管理員。之後要加排班管理者（或換 token）時，
 * 直接在「專案設定 > 指令碼屬性」修改即可，不需要重新部署程式碼。
 */
function setupProperties() {
  const values = {
    // 跟 frontend/js/config.js 的 API_TOKEN 必須完全一致
    // （這組本來就會隨 config.js 送到瀏覽器，不算祕密）
    API_TOKEN: 'ming-ramen-wappIHGbTNhHPF8BgToxVz-G',

    // 跟 frontend/js/config.js 的 GOOGLE_CLIENT_ID 必須完全一致
    GOOGLE_CLIENT_ID: '210207629281-288kjvq3qes9651a3udsnojnicqc00f7.apps.googleusercontent.com',

    // ⚠ 管理員 Email 不寫在這裡：這個 repo 是公開的，寫進來會被拿去發垃圾信。
    // 請直接在「專案設定 > 指令碼屬性」新增 ADMIN_EMAILS，
    // 多位管理員用逗號分隔：owner@gmail.com,manager@gmail.com
    ADMIN_EMAILS: 'PASTE_ADMIN_EMAILS_IN_SCRIPT_PROPERTIES',
  };

  // PASTE_ 開頭的預留值不寫入，避免覆蓋掉已經設好的實際值
  const out = {};
  Object.keys(values).forEach(function (k) {
    if (String(values[k]).indexOf('PASTE_') !== 0) out[k] = values[k];
  });
  props_().setProperties(out, false);

  const skipped = Object.keys(values).filter(function (k) { return !(k in out); });
  const msg = '已寫入：' + Object.keys(out).join('、') +
    (skipped.length ? '\n略過（請手動在指令碼屬性設定）：' + skipped.join('、') : '') +
    '\n目前 ADMIN_EMAILS = ' + (props_().getProperty('ADMIN_EMAILS') || '（未設定！）');
  Logger.log(msg);
  return msg;
}

function getToken_() { return props_().getProperty('API_TOKEN') || ''; }
function getClientId_() { return (props_().getProperty('GOOGLE_CLIENT_ID') || '').trim(); }

function getAdminEmails_() {
  const raw = props_().getProperty('ADMIN_EMAILS') || '';
  return raw.split(/[,;\s]+/).map(function (s) { return normEmail_(s); }).filter(Boolean);
}

function normEmail_(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

/* ============================================================
 * 共用工具
 * ========================================================== */

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function toROC_(year) { return year - 1911; }

function parseISO_(s) {
  const parts = String(s).split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function pad2_(n) { return n < 10 ? '0' + n : '' + n; }

/**
 * 同一次執行內重複用同一個 Spreadsheet 物件。
 * SPREADSHEET_ID 留空時用綁定的試算表（container-bound script）。
 */
let __ss = null;
function ss_() {
  if (!__ss) {
    __ss = SPREADSHEET_ID
      ? SpreadsheetApp.openById(SPREADSHEET_ID)
      : SpreadsheetApp.getActiveSpreadsheet();
    if (!__ss) throw new Error('找不到試算表：請確認這支指令碼是從試算表的「擴充功能 > Apps Script」建立的，或填上 SPREADSHEET_ID。');
  }
  return __ss;
}

/** 依 (年, 月) 找出該月的排班分頁，找不到回傳 null */
const __sheetCache = {};
function monthSheet_(year, month) {
  const cacheKey = year + '-' + month;
  if (cacheKey in __sheetCache) return __sheetCache[cacheKey];

  const candidateNames = [
    month + '月排班班表',
    toROC_(year) + '/' + month + '月排班班表',
  ];
  let sheet = null;
  for (let i = 0; i < candidateNames.length; i++) {
    const sh = ss_().getSheetByName(candidateNames[i]);
    if (sh) { sheet = sh; break; }
  }
  __sheetCache[cacheKey] = sheet;
  return sheet;
}

/** 在第 1 列的日期標題找出某一天所在的欄，找不到回傳 -1 */
const __headerCache = {};
function dayColumn_(sheet, day) {
  const name = sheet.getName();
  if (!(name in __headerCache)) {
    __headerCache[name] = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  }
  const headerRow = __headerCache[name];
  for (let i = 0; i < headerRow.length; i++) {
    if (Number(headerRow[i]) === day) return i + 1;
  }
  return -1;
}

/** 依日期字串 (YYYY-MM-DD) 找到對應分頁與欄位 */
function locateDate_(dateStr) {
  const d = parseISO_(dateStr);
  if (isNaN(d.getTime())) return null;

  const sheet = monthSheet_(d.getFullYear(), d.getMonth() + 1);
  if (!sheet) return null;

  const col = dayColumn_(sheet, d.getDate());
  if (col === -1) return null;
  return { sheet: sheet, col: col };
}

/**
 * 讀取某分頁的員工名單（職稱、姓名、Email、所在列）
 * 一次讀 A:C 整塊，遇到第一個空白姓名即停止。
 * 同一次執行內對同一分頁只讀一次（一週 7 天多半落在同一個分頁）。
 */
const __rosterCache = {};
function getRoster_(sheet) {
  const cacheKey = sheet.getName();
  if (cacheKey in __rosterCache) return __rosterCache[cacheKey];
  const roster = readRoster_(sheet);
  __rosterCache[cacheKey] = roster;
  return roster;
}

/** 寫入 Email 後讓快取失效 */
function invalidateRoster_(sheet) {
  delete __rosterCache[sheet.getName()];
}

function readRoster_(sheet) {
  const lastRow = Math.min(sheet.getLastRow(), STAFF_START_ROW + MAX_STAFF_ROWS - 1);
  if (lastRow < STAFF_START_ROW) return [];

  const rows = sheet
    .getRange(STAFF_START_ROW, ROLE_COL, lastRow - STAFF_START_ROW + 1, EMAIL_COL)
    .getValues();

  const roster = [];
  for (let i = 0; i < rows.length; i++) {
    const name = String(rows[i][NAME_COL - 1] || '').trim();
    if (!name) break;
    roster.push({
      row: STAFF_START_ROW + i,
      role: String(rows[i][ROLE_COL - 1] || '').trim(),
      name: name,
      email: normEmail_(rows[i][EMAIL_COL - 1]),
    });
  }
  return roster;
}

/** 所有「○月排班班表」分頁 */
function allMonthSheets_() {
  return ss_().getSheets().filter(function (sh) { return SHEET_NAME_RE.test(sh.getName()); });
}

/** 員工名單的「主分頁」：優先用本月，否則用第一個有資料的排班分頁 */
function rosterSheet_() {
  const now = new Date();
  const current = monthSheet_(now.getFullYear(), now.getMonth() + 1);
  if (current) return current;

  const sheets = allMonthSheets_();
  for (let i = 0; i < sheets.length; i++) {
    const firstName = String(sheets[i].getRange(STAFF_START_ROW, NAME_COL).getValue() || '').trim();
    if (firstName) return sheets[i];
  }
  return sheets.length ? sheets[0] : null;
}

/* ============================================================
 * 新試算表初始化（只在建立新試算表時跑一次）
 * ========================================================== */

/**
 * 建立月份分頁時要寫入的員工名單。[職稱, 姓名]
 * 執行 setupNewSpreadsheet() 前請先改成實際的名單；之後要增減人員，
 * 直接在試算表上編輯 A/B 欄即可，不用再動這段。
 */
const SETUP_STAFF = [
  ['正職', '宮嶋優志\nYUJI'],
  ['內場\n組長', '林暐軒'],
  ['PT', '章芮綺'],
  ['PT', '沈培君'],
  ['PT', '錢玉珍'],
  ['PT', '林欣霈'],
  ['PT', '小羅'],
  ['PT', '德心'],
  ['', 'Jack'],
];

/**
 * 建立新月份分頁時要寫入的名單。
 *
 * **優先沿用現有分頁的名單（連 C 欄 Email 一起帶過去）**，
 * 只有在一個排班分頁都還沒有時，才退回用上面的 SETUP_STAFF。
 *
 * 這件事很重要：人員異動是直接改試算表，不會回頭改 SETUP_STAFF。
 * 如果新分頁一律從 SETUP_STAFF 生成，下個月名單就會倒退回舊的，
 * 而且 Email 欄被清空 —— 全體員工會突然變成「尚未綁定」。
 */
function rosterForNewSheet_() {
  const src = rosterSheet_();
  if (src) {
    const roster = getRoster_(src);
    if (roster.length) {
      return roster.map(function (p) { return [p.role, p.name, p.email]; });
    }
  }
  return SETUP_STAFF.map(function (r) { return [r[0], r[1], '']; });
}

const DOW_ZH_GS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 在目前這個（新的）試算表裡建立「本月」與「下個月」的排班分頁，
 * 版面與既有試算表一致：
 *   第 1 列：A=職稱 B=姓名 C=Email，D 欄之後是日期 1..月底
 *   第 2 列：星期
 *   第 3 列起：員工資料
 *
 * 已存在的同名分頁不會被覆蓋，所以重複執行是安全的。
 * 之後每個月只要再跑一次 addNextMonthSheet() 就會補上新分頁。
 */
function setupNewSpreadsheet() {
  const ss = ss_();
  const now = new Date();
  const created = [];

  [0, 1].forEach(function (offset) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const name = createMonthSheet_(ss, d.getFullYear(), d.getMonth() + 1);
    if (name) created.push(name);
  });

  // 新試算表預設會有一個空的「工作表1」，沒用到就清掉
  const blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && !blank.getRange(1, 1).getValue()) {
    ss.deleteSheet(blank);
  }

  const msg = created.length
    ? '已建立分頁：' + created.join('、')
    : '分頁都已存在，沒有新增任何東西。';
  Logger.log(msg);
  return msg;
}

/**
 * 診斷用：確認這支指令碼實際綁在哪一份試算表、有哪些分頁、名單幾個人。
 * 在編輯器選這個函式按執行，然後看「執行紀錄 (Execution log)」。
 */
function whichSpreadsheet() {
  const ss = ss_();
  const lines = [
    '試算表名稱：' + ss.getName(),
    '擁有者　　：' + (function () {
      try { return ss.getOwner() ? ss.getOwner().getEmail() : '(無法取得)'; }
      catch (err) { return '(無法取得)'; }
    })(),
    '網址　　　：' + ss.getUrl(),
    '所有分頁　：' + ss.getSheets().map(function (s) { return s.getName(); }).join('、'),
  ];

  const monthSheets = allMonthSheets_();
  lines.push('排班分頁　：' + (monthSheets.length
    ? monthSheets.map(function (s) { return s.getName(); }).join('、')
    : '（一個都沒有！請先執行 setupNewSpreadsheet）'));

  const rs = monthSheets.length ? rosterSheet_() : null;
  if (rs) {
    const roster = getRoster_(rs);
    lines.push('名單分頁　：' + rs.getName() + '（' + roster.length + ' 人）');
    lines.push('已綁定帳號：' + (roster.filter(function (p) { return p.email; }).length) + ' 人');
  }

  const p = props_();
  lines.push('--- Script Properties ---');
  lines.push('API_TOKEN　　　 ：' + (p.getProperty('API_TOKEN') ? '已設定' : '（未設定！）'));
  lines.push('GOOGLE_CLIENT_ID：' + (p.getProperty('GOOGLE_CLIENT_ID') ? '已設定' : '（未設定！）'));
  lines.push('ADMIN_EMAILS　　：' + (p.getProperty('ADMIN_EMAILS') || '（未設定！）'));

  const out = lines.join('\n');
  Logger.log(out);
  return out;
}

/** 補建「下個月」的分頁（每個月底跑一次） */
function addNextMonthSheet() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const name = createMonthSheet_(ss_(), d.getFullYear(), d.getMonth() + 1);
  const msg = name ? '已建立分頁：' + name : '分頁已存在，未變更。';
  Logger.log(msg);
  return msg;
}

/** 建立單一月份分頁；已存在則回傳 null（不覆蓋既有資料） */
function createMonthSheet_(ss, year, month) {
  const name = month + '月排班班表';
  if (ss.getSheetByName(name)) return null;

  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDataCol = EMAIL_COL + 1;            // D 欄
  const lastCol = EMAIL_COL + daysInMonth;
  const sheet = ss.insertSheet(name);

  // 這個月份先前被查過（當時還不存在，快取成 null），建立後要讓快取失效
  delete __sheetCache[year + '-' + month];
  delete __headerCache[name];
  delete __rosterCache[name];

  // --- 第 1 列：欄位標題 + 日期 ---
  sheet.getRange(1, ROLE_COL).setValue('職稱');
  sheet.getRange(1, NAME_COL).setValue('姓名');
  sheet.getRange(1, EMAIL_COL).setValue('Email');

  const dayNums = [];
  const dayNames = [];
  for (let day = 1; day <= daysInMonth; day++) {
    dayNums.push(day);
    dayNames.push(DOW_ZH_GS[new Date(year, month - 1, day).getDay()]);
  }
  sheet.getRange(1, firstDataCol, 1, daysInMonth).setValues([dayNums]);
  sheet.getRange(2, firstDataCol, 1, daysInMonth).setValues([dayNames]);
  sheet.getRange(2, ROLE_COL).setValue(year + ' 年 ' + month + ' 月');

  // --- 第 3 列起：員工名單（沿用現有分頁，含 C 欄 Email）---
  const staff = rosterForNewSheet_();
  if (staff.length) {
    sheet.getRange(STAFF_START_ROW, ROLE_COL, staff.length, EMAIL_COL)
      .setValues(staff);
  }
  // rosterForNewSheet_() が「まだ空のこの分頁」を読んで空の名單を
  // キャッシュしているので、書き込んだ後に必ず捨てる
  invalidateRoster_(sheet);

  // --- 版面 ---
  const lastRow = STAFF_START_ROW + Math.max(staff.length, 1) - 1;
  sheet.getRange(1, 1, 2, lastCol)
    .setFontWeight('bold')
    .setBackground('#f0ece1')
    .setHorizontalAlignment('center');
  sheet.getRange(1, ROLE_COL, 2, EMAIL_COL).setHorizontalAlignment('left');
  sheet.getRange(1, 1, lastRow, lastCol)
    .setVerticalAlignment('middle')
    .setFontSize(10);
  sheet.getRange(STAFF_START_ROW, firstDataCol, lastRow - STAFF_START_ROW + 1, daysInMonth)
    .setHorizontalAlignment('center')
    .setWrap(true);

  // 週末上色，一眼看得出來
  for (let i = 0; i < daysInMonth; i++) {
    const w = new Date(year, month - 1, i + 1).getDay();
    if (w === 0 || w === 6) {
      sheet.getRange(1, firstDataCol + i, lastRow, 1)
        .setBackground(w === 0 ? '#fdeaea' : '#eaf1fb');
    }
  }
  sheet.getRange(1, firstDataCol, 2, daysInMonth).setBackground('#f0ece1');

  sheet.setColumnWidth(ROLE_COL, 88);
  sheet.setColumnWidth(NAME_COL, 92);
  sheet.setColumnWidth(EMAIL_COL, 190);
  for (let c = firstDataCol; c <= lastCol; c++) sheet.setColumnWidth(c, 62);
  sheet.setRowHeights(STAFF_START_ROW, lastRow - STAFF_START_ROW + 1, 38);

  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(EMAIL_COL);

  // 多餘的空白欄刪掉，避免 getLastColumn() 抓到奇怪的範圍
  const maxCols = sheet.getMaxColumns();
  if (maxCols > lastCol) sheet.deleteColumns(lastCol + 1, maxCols - lastCol);

  return name;
}

/* ============================================================
 * 身分驗證
 * ========================================================== */

/**
 * 驗證 Google ID Token，回傳 { ok:true, email } 或 { ok:false, error }。
 * 驗證結果會短暫快取，同一次登入內多支 API 不必重打 tokeninfo。
 */
function verifyIdToken_(idToken) {
  if (!idToken) return { ok: false, error: 'missing_id_token' };

  const clientId = getClientId_();
  if (!clientId || clientId.indexOf('PASTE_') === 0) {
    return { ok: false, error: 'server_missing_client_id' };
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)
  );
  const cached = cache.get(cacheKey);
  if (cached) return { ok: true, email: cached };

  let info;
  try {
    const res = UrlFetchApp.fetch(TOKENINFO_URL + encodeURIComponent(idToken), {
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) return { ok: false, error: 'invalid_token' };
    info = JSON.parse(res.getContentText());
  } catch (err) {
    return { ok: false, error: 'token_verify_failed' };
  }

  if (!info || info.error) return { ok: false, error: 'invalid_token' };
  if (info.aud !== clientId) return { ok: false, error: 'token_audience_mismatch' };

  const exp = Number(info.exp || 0) * 1000;
  if (!exp || exp <= Date.now()) return { ok: false, error: 'token_expired' };

  if (info.email_verified !== true && String(info.email_verified) !== 'true') {
    return { ok: false, error: 'email_not_verified' };
  }

  const email = normEmail_(info.email);
  if (!email) return { ok: false, error: 'no_email_in_token' };

  const ttl = Math.min(300, Math.floor((exp - Date.now()) / 1000) - 30);
  if (ttl > 0) cache.put(cacheKey, email, ttl);

  return { ok: true, email: email };
}

/**
 * 驗證 token 並反查身分。
 * { ok:true, email, role:'admin'|'employee'|'unregistered', name, roleTitle, row }
 */
function resolveIdentity_(idToken) {
  const v = verifyIdToken_(idToken);
  if (!v.ok) return { ok: false, error: v.error };

  const email = v.email;

  // 管理員完全依 ADMIN_EMAILS 判斷，不看前端傳來的任何欄位
  if (getAdminEmails_().indexOf(email) !== -1) {
    return { ok: true, email: email, role: 'admin', name: '', roleTitle: '管理員' };
  }

  const sheet = rosterSheet_();
  if (!sheet) return { ok: false, error: 'roster_sheet_not_found' };

  const roster = getRoster_(sheet);
  const me = roster.find(function (p) { return p.email && p.email === email; });

  if (!me) {
    return {
      ok: true,
      email: email,
      role: 'unregistered',
      name: '',
      unboundRoster: roster
        .filter(function (p) { return !p.email; })
        .map(function (p) { return { name: p.name, role: p.role }; }),
    };
  }

  return {
    ok: true,
    email: email,
    role: 'employee',
    name: me.name,
    roleTitle: me.role,
    row: me.row,
  };
}

/** 共享密鑰檢查：只有在 Script Properties 有設定時才強制 */
function checkSharedToken_(provided) {
  const expected = getToken_();
  if (!expected) return true;
  return provided === expected;
}

/* ============================================================
 * 班別 / 時數解析
 * ========================================================== */

/** 把儲存格文字解析成 { off, start, end, text } 或 null */
function parseShiftCell_(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return null;
  if (t.indexOf('排休') === 0 || /day\s*off/i.test(t)) {
    return { off: true, start: '', end: '', text: '排休' };
  }
  const times = t.match(/\d{1,2}:\d{2}/g);
  if (times && times.length >= 2) {
    const start = normTime_(times[0]);
    const end = normTime_(times[1]);
    return { off: false, start: start, end: end, text: start + ' ' + end };
  }
  return null;
}

function normTime_(s) {
  const parts = String(s).split(':').map(Number);
  return pad2_(parts[0]) + ':' + pad2_(parts[1]);
}

function toMin_(s) {
  const parts = String(s).split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

/** 班別長度（分鐘）；排休/空白為 0 */
function shiftMinutes_(shift) {
  if (!shift || shift.off) return 0;
  const mins = toMin_(shift.end) - toMin_(shift.start);
  return mins > 0 ? mins : 0;
}

function rangesOverlap_(a, b) { return a[0] < b[1] && b[0] < a[1]; }

function round1_(n) { return Math.round(n * 10) / 10; }

/* ============================================================
 * doGet
 * ========================================================== */

/**
 * GET /exec?action=ping
 * GET /exec?action=whoami&id_token=...&token=...
 * GET /exec?action=getWeek&dates=2026-08-31,...&id_token=...&token=...
 * GET /exec?action=getMonthHours&id_token=...&token=...[&nextWeekDates=...]
 * GET /exec?action=getAdminRoster&id_token=...&token=...
 */
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = p.action || 'ping';

    if (action === 'ping') {
      return jsonOut_({ ok: true, message: 'Ming Ramen Bar Shift API is running' });
    }

    if (!checkSharedToken_(p.token)) {
      return jsonOut_({ ok: false, error: 'unauthorized' });
    }

    const who = resolveIdentity_(p.id_token);
    if (!who.ok) return jsonOut_({ ok: false, error: who.error });

    if (action === 'whoami') return handleWhoami_(who);
    if (action === 'getWeek') return handleGetWeek_(who, p);
    if (action === 'getMonthHours') return handleGetMonthHours_(who, p);
    if (action === 'getAdminRoster') return handleGetAdminRoster_(who);

    return jsonOut_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function handleWhoami_(who) {
  const out = { ok: true, role: who.role, email: who.email, name: who.name || '' };
  if (who.role === 'employee') out.roleTitle = who.roleTitle || '';
  if (who.role === 'unregistered') out.unboundRoster = who.unboundRoster || [];
  return jsonOut_(out);
}

/**
 * 一般員工：只回自己那一列，外加「與自己重疊的同事（姓名＋時段）」。
 * 管理員：回傳全員完整班表（唯讀）。
 */
function handleGetWeek_(who, p) {
  if (who.role === 'unregistered') return jsonOut_({ ok: false, error: 'not_registered' });

  const datesParam = p.dates;
  if (!datesParam) return jsonOut_({ ok: false, error: 'missing dates' });
  const dates = datesParam.split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  if (who.role === 'admin') return adminWeek_(dates);
  return employeeWeek_(who, dates);
}

function adminWeek_(dates) {
  const result = {};
  // 一週可能跨兩個月份分頁，各分頁的名單長度未必相同，逐日各自取名單
  const seen = {};
  const merged = [];

  dates.forEach(function (dateStr) {
    const loc = locateDate_(dateStr);
    if (!loc) { result[dateStr] = { __error: 'sheet_or_date_not_found' }; return; }

    const roster = getRoster_(loc.sheet);
    if (!roster.length) { result[dateStr] = {}; return; }

    const colValues = loc.sheet
      .getRange(STAFF_START_ROW, loc.col, roster.length, 1)
      .getDisplayValues();

    const dayData = {};
    roster.forEach(function (person, i) {
      dayData[person.name] = colValues[i][0] || '';
      if (!seen[person.name]) {
        seen[person.name] = true;
        merged.push({ name: person.name, role: person.role, email: person.email });
      }
    });
    result[dateStr] = dayData;
  });

  return jsonOut_({ ok: true, role: 'admin', roster: merged, data: result });
}

function employeeWeek_(who, dates) {
  const mine = {};
  const overlaps = {};
  const errors = {};

  dates.forEach(function (dateStr) {
    const loc = locateDate_(dateStr);
    if (!loc) { errors[dateStr] = 'sheet_or_date_not_found'; mine[dateStr] = ''; return; }

    const roster = getRoster_(loc.sheet);
    if (!roster.length) { mine[dateStr] = ''; return; }

    const colValues = loc.sheet
      .getRange(STAFF_START_ROW, loc.col, roster.length, 1)
      .getDisplayValues();

    let meIndex = -1;
    for (let i = 0; i < roster.length; i++) {
      if (roster[i].name === who.name) { meIndex = i; break; }
    }
    const myRaw = meIndex === -1 ? '' : (colValues[meIndex][0] || '');
    mine[dateStr] = myRaw;

    const myShift = parseShiftCell_(myRaw);
    if (!myShift || myShift.off) return;

    // 只回傳「與我重疊」的同事姓名與時段，不回傳其他人的完整班表
    const myRange = [toMin_(myShift.start), toMin_(myShift.end)];
    const matches = [];
    roster.forEach(function (person, i) {
      if (person.name === who.name) return;
      const shift = parseShiftCell_(colValues[i][0]);
      if (!shift || shift.off) return;
      if (rangesOverlap_(myRange, [toMin_(shift.start), toMin_(shift.end)])) {
        matches.push({ name: person.name, role: person.role, text: shift.text });
      }
    });
    if (matches.length) overlaps[dateStr] = matches;
  });

  return jsonOut_({
    ok: true,
    role: 'employee',
    me: { name: who.name, role: who.roleTitle || '' },
    mine: mine,
    overlaps: overlaps,
    errors: errors,
  });
}

/**
 * 本月「至今」已排定的總時數（排休不計）。
 * 可另帶 nextWeekDates=YYYY-MM-DD,... 一併算出「下週希望排班」小計。
 */
function handleGetMonthHours_(who, p) {
  if (who.role !== 'employee') return jsonOut_({ ok: false, error: 'employee_only' });

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const today = now.getDate();

  const out = {
    ok: true,
    month: year + '-' + pad2_(month),
    throughDay: today,
    minutes: 0,
    hours: 0,
    days: 0,
    offDays: 0,
  };

  const sheet = monthSheet_(year, month);
  if (!sheet) {
    out.note = 'month_sheet_not_found';
  } else {
    const me = getRoster_(sheet).find(function (pp) { return pp.name === who.name; });
    if (!me) {
      out.note = 'staff_not_found_in_month_sheet';
    } else {
      const lastCol = sheet.getLastColumn();
      const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
      const rowValues = sheet.getRange(me.row, 1, 1, lastCol).getDisplayValues()[0];

      for (let i = 0; i < header.length; i++) {
        const day = Number(header[i]);
        if (!day || day < 1 || day > today) continue;
        const shift = parseShiftCell_(rowValues[i]);
        if (!shift) continue;
        if (shift.off) { out.offDays++; continue; }
        const mins = shiftMinutes_(shift);
        if (mins > 0) { out.minutes += mins; out.days++; }
      }
    }
  }
  out.hours = round1_(out.minutes / 60);

  if (p.nextWeekDates) {
    out.nextWeek = weekSubtotal_(who, p.nextWeekDates.split(','));
  }
  return jsonOut_(out);
}

/** 指定日期清單的時數小計（跨月份分頁也能加總） */
function weekSubtotal_(who, dates) {
  let minutes = 0, days = 0, offDays = 0, missing = 0;

  dates.map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (dateStr) {
    const loc = locateDate_(dateStr);
    if (!loc) { missing++; return; }
    const me = getRoster_(loc.sheet).find(function (pp) { return pp.name === who.name; });
    if (!me) { missing++; return; }

    const shift = parseShiftCell_(loc.sheet.getRange(me.row, loc.col).getDisplayValue());
    if (!shift) return;
    if (shift.off) { offDays++; return; }

    const mins = shiftMinutes_(shift);
    if (mins > 0) { minutes += mins; days++; }
  });

  return {
    minutes: minutes,
    hours: round1_(minutes / 60),
    days: days,
    offDays: offDays,
    missingDates: missing,
  };
}

/** 管理員專用：全員姓名、職稱、Email */
function handleGetAdminRoster_(who) {
  if (who.role !== 'admin') return jsonOut_({ ok: false, error: 'admin_only' });

  const sheet = rosterSheet_();
  if (!sheet) return jsonOut_({ ok: false, error: 'roster_sheet_not_found' });

  return jsonOut_({
    ok: true,
    sheetName: sheet.getName(),
    roster: getRoster_(sheet).map(function (p) {
      return { name: p.name, role: p.role, email: p.email };
    }),
  });
}

/* ============================================================
 * doPost
 * ========================================================== */

/**
 * POST body (text/plain, JSON-encoded to avoid CORS preflight):
 *
 * 首次登入綁定：
 *   { token, id_token, action:'linkAccount', name:'林欣霈' }
 *
 * 送出排班（姓名由 id_token 反查，不接受前端指定）：
 *   { token, id_token, action:'submitShift', date:'2026-09-01', off:false, start:'10:30', end:'15:30' }
 *   排休:   { ..., off:true }
 *   清除:   { ..., clear:true }
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (!checkSharedToken_(body.token)) {
      return jsonOut_({ ok: false, error: 'unauthorized' });
    }

    const who = resolveIdentity_(body.id_token);
    if (!who.ok) return jsonOut_({ ok: false, error: who.error });

    const action = body.action || 'submitShift';
    if (action === 'linkAccount') return handleLinkAccount_(who, body);
    if (action === 'submitShift') return handleSubmitShift_(who, body);

    return jsonOut_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/** 首次登入：把 (姓名, Email) 寫進對照表，之後永久對應 */
function handleLinkAccount_(who, body) {
  if (who.role === 'admin') return jsonOut_({ ok: false, error: 'admin_cannot_link' });
  if (who.role === 'employee') {
    return jsonOut_({ ok: false, error: 'already_linked', name: who.name });
  }

  const name = String(body.name || '').trim();
  if (!name) return jsonOut_({ ok: false, error: 'missing name' });

  const sheet = rosterSheet_();
  if (!sheet) return jsonOut_({ ok: false, error: 'roster_sheet_not_found' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonOut_({ ok: false, error: 'busy_try_again' });
  try {
    const roster = getRoster_(sheet);

    if (roster.some(function (p) { return p.email === who.email; })) {
      return jsonOut_({ ok: false, error: 'email_already_linked' });
    }
    const target = roster.find(function (p) { return p.name === name; });
    if (!target) return jsonOut_({ ok: false, error: 'staff_not_found' });
    if (target.email) return jsonOut_({ ok: false, error: 'name_already_linked' });

    // 每個月分頁都有自己的名單，全部寫入以保持一致
    let written = 0;
    allMonthSheets_().forEach(function (sh) {
      const r = getRoster_(sh).find(function (p) { return p.name === name; });
      if (!r || r.email) return;
      sh.getRange(r.row, EMAIL_COL).setValue(who.email);
      invalidateRoster_(sh);
      written++;
    });
    SpreadsheetApp.flush();

    return jsonOut_({ ok: true, name: name, roleTitle: target.role, sheetsWritten: written });
  } finally {
    lock.releaseLock();
  }
}

/** 送出排班：姓名一律由驗證後的 Email 反查，不看前端傳來的 name */
function handleSubmitShift_(who, body) {
  if (who.role === 'admin') return jsonOut_({ ok: false, error: 'admin_is_read_only' });
  if (who.role !== 'employee') return jsonOut_({ ok: false, error: 'not_registered' });
  if (!body.date) return jsonOut_({ ok: false, error: 'missing date' });

  const loc = locateDate_(body.date);
  if (!loc) return jsonOut_({ ok: false, error: 'sheet_or_date_not_found' });

  const person = getRoster_(loc.sheet).find(function (p) { return p.name === who.name; });
  if (!person) return jsonOut_({ ok: false, error: 'staff_not_found' });

  let value;
  if (body.clear) {
    value = '';
  } else if (body.off) {
    value = '排休\nday off';
  } else {
    if (!body.start || !body.end) return jsonOut_({ ok: false, error: 'missing start/end' });
    if (toMin_(body.end) <= toMin_(body.start)) {
      return jsonOut_({ ok: false, error: 'end_before_start' });
    }
    value = body.start + '\n' + body.end;
  }

  loc.sheet.getRange(person.row, loc.col).setValue(value);
  return jsonOut_({ ok: true, name: who.name });
}
