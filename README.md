# Ming Ramen Bar｜排班意願申請

員工用 Google 帳號登入後，選擇希望上班的時間，資料即時寫入店長管理的
Google 試算表；同時會提示「你選的時段跟誰重疊」，並顯示自己本月的累計工時。
管理員（店主／排班管理者）有獨立的唯讀頁面可以看全員班表。

```
員工 (手機瀏覽器)                    管理員 (電腦瀏覽器)
  index.html                            admin.html
      │                                     │
      │  Google 登入 → ID Token             │
      └──────────────┬──────────────────────┘
                     │  fetch (GET 讀取 / POST 寫入)，每次都帶 ID Token
                     ▼
      Google Apps Script Web App  ──────►  Google 試算表
      （apps-script/Code.gs）              （2026-Ming Ramen Bar-員工排班表）
         │
         └─ 用 tokeninfo 驗證簽章/有效期/aud，取出已驗證的 Email，
            再用 Email 反查員工姓名 → 決定這個人能看什麼、能改什麼
```

## 權限模型

| 角色 | 判定方式 | 可以做什麼 |
| --- | --- | --- |
| 一般員工 | Email 出現在試算表 C 欄 | 只能查看／填寫**自己**的希望排班；只看得到**與自己時段重疊**的同事姓名與時段；可看自己本月累計工時 |
| 管理員 | Email 在 Script Properties 的 `ADMIN_EMAILS` 內 | `admin.html` 唯讀查看全員班表、全員帳號綁定狀態 |
| 未綁定 | 登入成功但 Email 不在 C 欄也不是管理員 | 只能進入「首次登入」畫面，從尚未綁定的名單中選自己的姓名 |

關鍵原則：**前端不宣告身分**。所有讀寫都以「後端驗證 ID Token 後反查出來的
姓名」為準，前端傳來的姓名字串一律忽略。

## 目錄結構

```
ramen-shift-app/
├── frontend/              前端（純 HTML/CSS/JS，無建置流程）
│   ├── index.html         員工頁（登入 / 首次綁定 / 排班 / 工時 / LINE 連結）
│   ├── admin.html         管理員頁（全員班表唯讀總覽）
│   ├── css/style.css
│   └── js/
│       ├── config.js      連線設定（API_URL / API_TOKEN / GOOGLE_CLIENT_ID）
│       ├── demo-data.js   離線示範用假資料
│       ├── auth.js        Google 登入與 API 呼叫的共用模組
│       ├── app.js         員工頁邏輯
│       └── admin.js       管理員頁邏輯
├── apps-script/           後端（Google Apps Script，綁定試算表）
│   ├── Code.gs
│   ├── appsscript.json
│   └── .clasp.json.example
└── docs/
    ├── DEPLOY.md                      部署、OAuth 設定、clasp 開發環境
    ├── LINE-REMINDER.md               LINE 催繳提醒的設定步驟
    └── REQUIREMENTS-auth-payroll.md   登入／權限／工時的需求規格
```

## 試算表結構

| 欄 | 內容 | 說明 |
| --- | --- | --- |
| A | 職稱 | 經理／內場組長／PT／支援 |
| B | 姓名 | 身分對照的主鍵 |
| C | **Email** | 員工首次 Google 登入綁定後自動寫入；也可由店長手動預填 |

第 1 列是欄位標題 + 日期（D 欄之後是 1〜月底），第 2 列是星期，
員工資料從第 3 列開始，每個月一個分頁（`9月排班班表`）。

分頁不用手動排版：在試算表的 Apps Script 執行 `setupNewSpreadsheet()`
會建立「本月 + 下個月」的分頁（員工名單來自 `Code.gs` 的 `SETUP_STAFF`），
之後每個月底跑一次 `addNextMonthSheet()` 補下個月。已存在的分頁不會被覆蓋。

`SPREADSHEET_ID` 留空時使用「指令碼所綁定的那份試算表」，所以從試算表的
「擴充功能 > Apps Script」建立專案的話不需要填 ID。

## API 一覽（`apps-script/Code.gs`）

所有 `action` 都需要帶 `token`（共享密鑰）與 `id_token`（Google ID Token），
`ping` 除外。

