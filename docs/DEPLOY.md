# 部署與開發環境設定

這份文件涵蓋三件事：**Google OAuth 用戶端設定**、**Apps Script 後端部署**、
**GitHub Pages 前端部署**。三個都設定完，Google 登入才會正常運作。

> 只想先看 UI、還不想設定這些？把 `frontend/js/config.js` 保持預設
> （`PASTE_...`）就會進入**示範模式**：跳過 Google 登入，用
> `demo-data.js` 的假資料模擬一位員工與一位管理員，流程完全相同。

---

## A. 建立 Google OAuth 用戶端 ID

1. 打開 [Google Cloud Console](https://console.cloud.google.com/)，
   建立（或選擇）一個專案。
2. 「API 和服務 > OAuth 同意畫面」先設定好（外部 / External，填入應用程式
   名稱與支援 Email 即可）。

   > ⚠ **記得把發布狀態改成「正式版 (In production)」。**
   > 停在「測試中 (Testing)」的話，只有加進「測試使用者」名單的帳號能登入
   > （上限 100 人）。自己的帳號通常已經在名單裡，所以測試時不會發現，
   > 等發給店員之後才會冒出「只有我登得進去」的狀況。
   >
   > 這個 app 只用到 `email` / `profile` 基本範圍，**切成正式版不需要
   > 送 Google 審查 (verification)**，按下「發布應用程式」即可。
   > 若暫時只想給幾個人試用，也可以留在測試中，把他們的 Gmail
   > 一個一個加進「測試使用者」。
3. 「API 和服務 > 憑證 > 建立憑證 > OAuth 用戶端 ID」，類型選
   **網頁應用程式**。
4. **Authorized JavaScript origins（承認済みの JavaScript 生成元）**
   填入以下四個來源：

   ```
   https://bob3endeavor.github.io
   http://127.0.0.1:5500
   http://localhost:5500
   http://localhost:4173
   ```

   | 來源 | 用途 |
   | --- | --- |
   | `https://bob3endeavor.github.io` | 正式環境（GitHub Pages） |
   | `http://127.0.0.1:5500` | VS Code Live Server（預設就是這個位址） |
   | `http://localhost:5500` | 同上，但用 `localhost` 開啟時 |
   | `http://localhost:4173` | `npm run dev`（`npx serve`） |

   > **只填到網域為止，不要帶路徑。** 正式環境實際開啟的網址會是
   > `https://bob3endeavor.github.io/ramen-shift-app/frontend/index.html`，
   > 但 origin 不包含路徑，所以只填 `https://bob3endeavor.github.io`。
   > 多填了 `/ramen-shift-app/...` 會被判定為無效的來源。
   >
   > **`127.0.0.1` 和 `localhost` 對 Google 來說是不同的 origin**，
   > 兩個都要填才不會因為開啟方式不同而登入失敗。
   >
   > **`Authorized redirect URIs` 這一欄留空即可。** Google Identity
   > Services 的 One Tap / 按鈕流程不會用到轉址。

   生成元之後隨時可以再新增，修改後通常幾分鐘內生效（偶爾要等久一點）。

   > **先只填本機那幾個也沒問題**，等要上 GitHub Pages 時再回到
   > 「API 和服務 > 憑證」編輯同一組用戶端 ID、把正式環境的 origin 加上去，
   > **不需要另外建一組新的用戶端 ID**。
   >
   > 事實上正式與本機請務必共用同一組：後端是拿 ID Token 的 `aud` 去跟
   > Script Properties 裡**單一個** `GOOGLE_CLIENT_ID` 比對，分成兩組的話
   > 每次切換環境都得同時改 `config.js` 與 Script Properties，很容易
   > 變成 `token_audience_mismatch`。
5. 建立後複製 **用戶端 ID**（`xxxxx.apps.googleusercontent.com`），
   等一下前後端都要用到同一組。

---

## B. Apps Script 後端

### B-1. 第一次部署（在新的試算表上）

1. 用**店主的 Google 帳號**到 [sheets.new](https://sheets.new) 建立一份
   **新的空白試算表**，取個名字（例如「Ming Ramen Bar 員工排班表」）。
2. 「擴充功能 (Extensions) > Apps Script」，會開啟**綁定這份試算表**的專案。
3. 把 `apps-script/Code.gs` 的內容整份貼進去（取代預設的 `myFunction`），儲存。

   > `SPREADSHEET_ID` 保持留空即可 —— 留空代表「用綁定的這份試算表」。
   > 只有做成獨立 (standalone) 指令碼、要指定外部試算表時才需要填 ID。

4. **建立排班分頁**：函式下拉選單選 `setupNewSpreadsheet`，按執行 ▶
   （首次會要求授權，點「進階 > 前往...(不安全)」再允許）。

   會自動建立「本月」「下個月」兩個分頁，版面如下：

   |  | A | B | C | D | E | … |
   |---|---|---|---|---|---|---|
   | 1 | 職稱 | 姓名 | Email | 1 | 2 | … |
   | 2 | 2026 年 9 月 | | | 二 | 三 | … |
   | 3 | 經理 | 林炘緯 | | | | |
   | 4 | 內場組長 | 林暐軒 | | | | |

   員工名單來自 `Code.gs` 最上面的 `SETUP_STAFF`。**跟實際名單不一樣的話，
   執行前先改 `SETUP_STAFF`**，或是執行後直接在試算表上編輯 A/B 欄
   （之後增減人員都是直接改試算表，不用再動程式碼）。

   C 欄 Email 留空即可，員工第一次 Google 登入綁定後會自動寫入；
   也可以先手動預填既有員工的 Email。

   > 每個月底記得跑一次 `addNextMonthSheet()` 補下個月的分頁
   > （沒有分頁的日期會被標成不可點選）。已存在的分頁不會被覆蓋，
   > 所以這兩個函式重複執行都是安全的。

5. 確認 `setupProperties()` 裡的三個值（`API_TOKEN` 與 `GOOGLE_CLIENT_ID`
   已經填好；`ADMIN_EMAILS` 是預留值，要自己在「專案設定 > 指令碼屬性」
   填上店主的 Email —— 這個 repo 是公開的，Email 不寫進程式碼），
   然後在函式下拉選單選 `setupProperties`，按執行 ▶：

   | Script Property | 用途 |
   | --- | --- |
   | `API_TOKEN` | 簡易共享密鑰，擋掉隨機亂打的請求。前端 `config.js` 要填同一組 |
   | `GOOGLE_CLIENT_ID` | A 步驟拿到的 OAuth 用戶端 ID。後端用它檢查 ID Token 的 `aud` |
   | `ADMIN_EMAILS` | 管理員 Email，逗號分隔，例如 `owner@gmail.com,manager@gmail.com` |

   設定完可在「專案設定 > 指令碼屬性 (Script Properties)」確認或修改，
   **改管理員名單不需要重新部署程式碼**。

6. 右上角「部署 (Deploy) > 新增部署作業」，類型選「網頁應用程式」：
   - 執行身分：**我**（指令碼要用你的權限寫試算表）
   - 誰可以存取：**任何人 (Anyone)**

   > 這裡選「任何人」是刻意的：真正的身分驗證由 Google ID Token 負責
   > （後端每次都會驗簽章、有效期與 `aud`），Web App 本身的存取權限
   > 若收成「僅限本網域」，反而會讓外部 Gmail 帳號的員工連不上。

7. 部署完成會拿到一個 Web App 網址，複製起來。

### B-2. 填入前端設定

把 A、B 拿到的三個值填進 `frontend/js/config.js`：

```js
const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfy.../exec',
  API_TOKEN: '跟 Script Properties 的 API_TOKEN 一模一樣',
  GOOGLE_CLIENT_ID: 'xxxxx.apps.googleusercontent.com',
};
```

### B-3. 接手既有專案到 VS Code（用 clasp）

```bash
npm install -g @google/clasp
clasp login          # 用你的 Google 帳號登入（會開瀏覽器授權）
```

在 Apps Script 編輯器網址列可以看到 script ID：
`https://script.google.com/.../projects/<SCRIPT_ID>/edit`

```bash
cd apps-script
clasp clone <SCRIPT_ID> --rootDir .
```

`clasp clone` 會把雲端上的專案（含 `appsscript.json`）抓下來，可能會
覆蓋掉這個資料夾裡的版本，請自行 diff 一下再決定保留哪份。之後的開發
流程：

```bash
# 改完 Code.gs 之後同步到雲端
clasp push

# 需要重新部署（更新既有 Web App 網址內容）時
clasp deployments        # 查看現有部署，取得 deploymentId
clasp deploy -i <deploymentId> -d "說明文字"

# 或建立全新的部署（會得到新網址，記得更新 config.js）
clasp deploy -d "說明文字"
```

> `.clasp.json` 內含你的 `scriptId`，屬於個人專案識別資訊，已加進
> `.gitignore`，不會被提交。專案裡的 `.clasp.json.example` 只是範本。

---

## C. 前端部署到 GitHub Pages

1. 把這個 repo 推上 GitHub。
2. repo 的「Settings > Pages」：
   - Source 選 **Deploy from a branch**
   - Branch 選 `main`，資料夾選 **`/ (root)`**
3. 因為前端在 `frontend/` 子目錄，網址會是：

   ```
   https://bob3endeavor.github.io/ramen-shift-app/frontend/index.html   員工頁
   https://bob3endeavor.github.io/ramen-shift-app/frontend/admin.html   管理員頁
   ```

   想要短一點的話有兩個做法：
   - 把 Pages 的資料夾設定改成 `/docs`，並把 `frontend/` 改名成 `docs/`；或
   - 在 repo 根目錄放一個 `index.html` 轉址到 `frontend/index.html`。
4. 不論路徑怎麼改，**origin 都是 `https://bob3endeavor.github.io`**，
   A-4 已經填過就不用再改。只有在改用自訂網域時才需要新增 origin。

> `config.js` 會被推上公開 repo，裡面的 `API_TOKEN` 等於是公開的。
> 這是刻意的取捨：它只是防亂打的門檻，真正決定「你是誰、能改誰的班表」
> 的是 Google ID Token。不要把任何真正的機密放進 `config.js`。

---

## D. 本機開發

兩種方式都可以，對應的 origin 在 A-4 都已經註冊過了。

**方式一：VS Code Live Server**

專案的 `.vscode/settings.json` 已經把 host / port / root 固定好
（`127.0.0.1:5500`，根目錄指到 `frontend/`），直接在 `frontend/index.html`
按右鍵 > Open with Live Server 即可：

```
http://127.0.0.1:5500/index.html   員工頁
http://127.0.0.1:5500/admin.html   管理員頁
```

> 沒有固定 port 的話，5500 被佔用時 Live Server 會自動改用 5501、5502…，
> 那樣 origin 就跟註冊的對不上，會出現「登入按鈕有出現但按了沒反應」。

**方式二：npx serve**

```bash
npm run dev        # = npx serve frontend -l 4173
```

然後開啟 http://localhost:4173/index.html 或
http://localhost:4173/admin.html。

> ⚠ **不要在 VS Code 的預覽視窗（iframe）裡測試登入流程。**
> Google Identity Services 在 iframe 內通常無法正常運作，請直接用
> 瀏覽器開啟本機網址或部署後的網址測試。

---

## E. 測試檢查清單

1. `{API_URL}?action=ping` 回應
   `{"ok":true,"message":"Ming Ramen Bar Shift API is running"}`
   → Web App 部署正常。
2. 開啟 `index.html`，沒有出現「示範模式」黃色橫幅 → `config.js` 已填好。
3. 用**還沒綁定過的員工 Google 帳號**登入 → 應該進入「請選擇你的姓名」
   畫面，選完送出後，試算表 C 欄應該出現該 Email。
4. 同一個帳號重新整理 → 應該直接進入主畫面，姓名不可更改。
5. 選一天送出班別 → 試算表對應儲存格寫入 `10:30\n15:30`；
   「工時試算」的「下週希望排班」跟著變動。
6. 用 `ADMIN_EMAILS` 裡的帳號登入 `index.html` → 應該看到「你是管理員，
   請前往管理頁」的提示，而不是被當成一般員工。
7. 同一個管理員帳號開 `admin.html` → 看得到全員班表。
   用員工帳號開 `admin.html` → 應該被擋下來。

---

## F. 常見錯誤

| 錯誤訊息 / 現象 | 可能原因 |
| --- | --- |
| 畫面一直顯示示範模式 | `config.js` 的 `API_URL` 或 `GOOGLE_CLIENT_ID` 還是預設的 `PASTE_...` |
| 登入按鈕沒出現 / 按了沒反應 | 目前網址的 origin 沒有加進 OAuth 用戶端的 Authorized JavaScript origins；或正在 iframe/預覽視窗裡測試 |
| 只有自己登得進去，店員登入被拒 | OAuth 同意畫面還停在「測試中」，店員的帳號不在測試使用者名單內 → 改成「正式版」（見 A-2） |
| 上線後突然全部登不進去 | GitHub Pages 的 origin (`https://bob3endeavor.github.io`) 忘了加進生成元 |
| `token_audience_mismatch` | `config.js` 的 `GOOGLE_CLIENT_ID` 跟 Script Properties 的 `GOOGLE_CLIENT_ID` 不是同一組 |
| `server_missing_client_id` | Apps Script 的 Script Properties 還沒設定 `GOOGLE_CLIENT_ID` |
| `token_expired` | ID Token 約 1 小時過期，頁面會自動退回登入畫面，重新登入即可 |
| `unauthorized` | `config.js` 的 `API_TOKEN` 跟 Script Properties 的 `API_TOKEN` 不一致 |
| `not_registered` | 這個 Email 還沒綁定員工姓名（正常情況會自動導向首次登入畫面） |
| `name_already_linked` | 這位員工的 C 欄已經有別的 Email，需要店長手動清掉才能重新綁定 |
| `sheet_or_date_not_found` | 目標日期所在月份的分頁（例如「9月排班班表」）還沒建立，或分頁命名不符規則 |
| `staff_not_found` | 試算表 B 欄的姓名前後有多餘空格，或該月分頁少了這個人 |
| 本月累計時數是 0 | 本月分頁還沒建立，或該分頁裡沒有你的姓名（畫面會標示原因） |
