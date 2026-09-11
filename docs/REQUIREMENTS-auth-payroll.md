# 需求規格：Google 登入、權限管理、工時試算

> 這份文件是給 Claude Code 在 VS Code 實作用的規格書，決策內容來自與店主
> 在聊天中確認過的需求。實作過程中若有新的疑問或需要調整規格，請回到
> 原本那個聊天串確認，再更新這份文件。

## 背景與目標

現有的 `ramen-shift-app`（員工排班意願申請）任何人都能用下拉選單選任何
員工的名字送出排班，沒有身分驗證。這次要加上：

1. Google 帳號登入
2. 員工只能操作自己的排班；管理員可以查看全員排班
3. 員工可以看到自己本月的工時概況（先做「時數」，不做金額）

> **本期範圍變更**：原本規劃的「目前賺到 ○○ 元」（金額）延後，第一期
> 先做「目前這個月上 ○○ 小時」（時數）。時薪欄位與金額試算列在第七節
> 「未來擴充」，本期不實作，避免做出用不到的管理介面。

## 一、帳號與登入

### 1.1 員工登入流程

1. 開啟前端頁面，未登入時顯示「使用 Google 帳號登入」按鈕（Google
   Identity Services）。
2. 登入成功後取得 Google ID Token，隨 API 請求送到後端 (Apps Script)
   驗證，不再信任前端自己宣稱的身分。
3. 後端用 Email 查「員工-Email 對照表」：
   - **已有對照紀錄** → 直接對應到員工姓名，進入一般畫面（只能操作
     自己的排班）。
   - **沒有對照紀錄** → 進入「首次登入」畫面，讓使用者從「尚未綁定
     Email 的員工名單」選擇自己的姓名，送出後由後端把
     `(姓名, Email)` 寫入對照表，之後這個 Email 永久對應到這位員工。

### 1.2 管理員登入流程

- 管理員共 2 位（Owner + 排班管理者），Email 存在 Apps Script 的
  Script Properties，例如：
  `ADMIN_EMAILS = "owner@gmail.com,manager@gmail.com"`
- 登入後若 Email 命中 `ADMIN_EMAILS` → 導向獨立的管理員頁面
  `admin.html`。一般員工頁面 `index.html` 若偵測到登入者是管理員，
  應提示切換到管理頁，而不是把管理員當一般員工處理。

### 1.3 Token 驗證方式

- 後端用
  `UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + idToken)`
  驗證簽章與有效期限，確認 `aud`（audience）等於我們的 OAuth Client
  ID，取出其中已驗證過的 `email`。
- 所有寫入操作（送出排班）一律用「驗證後反查出來的身分」，不再接受
  前端直接傳來的姓名字串。

## 二、權限範圍

| 角色 | 可以做什麼 |
|---|---|
| 一般員工 | 只能查看/填寫「自己」的希望排班；只能看到「跟自己時段重疊的同事姓名」，不開放看別人完整班表；可看到自己本月的工時試算 |
| 管理員（Owner／排班管理者） | 可查看所有員工的排班（唯讀，`admin.html`） |

## 三、試算表資料結構變更

在既有「A欄職稱、B欄姓名」之後新增：

- **C欄：Email**（首次登入綁定後自動寫入；管理員也可手動預填既有員工）

`getRoster_()` 需要一併讀出這欄。

> 時薪欄位（原規劃的 D欄）本期不新增，等之後要做金額試算時再加，見
> 第七節「未來擴充」。

## 四、Apps Script 新增／修改的 API

### 4.1 `doGet`

- `action=whoami&id_token=...`
  驗證 token，查 Email 對應員工，回傳
  `{ok, role:'admin'|'employee'|'unregistered', name, unboundRoster}`
  （`unboundRoster` 只在 `unregistered` 時需要，供首次登入選姓名用）。
- `action=getWeek`：沿用現有邏輯，但加上 token 驗證；**一般員工**只
  回傳「自己那一列」＋「其他人是否與自己重疊的簡化資訊（姓名＋時
  段，不含完整班表）」；**管理員**可讀取全部人完整班表。
