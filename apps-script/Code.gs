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
 * 6.（選用）要用 LINE 催繳提醒的話，再執行一次 setupLineReminder()，
 *    然後依 docs/LINE-REMINDER.md 設定 LINE 頻道與 Webhook。
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
  ['正職', '宮嶋優志 YUJI'],
  ['內場組長', '林暐軒'],
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
function resolveIdentity_(idToken, authKind) {
  // 員工は LIFF（LINE）、管理員は Google。入口が 2 つになっただけで、
  // ここを抜けたあとは「姓名」に収束するので下流の handler は共通。
  if (authKind === 'line') return resolveLineIdentity_(idToken);

  const v = verifyIdToken_(idToken);
  if (!v.ok) return { ok: false, error: v.error };

  const email = v.email;

  // 管理員資格是一個「旗標」，不是角色：
  // 店長本人同時也是員工（要排自己的班），所以兩者必須能並存。
  // 完全依 ADMIN_EMAILS 判斷，不看前端傳來的任何欄位。
  const isAdmin = getAdminEmails_().indexOf(email) !== -1;

  const sheet = rosterSheet_();
  if (!sheet) {
    // 名單分頁還沒建立時，純管理員仍然要能登入（才能去管理頁看狀況）
    if (isAdmin) {
      return { ok: true, email: email, isAdmin: true, role: 'admin', name: '', roleTitle: '管理員' };
    }
    return { ok: false, error: 'roster_sheet_not_found' };
  }

  const roster = getRoster_(sheet);
  const me = roster.find(function (p) { return p.email && p.email === email; });

  // 名單裡有這個 Email → 是員工（同時可能也是管理員）
  if (me) {
    return {
      ok: true,
      email: email,
      isAdmin: isAdmin,
      role: 'employee',
      name: me.name,
      roleTitle: me.role,
      row: me.row,
    };
  }

  // 名單裡沒有，但在管理員名單內 → 純管理員（不排自己的班）
  if (isAdmin) {
    return { ok: true, email: email, isAdmin: true, role: 'admin', name: '', roleTitle: '管理員' };
  }

  return {
    ok: true,
    email: email,
    isAdmin: false,
    role: 'unregistered',
    name: '',
    unboundRoster: roster
      .filter(function (p) { return !p.email; })
      .map(function (p) { return { name: p.name, role: p.role }; }),
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
 * LINE 催繳提醒（提醒還沒填希望排班的人）
 * ------------------------------------------------------------
 * 每週固定時間，把「下週（一〜日）還有空格沒填」的人在 LINE 群組裡
 * 點名提醒。送出方式是 Messaging API 的 push（對象＝群組 ID）。
 *
 * 需要的 Script Properties：
 *   LINE_CHANNEL_ACCESS_TOKEN  LINE Developers 的長期 Channel access token
 *   LINE_TARGET_ID             要發送的群組 ID（由 Webhook 自動填入）
 *   LINE_WEBHOOK_KEY           Webhook 網址的密鑰（?line=...）
 *   REMIND_ENABLED / REMIND_WEEKDAY / REMIND_HOUR   排程（管理頁可改）
 *   APP_URL                    員工填寫頁的網址（訊息裡附連結用，可留空）
 *
 * 群組 ID 與「誰是誰」的對照都靠 Webhook 蒐集：把
 *   {網頁應用程式網址}?line={LINE_WEBHOOK_KEY}
 * 設成 LINE 頻道的 Webhook URL，再把官方帳號拉進群組，群組裡任何人打
 *   綁定          → 記住這個群組，並用 LINE 暱稱自動對應員工姓名
 *   綁定 林欣霈   → 指定自己是名單上的哪一位（暱稱對不上時用這個）
 * 對照表存在試算表的「LINE連携」分頁，之後 @提及（mention）就靠它。
 * ========================================================== */

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_LINK_SHEET_NAME = 'LINE連携';
const LINE_LINK_HEADER = ['姓名', 'LINE 暱稱', 'userId', '更新時間'];

/** 預設：週五 12 點台、尚未啟用（要在管理頁打開開關才會排程） */
const REMIND_DEFAULT_WEEKDAY = 5;   // 1=一 … 7=日
const REMIND_DEFAULT_HOUR = 12;

/**
 * 「まだ入っていない」を表す置き字。
 * Apps Script のスクリプト プロパティ画面は**値が空の行を保存できない**ので、
 * 未設定の項目を '' で作ると、他の項目を保存しようとしたときに巻き添えで
 * 弾かれる。そこで空文字ではなくこの値を入れておく。
 * isSet_() が 'PASTE_' 始まりを未設定として扱うので、動作上は空と同じ。
 */
const LINE_UNSET = 'PASTE_AUTO';

function lineToken_() { return (props_().getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '').trim(); }
function lineTargetId_() { return (props_().getProperty('LINE_TARGET_ID') || '').trim(); }
function lineWebhookKey_() { return (props_().getProperty('LINE_WEBHOOK_KEY') || '').trim(); }
function appUrl_() { return (props_().getProperty('APP_URL') || '').trim(); }

/** 真的設定過（而且不是 PASTE_ 佔位字串）才算設定完成 */
function isSet_(v) { return !!v && String(v).indexOf('PASTE_') !== 0; }

/* ------------------------------------------------------------
 * 排程設定
 * ---------------------------------------------------------- */

function reminderConfig_() {
  const p = props_();
  const rawDay = p.getProperty('REMIND_WEEKDAY');
  const rawHour = p.getProperty('REMIND_HOUR');
  const day = rawDay == null || rawDay === '' ? NaN : Number(rawDay);
  const hour = rawHour == null || rawHour === '' ? NaN : Number(rawHour);
  return {
    enabled: p.getProperty('REMIND_ENABLED') === '1',
    weekday: day >= 1 && day <= 7 ? Math.floor(day) : REMIND_DEFAULT_WEEKDAY,
    hour: hour >= 0 && hour <= 23 ? Math.floor(hour) : REMIND_DEFAULT_HOUR,
  };
}

function gasWeekday_(n) {
  const table = [
    null,
    ScriptApp.WeekDay.MONDAY,
    ScriptApp.WeekDay.TUESDAY,
    ScriptApp.WeekDay.WEDNESDAY,
    ScriptApp.WeekDay.THURSDAY,
    ScriptApp.WeekDay.FRIDAY,
    ScriptApp.WeekDay.SATURDAY,
    ScriptApp.WeekDay.SUNDAY,
  ];
  return table[n] || ScriptApp.WeekDay.FRIDAY;
}

/**
 * 依目前設定重建時間驅動觸發器（先刪掉舊的；停用時就只刪不建）。
 * 觸發時間用的是這支指令碼的時區（appsscript.json 的 timeZone）。
 * Apps Script 的每週觸發器只精確到「小時」，實際送出會落在該時段內。
 */
function applyReminderTrigger_() {
  const cfg = reminderConfig_();

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'remindUnsubmitted') ScriptApp.deleteTrigger(t);
  });

  if (cfg.enabled) {
    ScriptApp.newTrigger('remindUnsubmitted')
      .timeBased()
      .onWeekDay(gasWeekday_(cfg.weekday))
      .atHour(cfg.hour)
      .create();
  }
  return cfg;
}

function saveReminderConfig_(next) {
  const cur = reminderConfig_();
  const weekday = Number(next.weekday);
  const hour = Number(next.hour);

  props_().setProperties({
    REMIND_ENABLED: next.enabled ? '1' : '0',
    REMIND_WEEKDAY: String(weekday >= 1 && weekday <= 7 ? Math.floor(weekday) : cur.weekday),
    REMIND_HOUR: String(hour >= 0 && hour <= 23 ? Math.floor(hour) : cur.hour),
  }, false);

  return applyReminderTrigger_();
}

/* ------------------------------------------------------------
 * 「誰還沒填」的判定
 * ---------------------------------------------------------- */

function isoDate_(d) {
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}

/** 下週一〜下週日的 7 個日期（與員工頁 buildDays(1) 的算法一致） */
function nextWeekDates_(base) {
  const today = base ? new Date(base) : new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();                 // 0=日 … 6=六
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + 7);

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(isoDate_(d));
  }
  return dates;
}

