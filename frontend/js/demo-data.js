/**
 * 示範模式用的假資料。
 * 僅在 CONFIG 尚未設定 API_URL / GOOGLE_CLIENT_ID 時使用，方便在還沒
 * 部署 Apps Script、也還沒申請 OAuth 用戶端之前，直接在本機開啟
 * index.html / admin.html 預覽整個流程（會跳過 Google 登入）。
 */
const DEMO_STAFF = [
  {name:"林炘緯", role:"經理"},
  {name:"林暐軒", role:"內場組長"},
  {name:"宮嶋優志", role:"PT"},
  {name:"章芮綺", role:"PT"},
  {name:"沈培君", role:"PT"},
  {name:"錢玉珍", role:"PT"},
  {name:"林欣霈", role:"PT"},
  {name:"楊廷瑜", role:"PT"},
  {name:"曾衣萱", role:"PT"},
  {name:"子涵", role:"PT"},
  {name:"Jack", role:"支援"},
];
const DEMO_PATTERNS = {
  "林暐軒": ["10:30\n15:30","排休\nday off","10:30\n15:30","排休\nday off","10:30\n15:30","排休\nday off","排休\nday off"],
  "章芮綺": ["排休\nday off","排休\nday off","排休\nday off","排休\nday off","10:30\n15:30","排休\nday off","排休\nday off"],
  "沈培君": ["排休\nday off","10:30\n15:30","10:30\n15:30","17:30\n21:30","11:30\n15:30","排休\nday off","排休\nday off"],
};

/** 示範模式下「登入的人」是誰（對應 whoami 的回傳） */
const DEMO_ME = { name: "林欣霈", role: "PT", email: "demo.staff@example.com" };

/** 示範模式下的管理員身分（admin.html 用） */
const DEMO_ADMIN = { email: "demo.owner@example.com" };

/** 示範模式下「本月至今」的假工時（分鐘） */
const DEMO_MONTH_MINUTES = 62 * 60 + 30;  // 62.5 小時
const DEMO_MONTH_DAYS = 13;

/** 示範模式下的 Email 對照表（admin.html 的全員名單用） */
const DEMO_EMAILS = {
  "林炘緯": "demo.owner@example.com",
  "林暐軒": "demo.chief@example.com",
  "林欣霈": "demo.staff@example.com",
};