- `action=getMonthHours&id_token=...`：計算「這個月至今」已排定的
  總時數（依已寫入試算表的班別，start~end 時長加總，排休不計），
  回傳給員工本人看。同時回傳「下週希望排班」目前已選的時數小計，
  供「下週預估 XX 小時」使用（這部分可以直接用前端已經有的
  `state.requests` 加總，不一定要多打一次 API，實作時依方便為主）。
- `action=getAdminRoster&id_token=...`（僅管理員）：回傳全員姓名、
  職稱、Email，供管理頁的全員班表畫面使用。

### 4.2 `doPost`

- `action=linkAccount`：首次登入綁定，body `{id_token, name}`，寫入
  Email 對照表。
- `action=submitShift`：沿用現有寫入班表邏輯，但姓名改由「驗證後的
  Email 反查姓名」決定。

### 4.3 安全性

- 既有的 `API_TOKEN` 共享密鑰可以保留做基本防護，但主要身分驗證改為
  Google ID Token；管理員判斷完全看 Email 是否在 `ADMIN_EMAILS`
  清單，不再依賴前端傳來的角色欄位。

## 五、前端變更

### 5.1 `frontend/index.html`（員工用）

- 加入 Google Identity Services：
  `<script src="https://accounts.google.com/gsi/client"></script>`
- **未登入**：顯示登入按鈕，其餘畫面隱藏。
- **已登入、未綁定姓名**：顯示「請選擇你的姓名」一次性畫面。
- **已登入、已綁定**：
  - 移除現有的「姓名下拉選單」，改為直接顯示自己的姓名（不可更改）
  - 「班表反映預覽」維持重疊比對功能，但矩陣只顯示「自己」＋
    「與自己重疊的同事姓名」，不再顯示其他無關同事的完整班表
  - 新增「工時試算」區塊：
    「本月累計已上 XX 小時」＋「下週希望排班合計 XX 小時」

### 5.2 `frontend/admin.html`（新增，管理員用）

- 同樣走 Google 登入，只有 Email 在白名單內才能進入
- 顯示「本週／指定週」所有員工的班表矩陣（唯讀）

## 六、部署／設定注意事項

1. 前端正式環境選定 **GitHub Pages**（免費、免綁信用卡、設定簡單）。
2. 到 Google Cloud Console 建立 OAuth 用戶端 ID（類型：網頁應用
   程式），Authorized JavaScript origins 填入：
   - `https://<你的帳號>.github.io`（正式環境）
   - `http://localhost:xxxx`（本機開發用，依實際使用的 port 調整）
3. Apps Script 端要把 `ADMIN_EMAILS` 設進 Script Properties。

## 七、待確認／風險

- 月份跨頁（例如班表寫在下個月分頁）時，`getMonthHours` 需要能夠
  讀取多個分頁加總，複雜度較高；建議先確認每個月的分頁會在月初前
  建立好，否則累計時數可能算不完整。
- Google Identity Services 的登入按鈕在 iframe（例如預覽視窗）內可能
  無法正常運作；正式測試請直接開啟部署後的網址，不要在預覽窗內測試
  登入流程。

## 八、未來擴充（本期不做，先記錄需求）

- **時薪與金額試算**：等確定要把「工時」換算成「金額」顯示給員工看
  時，再新增：
  - 試算表 D欄：時薪（NT$／小時），管理員可編輯
  - `admin.html` 的「時薪設定」畫面
  - `doPost` 的 `action=setWage`
  - 是否讓員工本人看到時薪金額本身（或只看到換算後的總額）→ 待與
    老闆確認後再定，屆時建議用 Script Properties 的
    `SHOW_WAGE_RATE_TO_STAFF = true/false` 這類開關控制，不必為了
    改顯示邏輯重新部署程式碼。
  - 屆時 `getMonthHours` 可以直接擴充成 `getMonthTotal`，回傳
    `{hours, amount}` 兩者，前端切換顯示即可，不需要砍掉重做。