/**
 * 指定日期範圍內，每個人各有幾格還空著。
 * 「空白」＝儲存格沒有任何文字；填了「排休」也算已提出。
 * 只要有一天空著就是催繳對象（missing > 0）。
 */
function collectUnsubmitted_(dates) {
  const byName = {};
  const order = [];
  const missingSheets = [];
  let checkedDays = 0;

  dates.forEach(function (dateStr) {
    const loc = locateDate_(dateStr);
    if (!loc) { missingSheets.push(dateStr); return; }

    const roster = getRoster_(loc.sheet);
    if (!roster.length) { missingSheets.push(dateStr); return; }
    checkedDays++;

    const colValues = loc.sheet
      .getRange(STAFF_START_ROW, loc.col, roster.length, 1)
      .getDisplayValues();

    roster.forEach(function (person, i) {
      if (!byName[person.name]) {
        byName[person.name] = { name: person.name, role: person.role, missing: 0, filled: 0 };
        order.push(person.name);
      }
      const text = String(colValues[i][0] == null ? '' : colValues[i][0]).trim();
      if (text) byName[person.name].filled++;
      else byName[person.name].missing++;
    });
  });

  const everyone = order.map(function (name) { return byName[name]; });
  return {
    dates: dates,
    checkedDays: checkedDays,
    missingSheets: missingSheets,
    everyone: everyone,
    targets: everyone.filter(function (p) { return p.missing > 0; }),
  };
}

/* ------------------------------------------------------------
 * LINE userId 對照表（試算表的「LINE連携」分頁）
 * ---------------------------------------------------------- */

function lineLinkSheet_(createIfMissing) {
  let sh = ss_().getSheetByName(LINE_LINK_SHEET_NAME);
  if (!sh && createIfMissing) {
    sh = ss_().insertSheet(LINE_LINK_SHEET_NAME);
    sh.getRange(1, 1, 1, LINE_LINK_HEADER.length)
      .setValues([LINE_LINK_HEADER])
      .setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 120);
    sh.setColumnWidth(2, 160);
    sh.setColumnWidth(3, 300);
    sh.setColumnWidth(4, 160);
  }
  return sh;
}

/** [{ name, displayName, userId, row }]（還沒有分頁就回空陣列） */
function readLineLinks_() {
  const sh = lineLinkSheet_(false);
  if (!sh || sh.getLastRow() < 2) return [];

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getDisplayValues();
  const out = [];
  rows.forEach(function (r, i) {
    const userId = String(r[2] || '').trim();
    if (!userId) return;
    out.push({
      name: String(r[0] || '').trim(),
      displayName: String(r[1] || '').trim(),
      userId: userId,
      row: i + 2,
    });
  });
  return out;
}