| 方法 | action | 誰可以用 | 回傳 |
| --- | --- | --- | --- |
| GET | `ping` | 任何人 | 健康檢查 |
| GET | `whoami` | 登入者 | `{role:'admin'\|'employee'\|'unregistered', name, email, unboundRoster}` |
| GET | `getWeek` | 員工／管理員 | 員工：自己那一列 + 與自己重疊的同事（姓名＋時段）<br>管理員：全員完整班表 |
| GET | `getMonthHours` | 員工本人 | 本月至今累計時數（排休不計），可選帶 `nextWeekDates` 一併算小計 |
| GET | `getAdminRoster` | 僅管理員 | 全員姓名、職稱、Email |
| GET | `getReminderConfig` | 僅管理員 | LINE 催繳提醒的設定、LINE 連線狀態、目前未提出名單 |
| GET | `startLineLink` | 員工本人 | 產生帶簽章 `state` 的 LINE Login 授權網址 |
| POST | `linkAccount` | 未綁定者 | 首次登入把 `(姓名, Email)` 寫入 C 欄 |
| POST | `submitShift` | 員工本人 | 寫入班表；姓名由 ID Token 反查，不看前端傳的值 |
| POST | `unlinkLine` | 員工本人 | 解除自己的 LINE 連結 |
| POST | `setReminderConfig` | 僅管理員 | 改提醒的開關／星期／時段，並重建時間驅動觸發器 |
| POST | `sendReminderTest` | 僅管理員 | 立刻送一則提醒（`dryRun:true` 則只回傳本文不送出） |

另外有兩條不走上面這套驗證的路徑（對方都沒有 Google 帳號也不知道
`API_TOKEN`）：

- `POST ?line={LINE_WEBHOOK_KEY}` — LINE 的 Webhook。用來記住群組 ID，
  以及處理群組裡的「連携」指令。
- `GET ?code=...&state=...` — LINE Login 的 callback。`state` 是後端自己用
  HMAC 簽過的（裡面有姓名與 nonce），所以能確認「這是誰的連結」。

## LINE 催繳提醒

每週固定時間，把「下週（一〜日）還有格子沒填」的人在 LINE 群組裡點名提醒。
只要七天裡有任何一格空著就會被點名（填「排休」也算填了），全員都填完就不發。

- 排程（開關／星期／時段）在**管理頁的「04 LINE 催繳提醒」**由店長自己改，
  存成 Script Properties，實際靠 Apps Script 的時間驅動觸發器跑。
  預設是**週五 12 時台**（週次觸發器只精確到「時段」）。
- **@提及**要有 LINE 的 userId。員工在員工頁按一下「連結 LINE 帳號」
  （LINE Login）就會自動對應——姓名是後端從 Google 登入反查來的，
  所以 **LINE 暱稱跟班表姓名不一樣也沒關係**。
  沒連結的人只列出姓名，但不會因此漏掉。對照表在試算表的 `LINE連携` 分頁。
  - LINE Login 頻道**必須跟 Messaging API 頻道在同一個 provider 底下**，
    否則拿到的 userId 對不上（連結完成畫面會警告）。
  - 備援：在群組裡打「連携 你的姓名」也可以（LINE Login 沒設定時用）。
- LINE 頻道、Webhook、群組登記的完整步驟見
  [`docs/LINE-REMINDER.md`](docs/LINE-REMINDER.md)。

## 本機開發

```bash
npm run dev        # npx serve frontend -l 4173
```

開啟 http://localhost:4173/index.html 或 http://localhost:4173/admin.html。

`frontend/js/config.js` 裡的 `API_URL` 或 `GOOGLE_CLIENT_ID` 若還是預設的
`PASTE_...`，畫面會自動切換成**示範模式**：跳過 Google 登入，用
`demo-data.js` 的假資料模擬一位員工（`DEMO_ME`）與一位管理員
（`DEMO_ADMIN`），UI 與流程完全相同，方便在還沒部署後端時開發。

> ⚠ Google 登入不能在 iframe（例如 VS Code 預覽視窗）裡測試，
> 請直接用瀏覽器開啟本機網址或部署後的網址。

## 開發時の注意：後端は手動反映

