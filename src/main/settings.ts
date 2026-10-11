// 設定檔：~/Library/Application Support/FlowPilot/設定.yaml
// 第一次啟動時寫入預設內容，之後以使用者編輯的內容為準。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

export interface ProjectRule {
  /** 給 AI 判斷用的說明：這個專案是什麼、單上會怎麼稱呼它 */
  description?: string;
  /** 前台或後台（顯示在計畫表上，讓你一眼看出開的是哪一種） */
  side?: string;
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
  /** 在本機啟動網站的指令，{port} 會換成資料夾設定的連接埠 */
  startCommand?: string;
  /** 開發用的技能（沒寫就用 frontend-development） */
  devSkill: string;
  /** 瀏覽器測試用的技能（沒寫就用 frontend-playwright-test） */
  testSkill: string;
}

export interface FolderSetting {
  name: string;
  path: string;
  project: string;
  /** 在本機啟動網站用的連接埠（每個資料夾不同，才能同時跑） */
  port?: number;
}

export interface Settings {
  jira: {
    /** 沿用 JiraMcpServer 的 .env（JIRA_BASE_URL、JIRA_EMAIL、JIRA_TOKEN_FILE） */
    envFile: string;
    /** 列單的基本條件（狀態另外在畫面上選） */
    filter: string;
    /** 畫面上可以選的狀態（Jira 上顯示的名稱） */
    statuses: string[];
    /** 第一次打開時預設選哪些狀態 */
    defaultStatuses: string[];
  };
  projects: Record<string, ProjectRule>;
  folders: FolderSetting[];
  /** 瀏覽器測試的帳號檔放在哪裡（每個專案一個 {專案}.playwright.json） */
  testConfigDir: string;
  /** 提交時可以選的身分 */
  gitIdentities: { name: string; email: string }[];
}

export const DEFAULT_SETTINGS_YAML = `# FlowPilot 設定。改完存檔，重新整理就生效。

jira:
  # 沿用 JiraMcpServer 專案的連線設定（網址、帳號、權杖檔），FlowPilot 不另外保存權杖
  envFile: ~/Desktop/Project/JiraMcpServer/.env
  # 列單的基本條件：指派給我（狀態在畫面上選）
  filter: assignee = currentUser()
  # 畫面上可以選的狀態，寫 Jira 上顯示的名稱（FlowPilot 會自己換成狀態編號查詢，不受翻譯影響）
  statuses: [待辦事項, 進行中, UAT, READY TO TEST]
  # 第一次打開時預設選哪些狀態
  defaultStatuses: [進行中]

# 瀏覽器測試的帳號檔（每個專案一個 {專案}.playwright.json，沿用測試技能原本讀的檔案）
testConfigDir: ~/.codex/local-test-configs

# 提交時可以選的身分（右邊「Git 改動」的選單；只套用在那一次提交，預設用資料夾的 Git 設定）
gitIdentities:
  - name: ban intellianalyze.com
    email: ban@intellianalyze.com
  - name: penbillpopo
    email: penbillpopo@gmail.com

# 分支規則：{商戶} 是商戶編號，{單號} 是子任務的單號（大寫）
# description 是給 AI 判斷專案用的說明，寫得越清楚判斷越準
# devSkill、testSkill 是開發和瀏覽器測試用的 Codex 技能（沒寫就用 frontend-development、frontend-playwright-test）
projects:
  PlatformWeb:
    side: 前台（玩家端）
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
    # 在本機啟動網站的指令（{port} 換成資料夾的連接埠）
    startCommand: npm start -- --port {port}
  PlatformAdmin:
    side: 後台（GoGaming）
    description: GoGaming 後台（GG、GoGaming BO、Go Gaming 後台、BO）
    baseBranch: version/0.0.1
    branch: ban/{單號}
    startCommand: npm start -- --port {port}
  GoMoneyAdmin:
    side: 後台（GoMoney）
    description: GoMoney 後台（GM、GoMoney）
    baseBranch: version/0.0.1
    branch: ban/{單號}
    # GoMoneyAdmin 的 npm start 已經固定用 5200
    startCommand: npm start

# 固定的專案資料夾：一個資料夾同時只做一張單；port 是在本機啟動網站用的連接埠
folders:
  - name: PlatformWeb
    path: ~/Desktop/Project/PlatformWeb
    project: PlatformWeb
    port: 4200
  - name: PlatformWeb-2
    path: ~/Desktop/PlatformWeb-2
    project: PlatformWeb
    port: 4201
  - name: PlatformAdmin
    path: ~/Desktop/Project/PlatformAdmin
    project: PlatformAdmin
    port: 4300
  - name: GoMoneyAdmin
    path: ~/Desktop/Project/GoMoneyAdmin
    project: GoMoneyAdmin
    port: 5200
`;

const DEFAULT_IDENTITIES = [
  { name: 'ban intellianalyze.com', email: 'ban@intellianalyze.com' },
  { name: 'penbillpopo', email: 'penbillpopo@gmail.com' },
];

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

export function parseSettings(text: string): Settings {
  const raw = YAML.parse(text) as Settings;
  if (!raw?.jira?.envFile) throw new Error('設定檔缺少 jira.envFile');
  raw.jira.filter ||= 'assignee = currentUser()';
  raw.jira.statuses ||= ['待辦事項', '進行中', 'UAT', 'READY TO TEST'];
  raw.jira.defaultStatuses ||= ['進行中'];
  if (!raw.projects || !Array.isArray(raw.folders)) throw new Error('設定檔缺少 projects 或 folders');
  for (const rule of Object.values(raw.projects)) {
    rule.devSkill ||= 'frontend-development';
    rule.testSkill ||= 'frontend-playwright-test';
  }
  for (const folder of raw.folders) {
    if (!raw.projects[folder.project]) throw new Error(`資料夾「${folder.name}」的專案「${folder.project}」沒有分支規則`);
  }
  return {
    ...raw,
    jira: { ...raw.jira, envFile: expandHome(raw.jira.envFile) },
    testConfigDir: expandHome(raw.testConfigDir || '~/.codex/local-test-configs'),
    gitIdentities: (raw.gitIdentities?.length ? raw.gitIdentities : DEFAULT_IDENTITIES).filter((i) => i?.name && i?.email),
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