/** 以 userId 為主鍵寫入／更新一列；name 給空字串＝「先記起來，姓名待補」 */
function saveLineLink_(userId, displayName, name) {
  const sh = lineLinkSheet_(true);
  const hit = readLineLinks_().find(function (l) { return l.userId === userId; });
  const row = hit ? hit.row : sh.getLastRow() + 1;

  sh.getRange(row, 1, 1, 4).setValues([[
    name || (hit ? hit.name : ''),
    displayName || (hit ? hit.displayName : ''),
    userId,
    Utilities.formatDate(new Date(), ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm'),
  ]]);
  return { row: row, name: name || (hit ? hit.name : '') };
}

/** 姓名 → userId 的查表（姓名欄空白的列會被忽略） */
function lineUserIdMap_() {
  const map = {};
  readLineLinks_().forEach(function (l) {
    if (l.name) map[l.name] = l.userId;
  });
  return map;
}

/* ------------------------------------------------------------
 * 訊息組裝
 * ---------------------------------------------------------- */

function mdLabel_(dateStr) {
  const d = parseISO_(dateStr);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

/** textV2 會把 {} 當成變數語法，純文字要跳脫 */
function escapeTextV2_(s) {
  return String(s == null ? '' : s).replace(/([{}\\])/g, '\\$1');
}

/**
 * 回傳 { messages, previewText, mentioned }。
 * 對得上 userId 的人用 @提及（textV2 的 substitution），
 * 對不上的人就只寫姓名，不會因此漏掉任何人。
 */
function buildReminderMessage_(result) {
  const dates = result.dates;
  const range = mdLabel_(dates[0]) + '〜' + mdLabel_(dates[dates.length - 1]);
  const userIds = lineUserIdMap_();

  const substitution = {};
  const lines = [];
  const previewLines = [];
  let mentioned = 0;

  result.targets.forEach(function (p, i) {
    const days = '還有 ' + p.missing + ' 天沒填';
    const uid = userIds[p.name];
    if (uid) {
      const key = 'u' + i;
      substitution[key] = { type: 'mention', mentionee: { type: 'user', userId: uid } };
      lines.push('・{' + key + '}（' + escapeTextV2_(days) + '）');
      mentioned++;
    } else {
      lines.push('・' + escapeTextV2_(p.name) + '（' + escapeTextV2_(days) + '）');
    }
    previewLines.push('・' + p.name + (uid ? ' [@提及]' : '') + '（' + days + '）');
  });

  const head = '🍜 下週（' + range + '）的希望排班還沒填完的人：';
  const tail = ['請在這週內填好；不上班的日子也要選「排休」才算填完。'];
  if (isSet_(appUrl_())) tail.push('👉 ' + appUrl_());

  const body = lines.join('\n');
  const text = head + '\n\n' + body + '\n\n' + tail.join('\n');
  const previewText = head + '\n\n' + previewLines.join('\n') + '\n\n' + tail.join('\n');

  // 跳脫記号を戻した、@提及 なしの版。一人も紐付いていないときの本番用と、
  // 退会者の userId が混ざって textV2 が弾かれたときの再送用を兼ねる。
  const plain = { type: 'text', text: text.replace(/\\([{}\\])/g, '$1') };
  const message = mentioned
    ? { type: 'textV2', text: text, substitution: substitution }
    : plain;

  return {
    messages: [message],
    fallback: [plain],
    previewText: previewText,
    mentioned: mentioned,
  };
}

/* ------------------------------------------------------------
 * LINE API
 * ---------------------------------------------------------- */

function lineApi_(url, payload) {
  const token = lineToken_();
  if (!isSet_(token)) return { ok: false, error: 'line_token_missing' };

  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
  } catch (err) {
    return { ok: false, error: 'line_request_failed', detail: String(err) };
  }

  const code = res.getResponseCode();
  if (code >= 200 && code < 300) return { ok: true };
  return {
    ok: false,
    error: 'line_api_' + code,
    detail: String(res.getContentText() || '').slice(0, 300),
  };
}

function linePush_(messages) {
  const to = lineTargetId_();
  if (!isSet_(to)) return { ok: false, error: 'line_target_missing' };
  return lineApi_(LINE_PUSH_URL, { to: to, messages: messages });
}

function lineReply_(replyToken, text) {
  if (!replyToken) return { ok: false, error: 'missing_reply_token' };
  return lineApi_(LINE_REPLY_URL, {
    replyToken: replyToken,
    messages: [{ type: 'text', text: text }],
  });
}

/* ------------------------------------------------------------
 * 送出（觸發器／管理頁共用）
 * ---------------------------------------------------------- */

/**
 * dryRun=true 時只算出名單與本文，不呼叫 LINE。
 * 全員都填完了就不發訊息（回 skipped:'all_submitted'）。
 */
function runReminder_(dryRun) {
  const dates = nextWeekDates_();
  const result = collectUnsubmitted_(dates);
  const built = buildReminderMessage_(result);

  const out = {
    ok: true,
    dates: dates,
    count: result.targets.length,
    total: result.everyone.length,
    mentioned: built.mentioned,
    missingSheets: result.missingSheets,
    targets: result.targets.map(function (p) {
      return { name: p.name, role: p.role, missing: p.missing };
    }),
    preview: built.previewText,
  };

  if (!result.checkedDays) {
    out.ok = false;
    out.error = 'no_month_sheet_for_next_week';
    return out;
  }
  if (!result.targets.length) {
    out.skipped = 'all_submitted';
    return out;
  }
  if (dryRun) {
    out.dryRun = true;
    return out;
  }

  let sent = linePush_(built.messages);

  // グループを抜けた人の userId が残っていると、@提及 のせいで
  // メッセージごと 400 で弾かれる。催促自体は届けたいので名前だけで再送する。
  if (!sent.ok && sent.error === 'line_api_400' && built.mentioned) {
    const retry = linePush_(built.fallback);
    if (retry.ok) {
      out.mentionFailed = true;
      out.mentioned = 0;
      sent = retry;
    }
  }

  if (!sent.ok) {
    out.ok = false;
    out.error = sent.error;
    out.detail = sent.detail;
    return out;
  }
  out.sent = true;
  props_().setProperty('REMIND_LAST_SENT', new Date().toISOString());
  return out;
}

/** 時間驅動觸發器的進入點（這個函式名被 applyReminderTrigger_ 寫死） */
function remindUnsubmitted() {
  if (!reminderConfig_().enabled) {
    console.log('リマインドは無効（REMIND_ENABLED != 1）なので何もしません');
    return;
  }
  const out = runReminder_(false);
  console.log(JSON.stringify(out));
  if (!out.ok) throw new Error('LINE リマインド失敗: ' + out.error + ' ' + (out.detail || ''));
}

/** 手動確認用：送らずに本文だけログに出す */
function previewReminder() {
  const out = runReminder_(true);
  console.log(out.preview || JSON.stringify(out));
  return out;
}

/** 手動確認用：今すぐ本番送信する */
function sendReminderNow() {
  const out = runReminder_(false);
  console.log(JSON.stringify(out));
  return out;
}

/**
 * 初回セットアップ：LINE 用の Script Properties を作り、権限も承認させる。
 * エディタから 1 回実行して「許可」を押しておくこと。触發器を作る権限
 * （script.scriptapp）が新しく必要になるため、ここを飛ばすと管理頁から
 * 「設定を保存」しても失敗する。
 */
function setupLineReminder() {
  const p = props_();
  const cur = p.getProperties();
  const defaults = {
    LINE_CHANNEL_ACCESS_TOKEN: 'PASTE_LINE_CHANNEL_ACCESS_TOKEN',
    // 空文字にするとプロパティ画面で保存できなくなる（LINE_UNSET を参照）
    LINE_TARGET_ID: LINE_UNSET,
    LINE_WEBHOOK_KEY: Utilities.getUuid().replace(/-/g, ''),
    APP_URL: 'PASTE_YOUR_FRONTEND_URL',
    REMIND_ENABLED: '0',
    REMIND_WEEKDAY: String(REMIND_DEFAULT_WEEKDAY),
    REMIND_HOUR: String(REMIND_DEFAULT_HOUR),
    // LINE Login（員工頁の「連結 LINE 帳號」用）。
    // Messaging API チャネルと**同じプロバイダー**の下に作ること。
    LINE_LOGIN_CHANNEL_ID: 'PASTE_LINE_LOGIN_CHANNEL_ID',
    LINE_LOGIN_CHANNEL_SECRET: 'PASTE_LINE_LOGIN_CHANNEL_SECRET',
    LINE_LINK_STATE_SECRET: Utilities.getUuid().replace(/-/g, ''),
    // 提出通知の宛先（管理頁の「連結我的 LINE」で自動的に入る）
    LINE_ADMIN_USER_ID: LINE_UNSET,
    LINE_ADMIN_EMAIL: LINE_UNSET,
    // 「デプロイを管理」に出ている /exec で終わる URL を入れる。
    // エディタから実行すると getUrl() は /dev しか返せないため、基本的に手入力。
    WEBAPP_URL: 'PASTE_YOUR_EXEC_URL',
  };
  Object.keys(defaults).forEach(function (k) {
    if (!(k in cur)) p.setProperty(k, defaults[k]);
  });

  lineLinkSheet_(true);
  applyReminderTrigger_();   // ここで触發器の権限承認が要求される

  const url = webAppUrl_();
  const key = p.getProperty('LINE_WEBHOOK_KEY');

  if (url) {
    console.log([
      'Messaging API チャネルの Webhook URL に設定する値：',
      url + '?line=' + key,
      '',
      'LINE Login チャネルのコールバック URL に設定する値：',
      url,
    ].join('\n'));
  } else {
    // エディタから実行したときは getUrl() が /dev しか返さないので、
    // そのまま出すと LINE の Webhook 検証が 401 で落ちる。
    console.log([
      '⚠ ウェブアプリの /exec URL を自動取得できませんでした。',
      '（エディタから実行した場合、Apps Script は開発用の /dev URL しか',
      '  返しません。/dev はログインしていないと 401 になるため、LINE には',
      '  絶対に登録しないでください。）',
      '',
      '対処：「デプロイ > デプロイを管理」に表示されている **/exec で終わる URL** を',
      'コピーし、「プロジェクトの設定 > スクリプト プロパティ」の WEBAPP_URL に',
      '貼り付けてから、この関数をもう一度実行してください。',
      '',
      'その URL を {EXEC} とすると、LINE 側に登録する値は：',
      '  Messaging API の Webhook URL     : {EXEC}?line=' + key,
      '  LINE ログインのコールバック URL  : {EXEC}',
    ].join('\n'));
  }

  console.log([
    '',
    '次に「プロジェクトの設定 > スクリプト プロパティ」で',
    'LINE_CHANNEL_ACCESS_TOKEN / APP_URL / LINE_LOGIN_CHANNEL_ID /',
    'LINE_LOGIN_CHANNEL_SECRET を実際の値に置き換えてください。',
  ].join('\n'));
}

/* ------------------------------------------------------------
 * Webhook（群組 ID と userId の収集）
 * ---------------------------------------------------------- */

function textOut_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}

/**
 * LINE からの Webhook。Apps Script は HTTP ヘッダーを読めないので
 * x-line-signature は検証できない。代わりに URL の ?line=... を
 * 合言葉にして、知らない相手をここで弾く。
 */
function handleLineWebhook_(e, body) {
  const key = lineWebhookKey_();
  const given = (e && e.parameter && e.parameter.line) || '';
  if (!isSet_(key) || given !== key) return textOut_('forbidden');

  const events = (body && body.events) || [];
  events.forEach(function (ev) {
    try {
      handleLineEvent_(ev);
    } catch (err) {
      console.error('LINE event error: ' + err);
    }
  });
  return textOut_('ok');   // 検証リクエスト（events 空）にも 200 を返す
}

function handleLineEvent_(ev) {
  const source = (ev && ev.source) || {};

  if (ev.type === 'join' && source.type === 'group') {
    rememberGroup_(source.groupId);
    lineReply_(ev.replyToken, [
      '謝謝邀請！以後忘記填希望排班的人，我會在這個群組提醒。',
      '',
      '想被 @ 點名的話，請在這個群組傳「綁定」兩個字。',
      'LINE 暱稱跟班表姓名不一樣的話，請傳「綁定 林欣霈」這樣加上姓名。',
    ].join('\n'));
    return;
  }

  if (ev.type === 'leave' && source.type === 'group') {
    if (source.groupId === lineTargetId_()) props_().setProperty('LINE_TARGET_ID', LINE_UNSET);
    return;
  }

  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;

  const text = String(ev.message.text || '').trim();
  // 台湾の店舗なので案内は「綁定」に統一。連結/連携 などは旧案内を見た人や
  // 日本語入力の人のための別名（先に長いものを並べて部分一致を防ぐ）。
  const cmd = text.match(/^(綁定|連結|連携|連攜|link)/i);
  if (!cmd) return;   // それ以外の雑談には一切反応しない

  if (source.type === 'group') rememberGroup_(source.groupId);

  const userId = source.userId;
  if (!userId) {
    lineReply_(ev.replyToken, '抱歉，讀不到你的帳號資訊，請稍後再試一次。');
    return;
  }

  // 「綁定 林欣霈」「綁定林欣霈」「綁定：林欣霈」どれでも姓名を取り出せるように、
  // 合図の直後にある区切り記号（全角スペース・コロン・読点など）を落とす
  const rest = text.slice(cmd[0].length).replace(/^[\s:：,，、。.\-－—]+/, '').trim();
  const displayName = lineDisplayName_(source.groupId, userId);
  const rosterSheet = rosterSheet_();
  const names = rosterSheet ? getRoster_(rosterSheet).map(function (p) { return p.name; }) : [];

  let matched = '';
  if (rest) {
    matched = names.indexOf(rest) !== -1 ? rest : '';
    if (!matched) {
      lineReply_(ev.replyToken, '班表上找不到「' + rest + '」這個姓名。\n請照班表上的姓名，傳「綁定 林欣霈」這樣的格式。');
      return;
    }
  } else {
    matched = names.find(function (n) { return n === displayName; })
      || names.find(function (n) { return displayName && displayName.indexOf(n) !== -1; })
      || '';
  }

  saveLineLink_(userId, displayName, matched);

  lineReply_(ev.replyToken, matched
    ? '已經把你設定為「' + matched + '」。以後還沒填班表的時候會直接 @ 你。'
    : '你的 LINE 暱稱「' + (displayName || '?') + '」跟班表上的姓名對不起來。\n請照班表上的姓名，傳「綁定 林欣霈」這樣再試一次。');
}

