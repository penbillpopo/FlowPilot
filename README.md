# FlowPilot

每日開發任務代理：列出 Jira 上進行中的單 → 你勾選 → 產生計畫 → 建立分支 → 交給 Codex 執行你的開發技能。
完整需求與架構見 [docs/spec.md](docs/spec.md)。

## 執行

```bash
npm install
npm run dev      # 開發模式（改程式會自動重新載入）
npm run build && npm start   # 建置後執行
```

關掉視窗不會結束，FlowPilot 會在背景繼續跑；從選單列的「FP」→「結束 FlowPilot」才會真的關掉。

## 設定與資料

都放在 `~/Library/Application Support/FlowPilot/`：

| 檔案 | 用途 |
|---|---|
| `設定.yaml` | Jira 查詢條件、分支規則、四個專案資料夾。第一次啟動時自動產生，改完存檔按「重新整理」就生效 |
| `flowpilot.db` | 執行紀錄（SQLite） |

Jira 的網址、帳號、權杖沿用 `~/Desktop/Project/JiraMcpServer` 的 `.env` 與 `token.txt`，FlowPilot 不另外保存權杖。

## 測試

```bash
npm test
npm run typecheck
LIVE=1 npm test -- tests/live   # 實測：會用到真的 Jira、Codex 與 VS Code
```

## VS Code 輔助外掛

`resources/vscode-companion/` 是一個很小的 VS Code 外掛，第一次需要時 FlowPilot 會自動打包安裝。
它只做一件事：收到 FlowPilot 的通知，就在 VS Code 開一個終端機分頁，執行 `codex resume <對話> --remote unix://` 接上那張單的 AI。
第一次 VS Code 會詢問是否允許這個外掛開啟網址，勾選「不要再詢問」即可。

## 目前進度

- [x] 第 1 階段：應用程式骨架、設定檔、資料庫、列出 Jira 進行中的單並勾選
- [x] 第 2 階段：計畫表（AI 判斷專案與商戶、分支計算、已建立檢查）
- [x] 第 3 階段：資料夾與分支（建立分支、分配資料夾、切換、安裝套件）
- [x] 第 4 階段：執行與追蹤（Codex 常駐服務、執行技能、提問與同意、VS Code 終端機分頁、系統通知）
- [x] 一次只跟一張單對話：問完按「換下一張」移到開發佇列（佇列上限可在設定檔 `maxInDevelopment` 調整）
- [x] 第 5 階段：審查與提交（勾選檔案、environment.ts 預設不提交並還原、不推送）
- [ ] 第 6 階段：多商戶移植（platform-web-copy）