`frontend/` は GitHub へ push すれば自動で本番に反映されますが、
**`apps-script/Code.gs` は Apps Script エディタへ手動で貼り直す必要があります**
（clasp は使っていません）。片方だけ更新すると新しいフィールドが噛み合わず、
「管理者なのに権限がない」といった症状が出ます。

**保存 (`Ctrl+S`) だけでは反映されません。** ウェブアプリの `/exec` は特定の
バージョンに固定されているため、「デプロイ」→「デプロイを管理」→ 鉛筆アイコン
→ バージョン「新バージョン」→「デプロイ」まで行う必要があります。URL は
変わりません。関数の実行は不要です。

| 変更したもの | Apps Script への貼り直し |
| --- | --- |
| `frontend/` 配下 | 不要 |
| `apps-script/Code.gs` | **必要**（貼り付け＋「デプロイを管理」→新バージョン） |
| 管理者名簿・API_TOKEN 等 | 不要（スクリプト プロパティを編集） |
| 従業員名簿の増減 | 不要（試算表を直接編集） |
| LINE リマインドの曜日・時刻 | 不要（管理頁の「04 LINE 催繳提醒」で変更） |

## 部署

前端走 **GitHub Pages**，後端是 Apps Script Web App，登入需要一組 Google
OAuth 網頁用戶端 ID。完整步驟（含 Authorized JavaScript origins、
Script Properties 要設哪些值、測試檢查清單、常見錯誤對照表）見
[`docs/DEPLOY.md`](docs/DEPLOY.md)。

## 資料流程摘要

1. 頁面載入 → Google 登入取得 ID Token → `GET ?action=whoami` 決定要顯示
   「首次綁定」「員工主畫面」還是「請改用管理頁」。
2. 員工主畫面載入時呼叫 `GET ?action=getWeek&dates=...`，拿到自己下週
   七天的班表，以及「跟自己重疊的同事」清單（不會拿到其他人的完整班表）。
3. 選日期、班別後按「確認設定」，`POST` 立刻寫入試算表對應儲存格
   （依日期自動判斷月份分頁），寫完在背景重新取得重疊資訊。
4. 「排休」寫入 `排休\nday off`，正常班別寫入 `開始時間\n結束時間`，
   格式與店長現有試算表完全一致。
5. 「工時試算」的本月累計來自 `getMonthHours`（只算到今天為止，排休不計）；
   「下週希望排班」由前端直接加總目前已選的時段。

## 已知限制 / 後續可以做的事

- **月份分頁要先建立好**。若日期落在還不存在的月份分頁，該天會被標成
  不可點選，API 回 `sheet_or_date_not_found`；本月分頁不存在時，累計時數
  會顯示 0 並標註原因。目前要手動執行 `addNextMonthSheet()` 補分頁，
  之後可以改成用時間驅動觸發器每月自動跑一次。
- **LINE 提醒也吃「月份分頁要先建立好」這個限制**：下週的分頁不存在時
  不會發訊息，只會在執行記錄留下 `no_month_sheet_for_next_week`。
- **LINE 的 @提及需要 userId**，靠員工自己按「連結 LINE 帳號」（LINE Login）
  或在群組裡打「連携」取得。沒連結的人一樣會被點名，只是沒有 @。
  第三方沒有辦法代替本人取得 userId（`members/ids` 端點限認證帳號才能用）。
- **Webhook 沒有驗簽章**。Apps Script 讀不到 HTTP 標頭，所以 `x-line-signature`
  無法驗證，改用網址上的 `?line={LINE_WEBHOOK_KEY}` 當作合言葉。
- **Email 寫在每個月分頁的 C 欄**。綁定時會把 Email 寫進所有既有月份分頁，
  但**之後新增的月份分頁需要自己帶上 C 欄 Email**（複製既有分頁即可）。
- ID Token 約 1 小時過期，過期後頁面會自動退回登入畫面重新登入。
- 顏色（是否已確認班表）的邏輯沒有處理，只寫入文字內容；店長端仍需自行上色。
- **時薪與金額試算本期不做**。`getMonthHours` 之後可以直接擴充成
  `getMonthTotal` 回傳 `{hours, amount}`，不需要砍掉重做。詳見
  [`docs/REQUIREMENTS-auth-payroll.md`](docs/REQUIREMENTS-auth-payroll.md)
  第八節「未來擴充」。