function rememberGroup_(groupId) {
  if (!groupId) return;
  if (lineTargetId_() !== groupId) props_().setProperty('LINE_TARGET_ID', groupId);
}

/** 群組成員の表示名。取れなければ空文字（@提及 の可否には影響しない） */
function lineDisplayName_(groupId, userId) {
  const token = lineToken_();
  if (!isSet_(token) || !userId) return '';
  const url = groupId
    ? 'https://api.line.me/v2/bot/group/' + encodeURIComponent(groupId) + '/member/' + encodeURIComponent(userId)
    : 'https://api.line.me/v2/bot/profile/' + encodeURIComponent(userId);
  try {
    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) return '';
    return String(JSON.parse(res.getContentText()).displayName || '').trim();
  } catch (err) {
    return '';
  }
}

/* ------------------------------------------------------------
 * 管理頁 API
 * ---------------------------------------------------------- */

/** GET ?action=getReminderConfig（管理員限定） */
function handleGetReminderConfig_(who) {
  if (!who.isAdmin) return jsonOut_({ ok: false, error: 'admin_only' });

  const preview = runReminder_(true);
  const linked = lineUserIdMap_();

  let webhookUrl = '';
  try {
    const base = ScriptApp.getService().getUrl();
    if (base && isSet_(lineWebhookKey_())) webhookUrl = base + '?line=' + lineWebhookKey_();
  } catch (err) { /* 取れなくても致命的ではない */ }

  return jsonOut_({
    ok: true,
    config: reminderConfig_(),
    timeZone: Session.getScriptTimeZone(),
    lastSent: props_().getProperty('REMIND_LAST_SENT') || '',
    line: {
      tokenSet: isSet_(lineToken_()),
      targetSet: isSet_(lineTargetId_()),
      webhookKeySet: isSet_(lineWebhookKey_()),
      webhookUrl: webhookUrl,
      appUrlSet: isSet_(appUrl_()),
      linkedCount: Object.keys(linked).length,
      loginReady: lineLoginReady_(),
      callbackUrl: webAppUrl_(),
    },
    // 提出通知（店主の個人 LINE 宛て）。userId 自体は返さない。
    notify: {
      linked: isSet_(adminNotifyUserId_()),
      email: isSet_(adminNotifyEmail_()) ? adminNotifyEmail_() : '',
      pending: Object.keys(readSubmitPending_()).length,
    },
    // userId そのものは返さない（管理頁に出す必要がない）
    mentionable: (preview.targets || []).map(function (t) {
      return { name: t.name, mentionable: !!linked[t.name] };
    }),
    preview: preview,
  });
}

/** POST { action:'setReminderConfig', enabled, weekday, hour }（管理員限定） */
function handleSetReminderConfig_(who, body) {
  if (!who.isAdmin) return jsonOut_({ ok: false, error: 'admin_only' });

  const weekday = Number(body.weekday);
  const hour = Number(body.hour);
  if (!(weekday >= 1 && weekday <= 7)) return jsonOut_({ ok: false, error: 'bad_weekday' });
  if (!(hour >= 0 && hour <= 23)) return jsonOut_({ ok: false, error: 'bad_hour' });

  const enabled = !!body.enabled;
  if (enabled && !isSet_(lineToken_())) return jsonOut_({ ok: false, error: 'line_token_missing' });
  if (enabled && !isSet_(lineTargetId_())) return jsonOut_({ ok: false, error: 'line_target_missing' });

  return jsonOut_({ ok: true, config: saveReminderConfig_({
    enabled: enabled, weekday: weekday, hour: hour,
  }) });
}

/** POST { action:'sendReminderTest', dryRun }（管理員限定） */
function handleSendReminderTest_(who, body) {
  if (!who.isAdmin) return jsonOut_({ ok: false, error: 'admin_only' });
  return jsonOut_(runReminder_(!!body.dryRun));
}

/* ============================================================
 * LINE Login で「員工 ↔ LINE userId」を確定させる
 * ------------------------------------------------------------
 * 群組で「綁定 姓名」と打ってもらう方式は、LINE の表示名と班表の姓名が
 * 違う人に自分の姓名を正しく入力させる必要があった。こちらは
 *
 *   すでに Google ログイン済み（＝後端が姓名を知っている）本人が
 *   ボタンを押して LINE Login するだけ
 *
 * なので、表示名も手入力も一切関係しない。
 *
 * 成立の鍵：**LINE Login チャネルと Messaging API チャネルを同じ
 * プロバイダーの下に作ること**。userId はプロバイダー単位で発行され、
 * 同じプロバイダーならチャネル種別が違っても同じ値になる。別プロバイダーに
 * 作ると、ここで取れた userId で @提及 しても LINE に弾かれる。
 *
 * 必要な Script Properties：
 *   LINE_LOGIN_CHANNEL_ID      LINE Login チャネルのチャネル ID
 *   LINE_LOGIN_CHANNEL_SECRET  同 チャネルシークレット
 *   LINE_LINK_STATE_SECRET     state 署名用（setupLineReminder が自動生成）
 *   WEBAPP_URL                 コールバック URL（空なら実行中の /exec を使う）
 *
 * 流れ：
 *   員工頁 [連結 LINE 帳號]
 *     → GET ?action=startLineLink        姓名入りの署名付き state を発行
 *     → access.line.me/oauth2/v2.1/authorize
 *     → GET /exec?code=...&state=...     ここで code を id_token に交換し、
 *                                        sub（userId）を「LINE連携」分頁に書く
 * ========================================================== */

const LINE_AUTHORIZE_URL = 'https://access.line.me/oauth2/v2.1/authorize';
const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token';
const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

const LINE_STATE_TTL_MS = 10 * 60 * 1000;   // 10 分で失効

/**
 * ウェブアプリの公開 URL（/exec）の形。Google Workspace 独自ドメインの
 * /a/macros/{ドメイン}/s/{デプロイID}/exec 形式も許す。
 * これ以外（/dev、googleusercontent.com の一時 URL など）は受け付けない。
 */
const EXEC_URL_RE =
  /^https:\/\/script\.google\.com\/(?:macros\/s\/[\w-]+|a\/macros\/[^\/]+\/s\/[\w-]+)\/exec$/;

function lineLoginId_() { return (props_().getProperty('LINE_LOGIN_CHANNEL_ID') || '').trim(); }
function lineLoginSecret_() { return (props_().getProperty('LINE_LOGIN_CHANNEL_SECRET') || '').trim(); }
function lineStateSecret_() { return (props_().getProperty('LINE_LINK_STATE_SECRET') || '').trim(); }

/** LINE Login を使える状態か（管理者が両方入れていれば true） */
function lineLoginReady_() {
  return isSet_(lineLoginId_()) && isSet_(lineLoginSecret_()) && isSet_(lineStateSecret_());
}

