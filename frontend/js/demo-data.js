/**
 * 示範模式用的假資料。
 * 僅在 CONFIG 尚未設定 API_URL / GOOGLE_CLIENT_ID 時使用，方便在還沒
 * 部署 Apps Script、也還沒申請 OAuth 用戶端之前，直接在本機開啟
 * index.html / admin.html 預覽整個流程（會跳過 Google 登入）。
 *
 * 這份名單只是示範用。正式環境的名單一律以試算表上的 A/B 欄為準，
 * 人員異動請直接改試算表，不用回來改這裡。
 */
const DEMO_STAFF = [
  {name:"山田太郎 TARO", role:"正職"},
  {name:"張小龍", role:"內場組長"},
  {name:"陳小芳", role:"PT"},
  {name:"林小美", role:"PT"},
  {name:"黃小強", role:"PT"},
  {name:"李小華", role:"PT"},
  {name:"小玉", role:"PT"},
  {name:"美心", role:"PT"},
  {name:"小雨", role:"PT"},
  {name:"阿明", role:"PT"},
  {name:"Alex", role:""},
];
const DEMO_PATTERNS = {
  "張小龍": ["10:30\n15:30","排休\nday off","10:30\n15:30","排休\nday off","10:30\n15:30","排休\nday off","排休\nday off"],
  "陳小芳": ["排休\nday off","排休\nday off","排休\nday off","排休\nday off","10:30\n15:30","排休\nday off","排休\nday off"],
  "林小美": ["排休\nday off","10:30\n15:30","10:30\n15:30","17:30\n21:30","11:30\n15:30","排休\nday off","排休\nday off"],
};

/** 示範模式下「登入的人」是誰（對應 whoami 的回傳） */
const DEMO_ME = { name: "李小華", role: "PT", email: "demo.staff@example.com" };

/**
 * 示範模式下「上週」DEMO_ME 自己填過的內容（一〜日，共 7 天）。
 * 「套用上週的班表」按鈕在示範模式也能走完整個流程用的。
 * 空字串＝那天沒填，按鈕會跳過不帶入。
 */
const DEMO_LAST_WEEK = [
  "10:30\n15:30",
  "排休\nday off",
  "10:30\n15:30",
  "",
  "17:30\n21:30",
  "10:30\n22:00",
  "排休\nday off",
];

/** 示範模式下的管理員身分（admin.html 用） */
const DEMO_ADMIN = { email: "demo.owner@example.com" };

/** 示範模式下「本月至今」的假工時（分鐘） */
const DEMO_MONTH_MINUTES = 62 * 60 + 30;  // 62.5 小時
const DEMO_MONTH_DAYS = 13;

/** 示範模式下的 Email 對照表（admin.html 的全員名單用） */
const DEMO_EMAILS = {
  "山田太郎 TARO": "demo.owner@example.com",
  "張小龍": "demo.chief@example.com",
  "李小華": "demo.staff@example.com",
};
