/**
 * Ming Ramen Bar 排班意願申請 - 前端連線設定
 * -----------------------------------------------------------
 * 部署 apps-script/Code.gs 為 Web App 後，把網址與 token 貼在這裡，
 * 並填入 Google Cloud Console 建立的 OAuth 網頁用戶端 ID。
 *
 * 未設定前 (API_URL 還是 PASTE_ 開頭)，畫面會自動切換為示範模式：
 * 不需要 Google 登入，直接用 demo-data.js 的假資料模擬一位員工，
 * UI 與流程完全相同，方便還沒部署後端時開發預覽。
 */
const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbx-Axw76Y-HCta-EzUB2A9f3E7Ui3t8ZYYhkszc2rXHRDELbF3aCO3TDa3udWIfV-EJVQ/exec',
  // Apps Script 的 setupProperties() 裡的 API_TOKEN，兩邊必須完全一致
  API_TOKEN: 'ming-ramen-wappIHGbTNhHPF8BgToxVz-G',

  // Google Cloud Console > API 和服務 > 憑證 > OAuth 用戶端 ID（網頁應用程式）
  // Authorized JavaScript origins 需要包含 GitHub Pages 網址與本機開發網址。
  GOOGLE_CLIENT_ID: '210207629281-288kjvq3qes9651a3udsnojnicqc00f7.apps.googleusercontent.com',
};

const isConfigured = !!CONFIG.API_URL && !CONFIG.API_URL.includes('PASTE_');
const isAuthConfigured = !!CONFIG.GOOGLE_CLIENT_ID && !CONFIG.GOOGLE_CLIENT_ID.includes('PASTE_');

/** 示範模式：後端或登入尚未設定時，跳過驗證用假資料跑流程 */
const isDemoMode = !isConfigured || !isAuthConfigured;