/**
 * コールバックに使うウェブアプリの URL。
 * LINE のコンソールに登録した値と 1 文字でも違うと弾かれるので、
 * 認可リクエストとトークン交換の両方でこの関数だけを使う。
 */
function webAppUrl_() {
  const fixed = (props_().getProperty('WEBAPP_URL') || '').trim();
  // 形が違うものは使わない。よくある取り違えは、/exec をブラウザで開いた後の
  // アドレスバー（script.googleusercontent.com/macros/echo?user_content_key=…）。
  // あれは実行結果の一時 URL で、コールバック先にはできない。
  if (isSet_(fixed)) return EXEC_URL_RE.test(fixed) ? fixed : '';

  let url = '';
  try {
    url = ScriptApp.getService().getUrl() || '';
  } catch (err) {
    return '';
  }

  // エディタや時間主導トリガーから呼ぶと、getUrl() は /exec ではなく
  // /dev（開発用 URL）を返す。/dev は開発者本人が Google にログインして
  // いないと 401 を返すので、LINE に渡す URL としては使えない
  // （Webhook 検証が「401 Unauthorized」で落ちるのはこれが原因）。
  // /dev と /exec は ID の種類自体が違う（スクリプト ID と デプロイ ID）ので
  // 文字列を置き換えて変換することもできない。素直に「不明」として扱い、
  // WEBAPP_URL に /exec を入れてもらう。
  return EXEC_URL_RE.test(url) ? url : '';
}

/* ------------------------------------------------------------
 * state（改竄されたら分かるようにした「誰が押したか」の預かり証）
 * ---------------------------------------------------------- */

function b64url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function b64urlDecode_(s) {
  const padded = s + '===='.slice(0, (4 - (s.length % 4)) % 4);
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString();
}

function signState_(payload) {
  const body = b64url_(Utilities.newBlob(JSON.stringify(payload)).getBytes());
  const sig = b64url_(Utilities.computeHmacSha256Signature(body, lineStateSecret_()));
  return body + '.' + sig;
}

/** 署名と有効期限を確認して payload を返す。だめなら null */
function verifyState_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !isSet_(lineStateSecret_())) return null;

  const expect = b64url_(Utilities.computeHmacSha256Signature(parts[0], lineStateSecret_()));
  if (expect !== parts[1]) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode_(parts[0]));
  } catch (err) {
    return null;
  }
  if (!payload || !payload.exp || Number(payload.exp) < Date.now()) return null;
  return payload;
}

/* ------------------------------------------------------------
 * 1. 認可 URL を発行する
 * ---------------------------------------------------------- */

/**
 * GET ?action=startLineLink[&kind=admin]
 *
 * kind 省略 … 員工本人が自分の userId を登録する（@提及 用）
 * kind=admin … 管理員が「提出通知の宛先」として自分の userId を登録する。
 *              こちらは班表の姓名と無関係なので、員工でなくても通す。
 */
function handleStartLineLink_(who, p) {
  const kind = (p && p.kind === 'admin') ? 'admin' : 'employee';

  if (kind === 'admin') {
    if (!who.isAdmin) return jsonOut_({ ok: false, error: 'admin_only' });
  } else if (who.role !== 'employee') {
    return jsonOut_({ ok: false, error: 'employee_only' });
  }
  if (!lineLoginReady_()) return jsonOut_({ ok: false, error: 'line_login_not_configured' });

  const redirectUri = webAppUrl_();
  if (!redirectUri) {
    // 入っているのに弾かれた＝形が違う。原因が分かる別のエラーにする。
    const raw = (props_().getProperty('WEBAPP_URL') || '').trim();
    return jsonOut_({ ok: false, error: isSet_(raw) ? 'webapp_url_invalid' : 'webapp_url_unknown' });
  }

  const nonce = Utilities.getUuid().replace(/-/g, '');
  const state = signState_({
    kind: kind,
    name: who.name,
    email: who.email,
    nonce: nonce,
    exp: Date.now() + LINE_STATE_TTL_MS,
  });

  const url = LINE_AUTHORIZE_URL +
    '?response_type=code' +
    '&client_id=' + encodeURIComponent(lineLoginId_()) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&state=' + encodeURIComponent(state) +
    '&scope=' + encodeURIComponent('openid profile') +
    '&nonce=' + encodeURIComponent(nonce);

  return jsonOut_({ ok: true, url: url });
}

/* ------------------------------------------------------------
 * 2. LINE から戻ってきたところ
 * ---------------------------------------------------------- */

/** GET /exec?code=...&state=...（LINE Login のコールバック） */
function handleLineLinkCallback_(p) {
  if (p.error) {
    return lineLinkPage_(false, '已取消連結',
      'LINE 端取消了授權（' + p.error + '），沒有做任何變更。');
  }

  const st = verifyState_(p.state);
  if (!st) {
    return lineLinkPage_(false, '連結逾時',
      '這個連結畫面已經過期（或網址被改過）。請回到申請頁重新按一次「連結 LINE 帳號」。');
  }
  if (!lineLoginReady_()) {
    return lineLinkPage_(false, '尚未設定', '後端還沒設定 LINE Login 的頻道資訊，請聯絡店長。');
  }

  const token = lineExchangeCode_(p.code);
  if (!token.ok) {
    return lineLinkPage_(false, '連結失敗',
      '向 LINE 換取憑證時失敗（' + token.error + '）。請稍後再試一次。');
  }

  const claims = lineVerifyIdToken_(token.idToken, st.nonce);
  if (!claims.ok) {
    return lineLinkPage_(false, '連結失敗',
      '無法驗證 LINE 的登入憑證（' + claims.error + '）。請重新操作一次。');
  }

  // 管理員が「提出通知の宛先」を登録しにきた場合。班表の姓名とは無関係なので
  // 対照表ではなく Script Properties に入れる。
  if (st.kind === 'admin') {
    props_().setProperties({
      LINE_ADMIN_USER_ID: claims.userId,
      LINE_ADMIN_EMAIL: st.email || '',
    }, false);
    return lineLinkPage_(true, '通知設定完成',
      '員工送出希望排班時，會通知到你的 LINE' +
      (claims.displayName ? '（' + claims.displayName + '）' : '') + '。',
      '請確認你已經把這個官方帳號「加為好友」，否則訊息不會送達。' +
      '加好友之後，回管理頁按「發送測試通知」確認真的收得到。');
  }

  const saved = linkLineUser_(st.name, claims.userId, claims.displayName);
  if (!saved.ok) {
    return lineLinkPage_(false, '連結失敗', '寫入對照表時失敗：' + saved.error);
  }

  // 同じプロバイダー配下でないと userId が噛み合わない。ここで実際に
  // 群組の名簿を引いてみて、駄目なら設定ミスを疑えるようにしておく。
  let warn = '';
  if (isSet_(lineTargetId_()) && isSet_(lineToken_())) {
    if (!lineDisplayName_(lineTargetId_(), claims.userId)) {
      warn = '不過，在提醒用的 LINE 群組裡找不到這個帳號。' +
        '請確認你已經加入那個群組；如果確定有加入，請告訴店長' +
        '「LINE Login 頻道可能跟官方帳號不在同一個 provider 底下」。';
    }
  }

  return lineLinkPage_(true, '連結完成',
    '已經把「' + st.name + '」跟你的 LINE 帳號' +
    (claims.displayName ? '（' + claims.displayName + '）' : '') +
    '對應起來了。之後忘記填班表時，提醒訊息會直接 @ 你。', warn);
}

/** 認可コード → トークン（id_token だけ使う） */
function lineExchangeCode_(code) {
  if (!code) return { ok: false, error: 'missing_code' };

  let res;
  try {
    res = UrlFetchApp.fetch(LINE_TOKEN_URL, {
      method: 'post',
      payload: {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: webAppUrl_(),
        client_id: lineLoginId_(),
        client_secret: lineLoginSecret_(),
      },
      muteHttpExceptions: true,
    });
  } catch (err) {
    return { ok: false, error: 'request_failed' };
  }

  if (res.getResponseCode() !== 200) {
    console.error('LINE token exchange failed: ' + res.getContentText().slice(0, 300));
    return { ok: false, error: 'http_' + res.getResponseCode() };
  }

  let body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (err) {
    return { ok: false, error: 'bad_json' };
  }
  if (!body.id_token) return { ok: false, error: 'no_id_token' };
  return { ok: true, idToken: body.id_token };
}

