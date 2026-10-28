# EGM 審查角色

這個資料夾的 `*.md`（README 除外）原封不動取自 Google 的 Elephant-Goldfish Model：
https://github.com/google/elephant-goldfish-model （commit f0ba151，2026-10-28），授權是 Apache License 2.0（見 LICENSE）。

- `zoom_out.md`、`design_critic.md`、`implementation_readiness.md`、`codebase_details.md`：審查角色（agents/）
- `zoom-out-standard.md`、`feature-spec-standard.md`、`implementation-readiness-standard.md`：評分標準（resources/document_standards/）

FlowPilot 沒有改這些檔案的內容，只在 `../spec.ts` 另外附上 FlowPilot 的任務說明（前端單、不准發明後端、不要求自動化測試等），衝突時以任務說明為準。
要更新就從上游重新複製，並更新上面的 commit。
