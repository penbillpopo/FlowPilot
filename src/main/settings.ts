// 設定檔：~/Library/Application Support/FlowPilot/設定.yaml
// 第一次啟動時寫入預設內容，之後以使用者編輯的內容為準。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

export interface ProjectRule {
  /** 給 AI 判斷用的說明：這個專案是什麼、單上會怎麼稱呼它 */
  description?: string;
  /** 基底分支，可用 {商戶} */
  baseBranch: string;
  /** 新分支名稱，可用 {商戶}、{單號} */
  branch: string;
  /** 有商戶的專案才有 */
  merchants?: number[];
  /** 多商戶時，誰先當來源商戶（沒列到的依數字小到大） */
  sourcePriority?: number[];
  /** 套件群組：同群組切換分支不用重新安裝套件 */
  dependencyGroups?: Record<string, number[]>;
  /** 商戶的品牌名稱（單上常用品牌稱呼商戶），例如 8: [Pubs] */
  merchantNames?: Record<number, string[]>;
}

export interface FolderSetting {
  name: string;
  path: string;
  project: string;
}

export interface Settings {
  jira: {
    /** 沿用 JiraMcpServer 的 .env（JIRA_BASE_URL、JIRA_EMAIL、JIRA_TOKEN_FILE） */
    envFile: string;
    jql: string;
  };
  projects: Record<string, ProjectRule>;
  folders: FolderSetting[];
  /** 計畫表預設的開發技能 */
  defaultSkill: string;
}

export const DEFAULT_SETTINGS_YAML = `# FlowPilot 設定。改完存檔，重新整理就生效。

jira:
  # 沿用 JiraMcpServer 專案的連線設定（網址、帳號、權杖檔），FlowPilot 不另外保存權杖
  envFile: ~/Desktop/Project/JiraMcpServer/.env
  # 列出要做的單：指派給我、狀態是「進行中」
  # 注意：查詢要用狀態的原始名稱 In Progress，畫面上的「進行中」是翻譯過的名稱，查不到
  jql: assignee = currentUser() AND status = "In Progress" ORDER BY updated DESC

# 計畫表預設的開發技能（Codex 技能名稱）
defaultSkill: frontend-workflow

# 分支規則：{商戶} 是商戶編號，{單號} 是子任務的單號（大寫）
# description 是給 AI 判斷專案用的說明，寫得越清楚判斷越準
projects:
  PlatformWeb:
    description: 前台（玩家端網站，Web＋H5），多商戶，每個商戶一條 master 分支。單上常寫 Web、H5、前台，或用 M1、M8 這種商戶代號
    baseBranch: master-{商戶}
    branch: ban/m{商戶}/{單號}
    merchants: [1, 2, 5, 7, 8, 9, 10]
    sourcePriority: [1, 5, 8]
    dependencyGroups:
      A: [1, 2, 7, 8]
      B: [5, 9]
    # 商戶的品牌名稱：單上常用品牌稱呼商戶，填了 AI 才認得出來，例如 8: [Pubs]
    merchantNames: {}
  PlatformAdmin:
    description: GoGaming 後台（GG、GoGaming BO、Go Gaming 後台、BO）
    baseBranch: version/0.0.1
    branch: ban/{單號}
  GoMoneyAdmin:
    description: GoMoney 後台（GM、GoMoney）
    baseBranch: version/0.0.1
    branch: ban/{單號}

# 固定的專案資料夾：一個資料夾同時只做一張單
folders:
  - name: PlatformWeb
    path: ~/Desktop/Project/PlatformWeb
    project: PlatformWeb
  - name: PlatformWeb-2
    path: ~/Desktop/PlatformWeb-2
    project: PlatformWeb
  - name: PlatformAdmin
    path: ~/Desktop/Project/PlatformAdmin
    project: PlatformAdmin
  - name: GoMoneyAdmin
    path: ~/Desktop/Project/GoMoneyAdmin
    project: GoMoneyAdmin
`;

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

export function parseSettings(text: string): Settings {
  const raw = YAML.parse(text) as Settings;
  if (!raw?.jira?.envFile || !raw.jira.jql) throw new Error('設定檔缺少 jira.envFile 或 jira.jql');
  if (!raw.projects || !Array.isArray(raw.folders)) throw new Error('設定檔缺少 projects 或 folders');
  raw.defaultSkill ||= 'frontend-workflow';
  for (const folder of raw.folders) {
    if (!raw.projects[folder.project]) throw new Error(`資料夾「${folder.name}」的專案「${folder.project}」沒有分支規則`);
  }
  return {
    ...raw,
    jira: { ...raw.jira, envFile: expandHome(raw.jira.envFile) },
    folders: raw.folders.map((f) => ({ ...f, path: expandHome(f.path) })),
  };
}

/** 讀取設定；檔案不存在時先寫入預設內容 */
export function loadSettings(file: string): Settings {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, DEFAULT_SETTINGS_YAML, 'utf8');
  }
  return parseSettings(readFileSync(file, 'utf8'));
}