/**
 * id_token を LINE の verify エンドポイントに投げて検証してもらう。
 * 署名・有効期限・aud（＝自分のチャネル）・nonce をまとめて見てくれるので、
 * こちら側で JWT を自前検証する必要がない。
 */
function lineVerifyIdToken_(idToken, nonce) {
  // nonce は LINE Login（こちらが nonce を仕込んだ場合）だけ照合する。
  // LIFF の id_token には自分で仕込んだ nonce が無いので、渡さない。
  const payload = { id_token: idToken, client_id: lineLoginId_() };
  if (nonce) payload.nonce = nonce;

  let res;
  try {
    res = UrlFetchApp.fetch(LINE_VERIFY_URL, {
      method: 'post',
      payload: payload,
      muteHttpExceptions: true,
    });
  } catch (err) {
    return { ok: false, error: 'request_failed' };
  }

  if (res.getResponseCode() !== 200) {
    console.error('LINE id_token verify failed: ' + res.getContentText().slice(0, 300));
    return { ok: false, error: 'http_' + res.getResponseCode() };
  }

  let claims;
  try {
    claims = JSON.parse(res.getContentText());
  } catch (err) {
    return { ok: false, error: 'bad_json' };
  }
  if (!claims.sub) return { ok: false, error: 'no_sub' };

  return { ok: true, userId: claims.sub, displayName: String(claims.name || '').trim() };
}

/**
 * 姓名 ↔ userId を 1 対 1 に保つ書き込み。
 * 同じ姓名の古い行（機種変更で LINE アカウントが変わった等）と、
 * 同じ userId で別の姓名になっている行を先に消してから書く。
 */
function linkLineUser_(name, userId, displayName) {
  if (!name || !userId) return { ok: false, error: 'missing_name_or_user_id' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, error: 'busy_try_again' };
  try {
    const sh = lineLinkSheet_(true);

    // 下の行から消さないと行番号がずれる
    readLineLinks_()
      .filter(function (l) { return l.name === name && l.userId !== userId; })
      .sort(function (a, b) { return b.row - a.row; })
      .forEach(function (l) { sh.deleteRow(l.row); });

    saveLineLink_(userId, displayName, name);
    SpreadsheetApp.flush();
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** POST { action:'unlinkLine' }（員工本人のみ） */
function handleUnlinkLine_(who) {
  if (who.role !== 'employee') return jsonOut_({ ok: false, error: 'employee_only' });

  const sh = lineLinkSheet_(false);
  if (!sh) return jsonOut_({ ok: true, removed: 0 });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonOut_({ ok: false, error: 'busy_try_again' });
  try {
    const rows = readLineLinks_()
      .filter(function (l) { return l.name === who.name; })
      .sort(function (a, b) { return b.row - a.row; });
    rows.forEach(function (l) { sh.deleteRow(l.row); });
    SpreadsheetApp.flush();
    return jsonOut_({ ok: true, removed: rows.length });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
 * 結果ページ（LINE から戻ってきた人がここに着地する）
 * ---------------------------------------------------------- */

function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lineLinkPage_(ok, title, message, warn) {
  const back = appUrl_();
  const accent = ok ? '#4c7a5e' : '#c7402c';

  const html = [
    '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + escapeHtml_(title) + '</title>',
    '<style>',
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
    'background:#0e1713;font-family:"Noto Sans TC",system-ui,sans-serif;color:#241c14;padding:20px;}',
    '.card{background:#f7f1e3;border-radius:14px;padding:26px 22px;max-width:380px;width:100%;',
    'box-shadow:0 0 40px rgba(0,0,0,.45);text-align:center;}',
    '.mark{font-size:34px;line-height:1;margin-bottom:10px;}',
    'h1{font-size:18px;margin:0 0 12px;color:' + accent + ';}',
    'p{font-size:13px;line-height:1.85;color:#4a4136;margin:0 0 14px;}',
    '.warn{background:#efe6d1;border:1.5px dashed #d9cdb0;border-radius:9px;padding:10px 12px;',
    'font-size:11.5px;line-height:1.7;text-align:left;}',
    'a.btn{display:block;background:#c7402c;color:#f7f1e3;text-decoration:none;font-weight:700;',
    'font-size:14px;padding:13px 20px;border-radius:9px;box-shadow:0 3px 0 #9c2f1f;margin-top:16px;}',
    '</style></head><body><div class="card">',
    '<div class="mark">' + (ok ? '🔗' : '⚠️') + '</div>',
    '<h1>' + escapeHtml_(title) + '</h1>',
    '<p>' + escapeHtml_(message) + '</p>',
    warn ? '<div class="warn">' + escapeHtml_(warn) + '</div>' : '',
    isSet_(back) ? '<a class="btn" href="' + escapeHtml_(back) + '">回到排班申請頁</a>'
                 : '<p>可以關閉這個畫面了。</p>',
    '</div></body></html>',
  ].join('');

  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ============================================================
 * LINE での身分驗證（LIFF から来る id_token）
 * ------------------------------------------------------------
 * Google アカウントを持たない従業員がいるため、員工側の入口を
 * 「LINE のリッチメニュー → LIFF」に移す。LIFF の中では
 * liff.getIDToken() が LINE の ID Token を返すので、それを
 * そのまま API に載せてもらい、ここで検証する。
 *
 * Google 経路との違いは「何で人を特定するか」だけ：
 *   Google … 檢證済み Email → 試算表 C 欄
 *   LINE  … 檢證済み userId → 「LINE連携」分頁
 * 特定できたあとは同じ「姓名」に収束するので、班表の読み書きから
 * 先のロジックは一切変わらない。
 *
 * ⚠ LIFF の id_token の aud は **LINE ログインチャネルのチャネル ID**。
 * つまり LIFF は LINE_LOGIN_CHANNEL_ID と同じチャネルの配下に
 * 作られている必要がある（Messaging API チャネル側に作ると合わない）。
 * ========================================================== */

/**
 * LINE の id_token を検証して userId を返す。
 *
 * 1 回のページ表示で whoami / getWeek / getMonthHours と複数回叩かれるので、
 * Google 側と同じように短時間キャッシュして LINE への問い合わせを減らす。
 */
function verifyLineIdToken_(idToken) {
  if (!idToken) return { ok: false, error: 'missing_id_token' };
  if (!isSet_(lineLoginId_())) return { ok: false, error: 'line_login_not_configured' };

  const cache = CacheService.getScriptCache();
  const cacheKey = 'ltok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)
  );
  const cached = cache.get(cacheKey);
  if (cached) return { ok: true, userId: cached };

  const claims = lineVerifyIdToken_(idToken);   // nonce なしで検証
  if (!claims.ok) {
    // LINE の verify は期限切れも 400 で返す。前端が再取得すべきケースなので
    // Google 側と同じ語彙（token_expired / invalid_token）に寄せておく。
    return { ok: false, error: claims.error === 'http_400' ? 'invalid_token' : 'token_verify_failed' };
  }

  cache.put(cacheKey, claims.userId, 300);
  return { ok: true, userId: claims.userId, displayName: claims.displayName };
}

/** userId → 姓名（「LINE連携」分頁の逆引き）。見つからなければ空文字 */
function lineNameByUserId_(userId) {
  if (!userId) return '';
  const hit = readLineLinks_().find(function (l) { return l.userId === userId; });
  return hit ? hit.name : '';
}

/**
 * LINE 経路の身分解決。返り値の形は resolveIdentity_ と揃えてあるので、
 * 呼び出し側（各 handler）は Google 経路との違いを意識しなくてよい。
 *
 * 管理員にはならない：ADMIN_EMAILS は Email 基準の判定で、LINE には
 * Email が無いため。管理頁は従来どおり Google ログイン専用。
 */
function resolveLineIdentity_(idToken) {
  const v = verifyLineIdToken_(idToken);
  if (!v.ok) return { ok: false, error: v.error };

  const sheet = rosterSheet_();
  if (!sheet) return { ok: false, error: 'roster_sheet_not_found' };

  const roster = getRoster_(sheet);
  const name = lineNameByUserId_(v.userId);
  const me = name ? roster.find(function (p) { return p.name === name; }) : null;

  if (me) {
    return {
      ok: true,
      auth: 'line',
      lineUserId: v.userId,
      email: '',
      isAdmin: false,
      role: 'employee',
      name: me.name,
      roleTitle: me.role,
      row: me.row,
    };
  }

  // 対照表に居ない（＝この LINE アカウントは初めて）。
  // 選択肢は「まだ LINE と紐付いていない姓名」。Email の有無は見ない
  // ので、Google で使っている人が後から LINE を足すこともできる。
  const linked = lineUserIdMap_();
  return {
    ok: true,
    auth: 'line',
    lineUserId: v.userId,
    lineDisplayName: v.displayName || '',
    email: '',
    isAdmin: false,
    role: 'unregistered',
    name: '',
    unboundRoster: roster
      .filter(function (p) { return !linked[p.name]; })
      .map(function (p) { return { name: p.name, role: p.role }; }),
  };
}

/**
 * LINE 経路の初回綁定：選ばれた姓名とこの userId を対照表に書く。
 * Google 経路が C 欄に Email を書くのと同じ役目。
 */
function linkLineAccount_(who, body) {
  const name = String(body.name || '').trim();
  if (!name) return jsonOut_({ ok: false, error: 'missing name' });

  const sheet = rosterSheet_();
  if (!sheet) return jsonOut_({ ok: false, error: 'roster_sheet_not_found' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonOut_({ ok: false, error: 'busy_try_again' });
  try {
    const target = getRoster_(sheet).find(function (p) { return p.name === name; });
    if (!target) return jsonOut_({ ok: false, error: 'staff_not_found' });

    // 先に押さえた人が居たら奪わせない（Google 経路の name_already_linked と同じ）
    const links = readLineLinks_();
    if (links.some(function (l) { return l.name === name && l.userId !== who.lineUserId; })) {
      return jsonOut_({ ok: false, error: 'name_already_linked' });
    }

    const saved = linkLineUser_(name, who.lineUserId, who.lineDisplayName || '');
    if (!saved.ok) return jsonOut_({ ok: false, error: saved.error });

    return jsonOut_({ ok: true, name: name, roleTitle: target.role });
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
 * doGet
 * ========================================================== */

/**
 * GET /exec?action=ping
 * GET /exec?action=whoami&id_token=...&token=...
 * GET /exec?action=getWeek&dates=2026-08-31,...&id_token=...&token=...
 * GET /exec?action=getMonthHours&id_token=...&token=...[&nextWeekDates=...]
 * GET /exec?action=getAdminRoster&id_token=...&token=...
 * GET /exec?action=getReminderConfig&id_token=...&token=...
 * GET /exec?action=startLineLink&id_token=...&token=...
 *
 * 例外：/exec?code=...&state=... は LINE Login のコールバック。
 * 上の共通認証は通さず、state の署名で「誰の連携か」を確かめる。
 */
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = p.action || 'ping';

    // LINE Login のコールバック（本人のブラウザが LINE から飛ばされてくる）。
    // API_TOKEN も Google の id_token も持っていないので、ここで先に受ける。
    // 誰の連携かは state の署名で確かめる。
    if (p.state && (p.code || p.error)) return handleLineLinkCallback_(p);

    if (action === 'ping') {
      return jsonOut_({ ok: true, message: 'Ming Ramen Bar Shift API is running' });
    }

    if (!checkSharedToken_(p.token)) {
      return jsonOut_({ ok: false, error: 'unauthorized' });
    }

    // auth=line なら LIFF から来た LINE の id_token として検証する
    const who = resolveIdentity_(p.id_token, p.auth);
    if (!who.ok) return jsonOut_({ ok: false, error: who.error });

    if (action === 'whoami') return handleWhoami_(who);
    if (action === 'getWeek') return handleGetWeek_(who, p);
    if (action === 'getMonthHours') return handleGetMonthHours_(who, p);
    if (action === 'getAdminRoster') return handleGetAdminRoster_(who);
    if (action === 'getReminderConfig') return handleGetReminderConfig_(who);
    if (action === 'startLineLink') return handleStartLineLink_(who, p);

    return jsonOut_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function handleWhoami_(who) {
  const out = {
    ok: true,
    role: who.role,
    isAdmin: !!who.isAdmin,
    email: who.email,
    name: who.name || '',
  };
  out.auth = who.auth || 'google';
  if (who.role === 'employee') {
    out.roleTitle = who.roleTitle || '';
    // LINE 連携の導線を出すかどうかを員工頁が判断できるようにする。
    // LIFF から来ている場合は当然すでに紐付いているので、導線は出さない。
    out.lineLoginReady = who.auth === 'line' ? false : lineLoginReady_();
    out.lineLinked = who.auth === 'line' ? true : !!lineUserIdMap_()[who.name];
  }
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

  // admin.html は view=admin を付けてくる。員工頁（無此參數）では、
  // 店長も「自分の班表＋重なる同僚」だけを見る員工視角になる。
  if (who.isAdmin && (p.view === 'admin' || who.role !== 'employee')) {
    return adminWeek_(dates);
  }
  if (who.role === 'employee') return employeeWeek_(who, dates);
  return jsonOut_({ ok: false, error: 'not_registered' });
}

function adminWeek_(dates) {
  const result = {};
  // 一週可能跨兩個月份分頁，各分頁的名單長度未必相同，逐日各自取名單
  const seen = {};
  const merged = [];
  let firstSheet = null;   // 管理頁「在試算表開啟」連結用

  dates.forEach(function (dateStr) {
    const loc = locateDate_(dateStr);
    if (!loc) { result[dateStr] = { __error: 'sheet_or_date_not_found' }; return; }
    if (!firstSheet) firstSheet = loc.sheet;

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

  return jsonOut_({
    ok: true,
    role: 'admin',
    roster: merged,
    data: result,
    // 管理頁はこの 1 本だけで描けるようにする（名單も含めて返す）
    sheetName: firstSheet ? firstSheet.getName() : '',
    sheetUrl: firstSheet ? sheetUrl_(firstSheet) : ss_().getUrl(),
  });
}

/** 某個分頁的直接連結（#gid=... 會直接開在那一頁） */
function sheetUrl_(sheet) {
  return ss_().getUrl() + '#gid=' + sheet.getSheetId();
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
  if (!who.isAdmin) return jsonOut_({ ok: false, error: 'admin_only' });

  const sheet = rosterSheet_();
  if (!sheet) return jsonOut_({ ok: false, error: 'roster_sheet_not_found' });

  return jsonOut_({
    ok: true,
    sheetName: sheet.getName(),
    spreadsheetName: ss_().getName(),
    spreadsheetUrl: ss_().getUrl(),
    sheetUrl: sheetUrl_(sheet),
    roster: getRoster_(sheet).map(function (p) {
      return { name: p.name, role: p.role, email: p.email };
    }),
  });
}

/* ============================================================
 * 提出通知（員工がシフトを出したら店主の個人 LINE に知らせる）
 * ------------------------------------------------------------
 * シフトは「確認設定」を押すたびに 1 日分ずつ書き込まれるので、
 * 書き込みのたびに送ると 7 日分で 7 通になる。そこで
 *
 *   書き込み時 … 誰が何日分いじったかを数えておくだけ（送らない）
 *   「送出班表」… 溜まった件数をまとめて 1 通だけ送る
 *
 * という分担にしてある。溜まっている件数が 0 のときは送らないので、
 * ボタンを二度押ししても通知は重複しない。
 *
 * 送り先は Script Properties の LINE_ADMIN_USER_ID。管理頁の
 * 「連結我的 LINE」（= LINE Login を kind:'admin' で通したもの）で入る。
 *
 * ⚠ push は**相手が公式アカウントを友だち追加していないと届かない**。
 * しかも届かなくても LINE は 200 を返すので、コード側では失敗を検知
 * できない。だから管理頁にテスト送信ボタンを置いてある。
 * ========================================================== */

const SUBMIT_PENDING_KEY = 'SUBMIT_PENDING';   // {"姓名": 件数} の JSON

function adminNotifyUserId_() { return (props_().getProperty('LINE_ADMIN_USER_ID') || '').trim(); }
function adminNotifyEmail_() { return (props_().getProperty('LINE_ADMIN_EMAIL') || '').trim(); }

/* ------------------------------------------------------------
 * 未通知件数のカウンタ
 * ---------------------------------------------------------- */

function readSubmitPending_() {
  try {
    return JSON.parse(props_().getProperty(SUBMIT_PENDING_KEY) || '{}') || {};
  } catch (err) {
    return {};
  }
}

/**
 * 1 日分書き込むたびに +1。ここでは送らない。
 * 同時書き込みで数え落とさないようロックを取るが、通知はあくまで
 * 「おまけ」なので、ロックが取れなければ黙って諦める（班表の
 * 書き込み自体を失敗させない）。
 */
function bumpSubmitPending_(name) {
  if (!name || !isSet_(adminNotifyUserId_())) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  try {
    const pending = readSubmitPending_();
    pending[name] = (Number(pending[name]) || 0) + 1;
    props_().setProperty(SUBMIT_PENDING_KEY, JSON.stringify(pending));
  } catch (err) {
    console.error('bumpSubmitPending_ failed: ' + err);
  } finally {
    lock.releaseLock();
  }
}

/** 溜まっていた件数を取り出して 0 に戻す */
function takeSubmitPending_(name) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 0;
  try {
    const pending = readSubmitPending_();
    const count = Number(pending[name]) || 0;
    if (count) {
      delete pending[name];
      props_().setProperty(SUBMIT_PENDING_KEY, JSON.stringify(pending));
    }
    return count;
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
 * 送信
 * ---------------------------------------------------------- */

/** 店主の個人 LINE に 1 通送る */
function pushToAdmin_(text) {
  const to = adminNotifyUserId_();
  if (!isSet_(to)) return { ok: false, error: 'admin_line_not_linked' };
  return lineApi_(LINE_PUSH_URL, { to: to, messages: [{ type: 'text', text: text }] });
}

/**
 * POST { action:'notifySubmit' }（員工本人のみ）
 * 「送出班表」を押したときに呼ばれる。未通知の変更が無ければ何もしない。
 */
function handleNotifySubmit_(who, body) {
  if (who.role !== 'employee') return jsonOut_({ ok: false, error: 'employee_only' });
  if (!isSet_(adminNotifyUserId_())) return jsonOut_({ ok: true, skipped: 'admin_not_linked' });

  const count = takeSubmitPending_(who.name);
  if (!count) return jsonOut_({ ok: true, skipped: 'no_changes' });

  const dates = (body && body.dates ? String(body.dates) : '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const range = dates.length
    ? '（' + mdLabel_(dates[0]) + '〜' + mdLabel_(dates[dates.length - 1]) + '）'
    : '';

  const text = [
    '📝 ' + who.name + ' 送出了希望排班' + range + '。',
    '這次改了 ' + count + ' 天，請確認。',
    isSet_(appUrl_()) ? '👉 ' + adminPageUrl_() : '',
  ].filter(Boolean).join('\n');

  const sent = pushToAdmin_(text);
  if (!sent.ok) {
    // 送れなかった分は戻しておく（次の「送出班表」でまとめて通知される）
    bumpSubmitPendingBy_(who.name, count);
    return jsonOut_({ ok: false, error: sent.error, detail: sent.detail });
  }
  return jsonOut_({ ok: true, sent: true, count: count });
}

/** 送信に失敗したぶんを数え戻す */
function bumpSubmitPendingBy_(name, count) {
  if (!name || !count) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  try {
    const pending = readSubmitPending_();
    pending[name] = (Number(pending[name]) || 0) + count;
    props_().setProperty(SUBMIT_PENDING_KEY, JSON.stringify(pending));
  } finally {
    lock.releaseLock();
  }
}

/** APP_URL から管理頁の URL を組み立てる（index.html → admin.html） */
function adminPageUrl_() {
  const url = appUrl_();
  if (!isSet_(url)) return '';
  return url.indexOf('index.html') !== -1
    ? url.replace('index.html', 'admin.html')
    : url.replace(/\/?$/, '/') + 'admin.html';
}

/* ------------------------------------------------------------
 * 管理頁 API
 * ---------------------------------------------------------- */

/** POST { action:'testAdminNotify' }（管理員限定） */
function handleTestAdminNotify_(who) {
  if (!who.isAdmin) return jsonOut_({ ok: false, error: 'admin_only' });
  if (!isSet_(adminNotifyUserId_())) return jsonOut_({ ok: false, error: 'admin_line_not_linked' });

  const sent = pushToAdmin_([
    '🔔 這是測試通知。',
    '看得到這則訊息，代表員工送出排班時你會收到通知。',
    '看不到的話，請確認你已經把這個官方帳號加為好友。',
  ].join('\n'));

  if (!sent.ok) return jsonOut_({ ok: false, error: sent.error, detail: sent.detail });
  return jsonOut_({ ok: true });
}

/** POST { action:'unlinkAdminNotify' }（管理員限定） */
function handleUnlinkAdminNotify_(who) {
  if (!who.isAdmin) return jsonOut_({ ok: false, error: 'admin_only' });
  props_().setProperties({
    LINE_ADMIN_USER_ID: LINE_UNSET,
    LINE_ADMIN_EMAIL: LINE_UNSET,
  }, false);
  return jsonOut_({ ok: true });
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
 *
 * LINE 連結解除（員工本人）：
 *   { token, id_token, action:'unlinkLine' }
 *
 * 管理員專用（LINE 催繳提醒）：
 *   { token, id_token, action:'setReminderConfig', enabled:true, weekday:5, hour:12 }
 *   { token, id_token, action:'sendReminderTest', dryRun:true }
 *
 * 另外，網址帶 ?line={LINE_WEBHOOK_KEY} 的 POST 會被當成 LINE 的 Webhook，
 * 不走上面這套驗證（LINE 沒有 Google 帳號，也不知道 API_TOKEN）。
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // LINE の Webhook だけは別系統（Google 登入も API_TOKEN も持っていない）。
    // 正体は URL の ?line=... で判定する。詳細は handleLineWebhook_ を参照。
    if (e && e.parameter && e.parameter.line) return handleLineWebhook_(e, body);

    if (!checkSharedToken_(body.token)) {
      return jsonOut_({ ok: false, error: 'unauthorized' });
    }

    const who = resolveIdentity_(body.id_token, body.auth);
    if (!who.ok) return jsonOut_({ ok: false, error: who.error });

    const action = body.action || 'submitShift';
    if (action === 'linkAccount') return handleLinkAccount_(who, body);
    if (action === 'submitShift') return handleSubmitShift_(who, body);
    if (action === 'unlinkLine') return handleUnlinkLine_(who);
    if (action === 'notifySubmit') return handleNotifySubmit_(who, body);
    if (action === 'testAdminNotify') return handleTestAdminNotify_(who);
    if (action === 'unlinkAdminNotify') return handleUnlinkAdminNotify_(who);
    if (action === 'setReminderConfig') return handleSetReminderConfig_(who, body);
    if (action === 'sendReminderTest') return handleSendReminderTest_(who, body);

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

  // LINE（LIFF）経由は Email が無いので、C 欄ではなく対照表に書く
  if (who.auth === 'line') return linkLineAccount_(who, body);

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
  // 管理員兼員工（店長）は role==='employee' なので、ここは通る。
  // 名單に載っていない純管理員だけを弾く。
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

  // 通知はここでは送らない。「送出班表」でまとめて 1 通にするため、
  // 何日分いじったかだけ数えておく（notifySubmit が取り出して送る）。
  bumpSubmitPending_(who.name);

  return jsonOut_({ ok: true, name: who.name });
}
