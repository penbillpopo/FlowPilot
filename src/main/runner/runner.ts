// 執行器：把確認好的計畫變成工作項目，分配資料夾、建立並切換分支、啟動 Codex 執行技能，
// 並追蹤每段對話的進度、提問與同意請求。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BoardState, BranchInfo, ChatEvent, Env, PortSource, RemoveResult, Review, TestReport, TestResult, PendingRequest, SkillInfo, TestState, TicketPlan, WorkStage, WorkStatus, I18nProgress } from '../../shared/types';
import { toEntry } from '../chat';
import { apiHosts, ENVIRONMENT_FILE, readApiUrl, readEnvironment, setEnvironment } from '../environment';
import { reviewBrief } from '../planner/review';
import { configFile, resolveAccount, writeAccountFile } from '../testaccounts';
import type { CodexRpc, RpcMessage } from '../codex/rpc';
import { askStructured, listSkills, runStructured } from '../codex/structured';
import { getLang, t } from '../../shared/i18n';
import { userBrowserToolsOff } from '../codex/user-tools';
import {
  aheadBehind,
  commitsSinceBase,
  createBranch,
  currentBranch,
  dirtyFiles,
  fastForward,
  fetchOrigin,
  fileHash,
  localBranchExists,
  remoteBranchExists,
  runGit,
  switchBranch,
  switchToRemoteBranch,
} from '../git';
import { deriveBranches, fill, seqOf, withSeq } from '../planner/rules';
import type { FolderSetting, Settings } from '../settings';
import { FINISHED, OCCUPYING, type StoredWorkItem, type Store } from '../store';
import type { VSCode } from '../vscode';
import { pickFolder } from './allocate';
import { ACCEPTANCE_NOTE, pendingTests } from '../../shared/acceptance';
import { fillFromCache, type I18nEntry, i18nWorkFile, saveToCache, translationCacheFile, parseProgress, readWorkFile, remoteKeys, translateAll, TRANSLATION_SCHEMA, translateUrls, usedInCode, writeI18nSheet } from '../i18n-sheet';
import { commandPolicy, looksLikeQuestion, parseTestReport, parseTestResult } from './policy';

export interface RunnerDeps {
  store: Store;
  settings: () => Settings;
  /** 開發用：連到共用常駐服務 */
  codex: CodexRpc;
  vscode: VSCode;
  notify: (title: string, body: string, itemId: number) => void;
  onChange: () => void;
  /** AI 正在寫的回覆有新內容（即時顯示用，很頻繁，由呼叫端合併後再送畫面） */
  onStream: (itemId: number, text: string) => void;
  /** 聊天紀錄的即時更新（新的一則、或某一則多了內容） */
  onChat?: (itemId: number, event: ChatEvent) => void;
  log: (message: string) => void;
  /** 暫停：不排程、不準備資料夾、不啟動 AI（用測試資料位置看畫面時，避免動到真正的專案） */
  paused?: boolean;
  /** FlowPilot 的資料位置：瀏覽器測試的截圖紀錄、這次測試的登入資料放這裡（不放進專案） */
  dataDir: string;
  /** 確保資料夾的本機網站有在跑（沒在跑就在資料夾終端機啟動），回傳網址 */
  ensureSite: (folder: string) => Promise<string>;
  /** 測試瀏覽器的寫入防護程式（resources/write-guard.cjs 的完整路徑） */
  writeGuard: string;
  /** 停掉資料夾終端機裡的本機網站（完成這張單時） */
  stopSite?: (folder: string) => void;
  /** 連不連得到這個網址（瀏覽器測試前先確認後端，沒開 VPN 時馬上知道）；不給就用真的連線 */
  canReach?: (url: string) => Promise<boolean>;
}

/** 有任何回應就算連得到（後端回 404、401 也是連上了）；5 秒沒回應或連線失敗就是連不到 */
/** 移植用的技能：照來源分支的改動，在目標商戶的架構裡重新實作 */
const PORT_SKILL = 'platform-web-copy';

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    // 有回應不代表能用：沒開 VPN、IP 不在白名單時，Cloudflare 會回 403 擋下，瀏覽器看起來就像跨網域（CORS）錯誤
    const blocked = response.headers.has('cf-mitigated') || (response.status === 403 && /cloudflare/i.test(response.headers.get('server') ?? ''));
    return !blocked;
  } catch {
    return false;
  }
}

const APPROVAL_METHODS = /requestApproval$|^execCommandApproval$|^applyPatchApproval$/;

/** 瀏覽器工具的名稱：自動測試用無頭的，重測用有頭的 */
const HEADLESS_BROWSER = 'flowpilot_browser_headless';
export const HEADLESS_BROWSER_NAME = HEADLESS_BROWSER;
const HEADED_BROWSER = 'flowpilot_browser';
/** 你和 AI 共用的瀏覽器（Chrome 遠端除錯模式） */
const SHARED_BROWSER = 'flowpilot_shared_browser';

/**
 * 開發用對話的設定（只在 FlowPilot 開的對話裡生效，不改你的 ~/.codex/config.toml）：
 * - 關掉 Codex 內建的「控制電腦／瀏覽器」。實測：開著時 AI 會用它去開 Figma 網頁（在常駐服務裡用不了，就放棄），關掉後才會改用 Figma MCP。
 * - 瀏覽器測試改用 FlowPilot 提供的兩套 Playwright：無頭（自動測試）與有頭（重測給你看），
 *   截圖紀錄放在 FlowPilot 的資料夾，不會弄髒專案；你原本的 playwright 在這些對話裡關掉，AI 才不會用錯。
 */
/** 這張單的測試瀏覽器把擋下、放行的請求記在這裡（每次測試開始時清空） */
export function requestLogFile(dataDir: string, itemId: number): string {
  return join(dataDir, '測試請求', `${itemId}.jsonl`);
}

export function threadConfig(dataDir: string, writeGuard: string, itemId: number, hosts: string[] = []) {
  const outputDir = join(dataDir, '瀏覽器測試紀錄');
  // 兩套測試瀏覽器都套上寫入防護（resources/write-guard.cjs）：會改資料的請求擋下、記下內容、回假的成功
  const browser = (extra: string[]) => ({
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', ...extra, '--isolated', '--caps', 'devtools', '--output-dir', outputDir, '--init-page', writeGuard],
    env: { FLOWPILOT_REQUEST_LOG: requestLogFile(dataDir, itemId), FLOWPILOT_API_HOSTS: hosts.join(',') },
  });
  return {
    features: { computer_use: false, browser_use: false, browser_use_external: false },
    mcp_servers: {
      ...userBrowserToolsOff(),
      [HEADLESS_BROWSER]: browser(['--headless']),
      [HEADED_BROWSER]: browser(['--browser', 'chrome']),
      // 你和 AI 共用的瀏覽器：你平常用的 Chrome（要裝 Playwright 官方的擴充功能），第一次接上時你選要給 AI 的分頁。
      // 不套寫入防護：那是你自己在操作的瀏覽器，套了你手動存檔也會變成假的成功
      [SHARED_BROWSER]: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--extension', '--caps', 'devtools', '--output-dir', outputDir] },
    },
  };
}

/**
 * 給開發、修改時的 AI：看 Figma 的方式。設計稿資料很大，讀進來之後每一步都要帶著重讀，
 * 實際量過：一輪抓了 7 次 get_design_context，Figma 本身只花 1 分鐘，AI 卻花了 7 分多鐘。
 */
const FIGMA_LINE =
  '- 看 Figma 設計稿時：先用 get_metadata 看結構，找出要做的那一塊的節點，只對那幾個節點用 get_design_context 或 get_screenshot；不要整頁抓 get_design_context（資料很大，會拖慢後面每一步）。同一個節點看過就記下重點，不要重複抓。';

/**
 * 新版 Codex 的 AI 是在 exec（執行 JavaScript）裡用 tools.mcp__伺服器__工具 呼叫其他工具，工具清單上看不到伺服器名稱。
 * 實際發生過：說明只寫「flowpilot_shared_browser 這個工具」，AI 在清單上找不到就回「沒有這個工具」（工具其實在）。
 */
export function toolCall(server: string, tool = 'browser_navigate'): string {
  return `tools.mcp__${server}__${tool}`;
}

/**
 * 介面是英文時，請 AI 用英文回覆（每一輪都附，中途切換語言也跟得上）。
 * 附在最後一段、ACCEPTANCE_NOTE 後面：對話框不顯示這段。
 */
function withReplyLanguage(input: object[]): object[] {
  if (getLang() !== 'en') return input;
  return [...input, { type: 'text', text: `${ACCEPTANCE_NOTE}\n- 介面現在是英文：回覆、說明、驗收表裡給人看的文字一律用英文（English）寫。這一條優先於 AGENTS.md 或技能裡「用繁體中文回覆」的規定（那是給中文介面用的）；程式碼、註解、提交訊息照專案原本的規定。`, text_elements: [] }];
}

/** 給開發、修改時的 AI：怎麼用你和它共用的瀏覽器 */
const SHARED_BROWSER_LINE =
  `- 我們共用一個瀏覽器（${SHARED_BROWSER} 這個工具，在 exec 裡用 ${toolCall(SHARED_BROWSER, 'browser_tabs')}、${toolCall(SHARED_BROWSER, 'browser_snapshot')} 這類名稱呼叫；接到我平常用的 Chrome，第一次用時 Chrome 會跳出頁面讓我選要給你的分頁）：我說「看一下我開的畫面」之類的時候，用它看我選的分頁（截圖、頁面結構、主控台、請求），不要另外開測試瀏覽器去看。` +
  '可以幫我點、幫我填，但不要按會存檔、送出、刪除的按鈕：這個瀏覽器沒有寫入防護，資料會真的寫進 SIT／UAT，真的需要就先問我。瀏覽器測試不要用它，照測試的安排用測試瀏覽器。';

/** 給開發、修改時的 AI：我說「改多語系」時怎麼做（翻譯和 Excel 由 FlowPilot 做，AI 只管改程式碼、記下 key 和英文） */
function i18nLine(workFile: string): string {
  return [
    '- 我說「改多語系」「改成多語系」之類的時候，把我指的寫死文字改成多語系（這取代之前說過的 flowpilot-i18n 做法）：',
    '  - 寫死的文字都是英文。key 照專案現有的命名（小寫、底線，參考附近和專案其他地方怎麼取），先用 rg 確認專案裡沒用過。',
    "  - 寫法照專案其他地方（例如 HTML 用 {{ 'key' | translate }}，TS 用專案現有的翻譯服務寫法）；有變數的照專案現有翻譯的格式（例如 ${0}）。",
    `  - 每改完一批（大約 10 段），就把這批附加到「${workFile}」（路徑有空白，要加引號；資料夾不存在就先建），一行一個 JSON：{"key":"…","en-us":"原本的英文"}。用 shell 附加（例如 cat >> "檔案" <<'EOF' … EOF），不要覆蓋掉之前的行。之前已經改好、還沒記進這個檔案的 key 也要補記。`,
    '  - 你不用翻譯其他語言，也不用做 Excel：FlowPilot 會檢查 key、另外翻好其他語言、存到桌面。',
    '  - 不要做一點就停下來回報，一直做到全部改完。做這件事的回覆，最後一行寫「多語系進度：完成」或「多語系進度：未完成（還剩哪些）」；沒在改多語系的回覆不要寫這一行。',
  ].join('\n');
}

/** 拿掉最後的「多語系進度：…」那行再判斷 AI 是不是在問問題（問題常寫在進度那行前面） */
function withoutProgress(message: string): string {
  return message.replace(/^.*多語系進度[：:].*$/gm, '');
}

/**
 * 對話用掉上限的這個比例以上，就在它停下來時整理重點、換新對話。
 * 五成：合成 15 張的單用到五成多開始變懶；四成時 1 個半小時換了 4 次，每次 2～3 分鐘，太頻繁
 */
const HANDOFF_AT = 0.5;
/** 請舊對話整理交接的訊息開頭（對話框接舊紀錄時，從這裡切掉） */
export const HANDOFF_PROMPT_TITLE = '## 整理交接';
const HANDOFF_PROMPT = [
  HANDOFF_PROMPT_TITLE,
  '這段對話太長了，FlowPilot 要換一段新對話接手這張單。請寫一份交接給接手的 AI（用 Markdown）：它只看得到這份交接和開發規則，看不到這段對話。',
  '要包含：',
  '1. 需求和預期結果的重點（合成好幾張的，每張都寫）。',
  '2. 已經做了什麼、改在哪些檔案（用 git status、git diff 實際確認，不要憑記憶）。',
  '3. 我交代過的限制、做過的決定和原因（例如哪些不要改、選了哪個做法）。',
  '4. 還沒做完的事：做到哪裡、下一步是什麼。',
  '5. 測試狀況、還沒解決的問題、在等我確認的事。',
  '具體寫，不要客套、不要重複開發規則。這次只整理，不要改任何檔案。',
].join('\n');
const HANDOFF_SCHEMA = { type: 'object', additionalProperties: false, required: ['handoff'], properties: { handoff: { type: 'string' } } };
/** 新對話讀交接的訊息開頭 */
const HANDOFF_TITLE = '## 換新對話：交接';

// i18n-keys：顯示時才翻
const STAGE_DONE: Partial<Record<WorkStage, string>> = {
  autotest: '自動測試完成，等你手動測試',
  fix: '改好了，等你測試',
  retest: '重測完成，等你確認',
  manual: '需求比對完了，等你測試',
};

/**
 * 要 AI 在最後附上的驗收表：以需求為主軸，每一條寫改了什麼、為什麼、改在哪、會影響哪裡、怎麼測，加上測試結果。
 * 由開發的 AI 寫（它最清楚為什麼這樣改）；FlowPilot 再拿實際改到的檔案核對有沒有漏講。
 */
export function reportLines(review: Review | null): string[] {
  const acceptance = review?.acceptance ?? [];
  return [
    acceptance.length
      ? `- 預期結果要一條一條對照：${acceptance.map((a, i) => `${i + 1}. ${a}`).join('　')}`
      : '- 預期結果要一條一條對照（照單上的「預期結果」拆成一條一句）。',
    '- 回覆最後、在「測試結果」那一行之前，附上驗收表（FlowPilot 會讀它畫成給我手動測試用的卡片；JSON 要合法）。我是操作者，不是看程式碼的人；我測試時是對著 Jira 單一條一條測，所以：',
    '  - text：照抄 Jira「預期結果 / Acceptance Criteria」的原文，一條就是一個項目，不要改寫、不要拆細、不要自己換說法。Jira 沒寫預期結果時，才由你從需求整理幾條，並加 "fromAi": true。',
    '  - open、act、expect：給我測的三行步驟，每行一句白話、不寫程式名詞（元件、API、狀態值都不要）：open 打開哪一頁（哪個商戶、要不要先登入）、act 做什麼操作、expect 應該看到什麼。',
    '  - page：要測的頁面路徑，要能直接打開（例如 /order/list）；路由有參數就填一個實際存在、你測過的網址，找不到就寫空字串。',
    '  - shot：這一條你在瀏覽器測過、畫面正確時，用 browser_take_screenshot 截一張圖（filename 填 ac-<單號>-<no>.png），這裡只填檔名；沒截就省略。這張圖會給我當「應該長這樣」的參考。',
    '  - needYou：只有你真的沒辦法自己確認的才是 true（例如要真實寫入、要另一個系統配合、要看操作手感、你沒測到）；你在瀏覽器確實測過、有截圖或證據的是 false。要我親手測的盡量精簡，通常不超過 5 條。',
    '  - result、note：你的測試結果（通過、沒過或沒測）和一句證據。',
    '  - change、why、files、impact：給開發參考的資訊（我測試時不看）：change 改了什麼、why 依據哪一段、files 改到的檔案路徑、impact 也會影響到的頁面（改到共用的元件、服務、樣式時，一定要實際搜尋有哪些地方用到；沒有就寫空字串）。',
    '  - attention：要我特別注意的地方，一條一句：Jira 沒寫清楚由你自己判斷的、跟 Jira 或設計稿不一致的、需求範圍以外也被改到的。沒有就給空陣列。',
    '  - otherChanges：跟某一條預期結果無關、但也改到的東西。這張單改到的每一個檔案，都要出現在某一條的 files 或 otherChanges 裡（environment.ts 除外）。',
    '  - manual：其他要我手動測、但不屬於任何一條預期結果的項目，一項一句白話。',
    '  ```flowpilot-test',
    '  {"attention":["…"],"acceptance":[{"no":1,"text":"Jira 預期結果原文","open":"打開 m10 的個人資料頁（先登入）","act":"點右上角的設定","expect":"看到隱身模式是開的","page":"/…","shot":"ac-ALL-1-1.png","needYou":false,"result":"通過","note":"…","change":"…","why":"…","files":["src/…"],"impact":"…"}],"otherChanges":[{"change":"…","why":"…","files":["src/…"],"impact":"…"}],"manual":["…"]}',
    '  ```',
  ];
}

/**
 * 修改時附在訊息最後：請 AI 更新驗收表（畫面上不顯示這段）。
 * 只寫這次有變的條目，其他的 FlowPilot 沿用上一版：以前要它每次重寫完整的表，
 * 合成 15 張的單光重寫就要寫好幾千字，問一句簡單的話也要等三分多鐘（實際量過）。
 */
function acceptanceUpdateNote(review: Review | null): string {
  return [
    '',
    '',
    ACCEPTANCE_NOTE,
    '- 這次沒有改任何檔案、也沒有在瀏覽器測驗收項目（只是回答問題、查東西）：不用附驗收表。',
    '- 有改檔案，或在瀏覽器實際測了驗收項目（包括我叫你測、看我的模式）：在回覆最後附上驗收表的「更新」，JSON 裡加 "update": true，只寫這次有變的部分，沒動到的不要寫（FlowPilot 會沿用上一版）：',
    '  - acceptance 只放這次有改到或有測到的條目，no 用原本的編號，該條的欄位要寫完整。',
    '  - 這次在瀏覽器實際測過、確定通過的：result 寫「通過」、needYou 寫 false、note 寫看到什麼（證據），能截圖就附 shot。FlowPilot 會把它從「要你測」移走，所以沒有真的測到就不要寫通過。',
    '  - 有改到、但沒重新測的：result 寫「沒測」、needYou 寫 true。測了沒過的：result 寫「沒過」，note 寫原因。',
    '  - 「其他要你手動測的」項目，這次測過、確定通過的，照抄原文放進 manualPassed（陣列）。',
    '  - otherChanges、attention、manual 只放這次新增的。',
    '  ```flowpilot-test',
    '  {"update":true,"acceptance":[{"no":3,"text":"Jira 預期結果原文","open":"…","act":"…","expect":"…","page":"/…","needYou":false,"result":"通過","note":"看到…","shot":"ac-ALL-1-3.png","change":"…","why":"…","files":["src/…"],"impact":"…"}],"manualPassed":["其他手動項目的原文"],"otherChanges":[],"attention":[],"manual":[]}',
    '  ```',
    '- 各欄位怎麼寫，跟之前一樣：',
    ...reportLines(review).slice(2, -3),
  ].join('\n');
}

/** 檢查計畫要比對設計稿、單上也有 Figma 連結時，加進測試指示的要求 */
function designCompareLines(review: Review | null): string[] {
  const figma = (review?.resources ?? []).filter((r) => r.kind === 'figma').map((r) => r.url).slice(0, 3);
  if (!review?.checks?.designCompare.need || !figma.length) return [];
  return [
    `- 比對設計稿：測到新畫面時截圖，用 Figma 工具看設計稿（${figma.join('、')}），比對流程、欄位、按鈕、文案有沒有明顯不一樣；間距、排版、顏色這類細節不用管。差很多的列在結果裡。`,
  ];
}

/** 測試做完後給人看的一句話 */
function testActivity(label: string, result: TestResult): string {
  const why = result.reason ? t('：{reason}', { reason: result.reason }) : '';
  switch (result.kind) {
    case 'passed':
      return t('{label}通過，等你手動測試', { label });
    case 'partial':
      return t('{label}部分通過{why}，等你手動測試', { label, why });
    case 'failed':
      return t('{label}沒測成{why}', { label, why });
    default:
      return t('{label}做完了，看最後的結果，等你手動測試', { label });
  }
}

/** 瀏覽器測試切換 SIT／UAT 時會改的檔案 */
function isEnvironmentFile(path: string): boolean {
  return /(^|\/)src\/environments\/environment[^/]*\.ts$/.test(path);
}

function short(text: string, max = 120) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 在資料夾裡用登入 shell 執行（拿得到 nvm 的 node／npm） */
/** 讀 .git/HEAD 看資料夾在哪條分支（不開 git 程序：每次叫 AI 做事前都要看）；不在分支上回空字串，讀不到回 null */
function headBranch(cwd: string): string | null {
  try {
    const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim();
    return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? '';
  } catch {
    return null;
  }
}

function shell(cwd: string, command: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(process.env.SHELL || '/bin/zsh', ['-l', '-c', command], { cwd, timeout: timeoutMs, env, maxBuffer: 50 * 1024 * 1024 }, (error, _out, stderr) => {
      if (error) reject(new Error(short(stderr.toString().split('\n').filter(Boolean).slice(-3).join(' ') || error.message, 300)));
      else resolve();
    });
  });
}

export class Runner {
  /** 每段對話目前那一輪的編號（補充指示、停止時要用） */
  private turns = new Map<string, string>();
  private skills: SkillInfo[] | null = null;
  /**
   * 子 AI 的對話編號 → 屬於哪張單。Codex 的多 AI 協作沒辦法從設定關掉，AI 有時會自己開子 AI；
   * 子 AI 要求同意時用的是自己的對話編號，FlowPilot 不認得就不會回，兩邊互等卡住（實際卡過 20 分鐘）
   */
  private childThreads = new Map<string, number>();
  /** AI 正在寫、還沒寫完的回覆（只放記憶體；寫完才存進資料庫） */
  private streaming = new Map<number, string>();
  /** 你在準備階段已經同意的事（接著未提交的修改做、用本機版本繼續） */
  private allowed = new Map<number, Set<'dirty' | 'diverged'>>();
  /** 準備好之後，交代給 AI 時要說明的現況 */
  private prepared = new Map<number, { continuing: boolean; commits: number; dirty: number; rebase?: { behind: number; conflict: boolean } }>();
  private scheduling = false;
  private rescheduleRequested = false;

  constructor(private readonly deps: RunnerDeps) {
    deps.codex.on((message) => this.handle(message).catch((e) => deps.log(`處理 Codex 訊息失敗：${e.message}`)));
    setInterval(() => {
      if (this.deps.store.listWorkItems().some((i) => i.status === 'queued')) void this.schedule();
    }, 60_000);
    deps.codex.setDisconnectHandler(() => {
      deps.log('跟 Codex 常駐服務的連線中斷，5 秒後重新連線');
      setTimeout(() => this.resubscribe().catch((e) => deps.log(`重新連線失敗：${e.message}`)), 5000);
    });
  }

  // ---- 看板 ----

  board(): BoardState {
    const { store } = this.deps;
    const items = store.listWorkItems();
    const occupiedBy = new Map(items.filter((i) => i.folder && OCCUPYING.includes(i.status)).map((i) => [i.folder!, i.id]));
    return {
      folders: this.deps.settings().folders.map((f) => ({ ...f, itemId: occupiedBy.get(f.name) ?? null })),
      items: items.map((full) => {
        const { branchCreated: _, commitSha: __, oldThreads: ___, ...item } = full;
        return { ...item, i18n: this.i18nProgress(full) };
      }),
      pendingRun: store.pendingPlannedRun(),
      streaming: Object.fromEntries(this.streaming),
    };
  }

  /** 改多語系的進度：翻譯中、翻完的看記下的結果；工作檔還在就是 AI 還在改（或停下來了） */
  private i18nProgress(item: StoredWorkItem): I18nProgress | null {
    if (!['running', 'waiting', 'review'].includes(item.status) && !this.i18nRuns.has(item.id)) return null;
    const run = this.i18nRuns.get(item.id);
    const workFile = i18nWorkFile(this.deps.dataDir, item.id);
    const count = readWorkFile(workFile).length;
    if (run?.phase === 'translating') return run;
    if (count > 0) {
      const at = statSync(workFile).birthtimeMs; // 從 AI 記下第一條開始算
      return { phase: this.turns.get(item.threadId ?? '') || item.status === 'running' ? 'working' : 'paused', count, at };
    }
    return run ?? null;
  }

  /** 這張單最近存好的多語系檔（給「在 Finder 顯示」） */
  i18nFile(id: number): string | null {
    return this.i18nRuns.get(id)?.path ?? null;
  }

  /** 進行中的單停下來等你、做完或失敗時跳系統通知（每一張進行中的單都會通知） */
  private notify(id: number, title: string, body: string) {
    this.deps.notify(title, body, id);
  }

  /** 這張單的資料夾有沒有改動：比基底多的提交，或還沒提交的修改（environment.ts 不算） */
  private async hasChanges(item: StoredWorkItem): Promise<boolean> {
    const cwd = this.folderPath(item.folder!);
    if ((await currentBranch(cwd).catch(() => '')) !== item.branch) return true; // 不在這張單的分支上：看不出來，不擋
    if ((await commitsSinceBase(cwd, item.baseBranch)) > 0) return true;
    return (await dirtyFiles(cwd)).some((f) => !isEnvironmentFile(f));
  }

  /** 已經告訴過「有共用瀏覽器」的對話（這次啟動後） */
  private sharedBrowserTold = new Set<string>();
  /** 每段對話目前用掉上限的幾成 */
  private contextUse = new Map<string, number>();
  /** 換新對話後、正在讀交接的對話：讀完回到換之前的狀態 */
  private warmups = new Map<string, { status: WorkStatus; activity: string; done?: () => void }>();
  /** 多語系翻譯中、翻完的結果（顯示在對話框上方） */
  private i18nRuns = new Map<number, I18nProgress & { path?: string }>();
  /** 正在整理重點、換新對話的單 */
  private handingOff = new Set<number>();
  /** 你選了不跑自動測試的單：整理完驗收表時狀態寫「已跳過自動測試」 */
  private skippedAutotest = new Set<number>();
  /** 改多語系做到一半的單：自動叫 AI 繼續、請它換 key 名字的次數 */
  /** 你叫過它改多語系的單（工作檔還沒有內容時，用來分辨 AI 寫的進度是不是真的在做這件事） */
  private i18nRequested = new Set<number>();
  private i18nJobs = new Map<number, { continues: number; renames: number; paused?: boolean }>();
  /** 修改那一輪開始前資料夾的樣子：結束時比對，看這一輪到底有沒有改到檔案 */
  private fixSnapshots = new Map<number, string>();

  /** 資料夾目前的樣子（最新提交＋還沒提交的修改內容），用來比對前後有沒有變 */
  private async folderSnapshot(item: StoredWorkItem): Promise<string> {
    const cwd = this.folderPath(item.folder!);
    const git = (args: string[]) =>
      new Promise<string>((resolve) => execFile('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (_e, stdout) => resolve(String(stdout ?? ''))));
    const [head, status, diff] = await Promise.all([git(['rev-parse', 'HEAD']), git(['status', '--porcelain']), git(['diff', 'HEAD'])]);
    return head.trim() ? `${head}\n${status}\n${diff}` : ''; // 不是 git 資料夾：看不出來，不比對
  }

  /** 工作台以外的地方改了單（例如發了 PR），通知畫面更新 */
  notifyChanged() {
    this.deps.onChange();
  }

  private update(id: number, patch: Parameters<Store['updateWorkItem']>[1]): StoredWorkItem {
    const item = this.deps.store.updateWorkItem(id, patch);
    this.deps.onChange();
    return item;
  }

  // ---- 開始執行 ----

  /**
   * 把確認好的計畫變成工作項目並開始排程（多商戶只建立來源，目標之後移植）。
   * 同一條分支在看板上已經有還沒結束的工作，就不重複建立，回傳被略過的分支。
   */
  startRun(runId: number): string[] {
    const { store } = this.deps;
    const plans = store.getPlan(runId);
    if (!plans) throw new Error(t('第 {runId} 次執行沒有確認好的計畫', { runId }));
    const settings = this.deps.settings();
    const items = plans.flatMap((plan: TicketPlan) => {
      const branches = deriveBranches(plan, settings);
      return branches
        .filter((b) => b.role !== 'target')
        .map((b) => ({
          runId,
          ticketKey: plan.ticket.key,
          ticketSummary: plan.ticket.summary,
          mainKey: plan.ticket.parent?.key ?? plan.ticket.key,
          mainUrl: plan.ticket.parent?.url ?? plan.ticket.url,
          project: b.project,
          merchant: b.merchant,
          targetMerchants: branches.filter((t) => t.role === 'target' && t.project === b.project).map((t) => t.merchant!),
          branch: b.branch,
          baseBranch: b.baseBranch,
          skill: settings.projects[b.project]?.devSkill ?? 'frontend-development',
          prTitle: plan.prTitle,
          preferredFolder: plan.entries.find((e) => e.project === b.project)?.folder ?? null,
          members: (plan.ticket.members ?? []).map((m) => ({ key: m.key, summary: m.summary, url: m.url })),
        }));
    });
    const skipped = items.filter((i) => store.activeWorkItem(i.project, i.branch)).map((i) => i.branch);
    const fresh = items.filter((i) => !skipped.includes(i.branch));
    if (fresh.length) store.createWorkItems(fresh);
    else store.markRunStarted(runId);
    if (skipped.length) this.deps.log(`第 ${runId} 次執行：這些分支已經有進行中的工作，不重複建立：${skipped.join('、')}`);
    this.deps.onChange();
    void this.schedule();
    return skipped;
  }

  /**
   * 排程：同時進行的單數由資料夾決定（每個資料夾一次一張）。
   * 每個專案照計畫順序，有空的資料夾就開始下一張；拿不到資料夾的留在排隊，並在說明寫出原因。
   * 不會自己結束任何一張單，結束由你決定（完成或移除）。
   */
  async schedule(): Promise<void> {
    if (this.deps.paused) return;
    if (this.scheduling) {
      this.rescheduleRequested = true;
      return;
    }
    this.scheduling = true;
    try {
      do {
        this.rescheduleRequested = false;
        await this.startQueued();
        this.deps.onChange();
      } while (this.rescheduleRequested);
    } finally {
      this.scheduling = false;
    }
  }

  private async startQueued(): Promise<void> {
    const settings = this.deps.settings();
    const items = this.deps.store.listWorkItems();
    const occupiedBy = new Map(items.filter((i) => i.folder && OCCUPYING.includes(i.status)).map((i) => [i.folder!, i]));
    const blockedProjects = new Set<string>();
    for (const next of items.filter((i) => i.status === 'queued')) {
      // 同一個專案照順序：前面那張還拿不到資料夾，後面的也先等
      if (blockedProjects.has(next.project)) continue;
      const rule = settings.projects[next.project];
      if (!rule) {
        this.update(next.id, { status: 'blocked', activity: t('設定檔裡沒有「{project}」的規則', { project: next.project }) });
        continue;
      }
      // 退役的資料夾不再分給新的卡片
      const projectFolders = settings.folders.filter((f) => f.project === next.project && !f.retired);
      // 分支只在退役資料夾的本機、遠端又沒有：在新資料夾開工會漏掉那些提交，先請你推送
      const stranded: FolderSetting[] = [];
      for (const f of settings.folders.filter((x) => x.project === next.project && x.retired)) if (await localBranchExists(f.path, next.branch).catch(() => false)) stranded.push(f);
      if (stranded.length && !(await remoteBranchExists(stranded[0].path, next.branch).catch(() => false))) {
        let usable = false;
        for (const f of projectFolders) if (await localBranchExists(f.path, next.branch).catch(() => false)) usable = true;
        if (!usable) {
          this.update(next.id, { status: 'blocked', activity: t('{branch} 只在退役的資料夾 {folders}，遠端還沒有：先在那裡推送，再按「重試」', { branch: next.branch, folders: stranded.map((f) => f.name).join(t('、')) }) });
          continue;
        }
      }

      // 分支已經存在於某個資料夾：之前的提交只在那裡，一定要用那個資料夾
      const holding: string[] = [];
      for (const f of projectFolders) if (await localBranchExists(f.path, next.branch).catch(() => false)) holding.push(f.name);
      let onlyFolder: string | null = null;
      if (holding.length === 1) onlyFolder = holding[0];
      else if (holding.length > 1) {
        if (!next.preferredFolder || !holding.includes(next.preferredFolder)) {
          this.update(next.id, { status: 'blocked', activity: t('分支在 {folders} 都有，請在計畫表選擇要用哪一個資料夾', { folders: holding.join(t('、')) }) });
          continue;
        }
        onlyFolder = next.preferredFolder;
      }

      // 每個資料夾不能用的原因：被哪張單佔住，或有未提交的修改（資料夾本來就在這條分支上的除外：那是之前做到一半的進度，準備時會問你）
      const reasons: string[] = [];
      const busy = new Set<string>();
      const branches: Record<string, string> = {};
      for (const f of projectFolders) {
        if (onlyFolder && f.name !== onlyFolder) continue;
        const owner = occupiedBy.get(f.name);
        if (owner) {
          busy.add(f.name);
          reasons.push(t('{folder} 正在做 {ticket}', { folder: f.name, ticket: owner.ticketKey }));
          continue;
        }
        branches[f.name] = await currentBranch(f.path).catch(() => '');
        if (branches[f.name] === next.branch) continue;
        // environment.ts 是測試切 SIT／UAT 改的，準備時會還原，不算不乾淨（實際發生過：只因為它，第二個資料夾一直空著不能用）
        const dirty = (await dirtyFiles(f.path).catch(() => [t('（讀不到 git 狀態）')])).filter((file) => !isEnvironmentFile(file));
        if (dirty.length) {
          busy.add(f.name);
          reasons.push(t('{folder} 有未提交的修改（{files}{more}）', { folder: f.name, files: dirty.slice(0, 2).join(t('、')), more: dirty.length > 2 ? t(' 等') : '' }));
        }
      }
      const folder = pickFolder(next, settings.folders, busy, branches, rule, onlyFolder);
      if (!folder) {
        blockedProjects.add(next.project);
        this.update(next.id, { activity: t('排隊中：{reason}', { reason: reasons.join(t('；')) || t('等資料夾空出來') }) });
        continue;
      }
      occupiedBy.set(folder.name, next);
      this.update(next.id, { folder: folder.name, lane: 'development', status: 'preparing', activity: t('準備資料夾') });
      void this.prepare(next.id);
    }
  }

  private folderPath(name: string): string {
    const folder = this.deps.settings().folders.find((f) => f.name === name);
    if (!folder) throw new Error(t('設定檔裡沒有資料夾「{name}」', { name }));
    if (!existsSync(folder.path)) throw new Error(t('找不到資料夾「{name}」（{path}），請檢查設定檔', { name, path: folder.path }));
    return folder.path;
  }

  /** 停下來問你；回答後從頭重新準備 */
  private ask(id: number, key: 'dirty' | 'diverged', question: string, continueLabel: string) {
    const item = this.update(id, {
      status: 'waiting',
      activity: question,
      pending: { kind: 'decision', requestId: key, question, options: [{ id: 'continue', label: continueLabel }, { id: 'stop', label: t('先不要，停止這張單') }] },
    });
    this.notify(id, t('{ticket} 要你決定', { ticket: item.ticketKey }), question);
  }

  /**
   * 準備資料夾，然後啟動 AI：
   * - 分支不存在：從遠端最新的基底分支建立並切換（新開發）
   * - 分支已存在：切換過去繼續開發；只在遠端就從遠端建立本機分支
   * - 資料夾本來就在這條分支、而且有未提交的修改：先問你要不要接著做
   * - 本機落後遠端：快轉；本機和遠端各有新提交（分歧）：先問你
   */
  private async prepare(id: number): Promise<void> {
    const item = this.deps.store.getWorkItem(id)!;
    const cwd = this.folderPath(item.folder!);
    const allowed = this.allowed.get(id) ?? new Set();
    try {
      this.update(id, { activity: t('抓遠端最新狀態') });
      await fetchOrigin(cwd);

      const here = await currentBranch(cwd);
      const remote = await remoteBranchExists(cwd, item.branch);
      let continuing = true;
      if (here === item.branch) {
        const dirty = await dirtyFiles(cwd);
        if (dirty.length && !allowed.has('dirty')) {
          return this.ask(
            id,
            'dirty',
            t('{folder} 已經在 {branch}，有 {count} 個未提交的修改（{files}{more}）。要接著這些修改繼續開發嗎？', { folder: item.folder ?? '', branch: item.branch, count: dirty.length, files: dirty.slice(0, 3).join(t('、')), more: dirty.length > 3 ? t(' 等') : '' }),
            t('接著這些修改繼續開發'),
          );
        }
      } else {
        // 要切到別的分支：environment.ts（測試切環境改的）先還原，其他的修改才擋下來
        for (const file of (await dirtyFiles(cwd)).filter(isEnvironmentFile)) await runGit(cwd, ['restore', '--staged', '--worktree', '--', file]);
        const dirty = await dirtyFiles(cwd);
        if (dirty.length) {
          this.update(id, {
            status: 'blocked',
            activity: t('資料夾目前在 {branch}，有未提交的修改（{files}{more}），請先處理後按「重試」', { branch: here || t('（不在任何分支）'), files: dirty.slice(0, 3).join(t('、')), more: dirty.length > 3 ? t(' 等 {count} 個', { count: dirty.length }) : '' }),
          });
          return;
        }
        const lockBefore = await fileHash(cwd, 'package-lock.json');
        if (await localBranchExists(cwd, item.branch)) {
          this.update(id, { activity: t('切換到已存在的分支 {branch}', { branch: item.branch }) });
          await switchBranch(cwd, item.branch);
        } else if (remote) {
          this.update(id, { activity: t('從遠端切換到已存在的分支 {branch}', { branch: item.branch }) });
          await switchToRemoteBranch(cwd, item.branch);
        } else {
          continuing = false;
          this.update(id, { activity: t('從 origin/{base} 建立分支 {branch}', { base: item.baseBranch, branch: item.branch }) });
          await createBranch(cwd, item.branch, item.baseBranch);
          await switchBranch(cwd, item.branch);
        }
        const lockAfter = await fileHash(cwd, 'package-lock.json');
        if (lockBefore !== lockAfter || !existsSync(join(cwd, 'node_modules'))) {
          this.update(id, { activity: t('套件不同，安裝套件中（npm install，可能要幾分鐘）') });
          await shell(cwd, 'npm install', 20 * 60_000);
        }
      }

      if (remote && continuing) {
        const { ahead, behind } = await aheadBehind(cwd, item.branch);
        if (behind > 0 && ahead === 0) {
          this.update(id, { activity: t('本機落後遠端 {count} 個提交，快轉到最新', { count: behind }) });
          await fastForward(cwd, item.branch);
        } else if (behind > 0 && ahead > 0 && !allowed.has('diverged')) {
          return this.ask(
            id,
            'diverged',
            t('{branch} 的本機和遠端各有新的提交（本機多 {ahead} 個、遠端多 {behind} 個）。要用本機的版本繼續開發嗎？（不會動到遠端）', { branch: item.branch, ahead, behind }),
            t('用本機版本繼續'),
          );
        }
      }

      // 基底有新的提交：開發前先 rebase 到最新（有沒提交的修改就先暫存、做完放回）。
      // 有衝突就停在 rebase 中，交給 AI 先解完再開發（使用者平常也是自己解）
      let rebase: { behind: number; conflict: boolean } | undefined;
      const behindBase = Number((await runGit(cwd, ['rev-list', '--count', `HEAD..origin/${item.baseBranch}`])).stdout.trim() || 0);
      if (continuing && behindBase > 0) {
        this.update(id, { activity: t('基底 {base} 有 {count} 個新提交，rebase 到最新', { base: item.baseBranch, count: behindBase }) });
        const result = await runGit(cwd, ['-c', 'core.editor=true', 'rebase', '--autostash', `origin/${item.baseBranch}`], 120_000);
        const inProgress = existsSync(join(cwd, '.git', 'rebase-merge')) || existsSync(join(cwd, '.git', 'rebase-apply'));
        if (result.code !== 0 && !inProgress) throw new Error(t('rebase 失敗：{error}', { error: result.stderr.trim().split('\n').slice(-2).join(' ') }));
        rebase = { behind: behindBase, conflict: result.code !== 0 };
      }

      this.prepared.set(id, {
        rebase,
        continuing,
        commits: continuing ? await commitsSinceBase(cwd, item.baseBranch) : 0,
        dirty: (await dirtyFiles(cwd)).length,
      });
      await this.startAgent(id);
    } catch (error) {
      if (['removed', 'stopped'].includes(this.deps.store.getWorkItem(id)!.status)) return;
      this.update(id, { status: 'failed', activity: t('準備失敗：{error}', { error: (error as Error).message }) });
      this.notify(id, t('{ticket} 準備失敗', { ticket: item.ticketKey }), (error as Error).message);
      void this.schedule();
    }
  }

  /** 回答準備階段的問題 */
  async decide(id: number, optionId: string) {
    const item = this.deps.store.getWorkItem(id)!;
    if (item.pending?.kind !== 'decision') throw new Error(t('目前沒有要你決定的事'));
    if (optionId === 'stop') {
      this.allowed.delete(id);
      this.update(id, { status: 'stopped', activity: t('你選擇先不要做這張單'), pending: null });
      void this.schedule();
      return;
    }
    const allowed = this.allowed.get(id) ?? new Set();
    allowed.add(item.pending.requestId as 'dirty' | 'diverged');
    this.allowed.set(id, allowed);
    this.update(id, { status: 'preparing', activity: t('繼續準備'), pending: null });
    void this.prepare(id);
  }

  private async skillPath(name: string): Promise<string> {
    if (!this.skills?.some((s) => s.name === name)) {
      this.skills = await listSkills(this.deps.codex, this.deps.settings().folders[0]?.path ?? process.cwd());
    }
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) throw new Error(t('Codex 找不到技能「{name}」', { name }));
    return skill.path;
  }

  /**
   * 換一個全新的共用瀏覽器：結束 FlowPilot 開的所有共用瀏覽器工具，再請 Codex 重新載入（只重開結束掉的，別的工具不受影響）。
   * 為什麼：Chrome 的 Playwright 擴充功能一次只接一個。換新對話、或別張單用過之後，舊的那個還佔著 Chrome，
   * 新的一直等不到連線，「看我的」就沒反應（實際發生過：對話太長換新對話後，看我的再也接不上）。
   * 共用瀏覽器是用到才連線，重開後下一次使用時 Chrome 會再跳出選分頁的頁面。
   */
  async resetSharedBrowser(): Promise<void> {
    // 共用瀏覽器才有 --extension（測試瀏覽器是 --isolated），這組參數只有 FlowPilot 這樣開
    await new Promise<void>((resolve) => execFile('pkill', ['-f', '@playwright/mcp@latest --extension --caps devtools|playwright-mcp --extension --caps devtools'], () => resolve()));
    await new Promise((r) => setTimeout(r, 500));
    await this.deps.codex.request('config/mcpServer/reload', undefined).catch((error) => this.deps.log(`重新載入共用瀏覽器失敗：${(error as Error).message}`));
  }

  /** 開一段開發用的新對話（開工、對話太長換新對話都用這個） */
  private async newThread(item: StoredWorkItem, nameSuffix = ''): Promise<string> {
    const { codex } = this.deps;
    const cwd = this.folderPath(item.folder!);
    const config = threadConfig(this.deps.dataDir, this.deps.writeGuard, item.id, apiHosts(cwd));
    const { thread } = await codex.request<{ thread: { id: string } }>(
      'thread/start',
      {
        cwd,
        // 每個指令都先問 FlowPilot，由 FlowPilot 決定自動同意或轉給你（見 policy.ts）
        approvalPolicy: 'untrusted',
        sandbox: 'danger-full-access',
        config,
      },
      180_000, // 第一次要下載瀏覽器工具，比較久
    );
    await codex.request('thread/name/set', { threadId: thread.id, name: `${item.ticketKey}｜${item.merchant ? `m${item.merchant}｜` : ''}${item.folder}${nameSuffix}` }).catch(() => {});
    return thread.id;
  }

  private async startAgent(id: number): Promise<void> {
    const { codex } = this.deps;
    const item = this.deps.store.getWorkItem(id)!;
    if (item.status === 'removed' || item.status === 'stopped') return; // 準備途中你移除或停止了
    const cwd = this.folderPath(item.folder!);
    await codex.start();
    this.update(id, { activity: t('啟動 Codex') });
    // 一律開新的對話：單離開工作台就不留紀錄，不接回以前的對話（舊對話裡的舊指示會干擾）
    const thread = { id: await this.newThread(item) };
    this.update(id, { threadId: thread.id, status: 'running', stage: 'develop', activity: t('開發中') });

    const state: { continuing: boolean; commits: number; dirty: number; rebase?: { behind: number; conflict: boolean } } = this.prepared.get(id) ?? { continuing: false, commits: 0, dirty: 0 };
    this.prepared.delete(id);
    this.allowed.delete(id);
    const branchLine = state.continuing
      ? `- 這是已經存在的分支 ${item.branch}（基底 origin/${item.baseBranch}），之前已經有開發內容：比基底多 ${state.commits} 個提交、${state.dirty} 個未提交的修改。` +
        `請先看過現有的差異（git diff origin/${item.baseBranch}...HEAD 與 git status），了解做到哪裡，再接著完成剩下的部分；不要重做已經完成的內容，也不要丟掉未提交的修改。FlowPilot 已經切換好分支，不要切換分支。`
      : `- FlowPilot 已經在這個資料夾建立並切換到分支 ${item.branch}（從 origin/${item.baseBranch} 開出）。請直接在目前分支開發，不要切換分支。`;
    const skill = item.portOf ? PORT_SKILL : this.deps.settings().projects[item.project]?.devSkill ?? item.skill;
    const brief = reviewBrief(this.deps.store.getReview(item.ticketKey)?.review ?? null);
    const rebaseLine = !state.rebase
      ? ''
      : state.rebase.conflict
        ? `- 【先處理】FlowPilot 正在把分支 rebase 到最新的 origin/${item.baseBranch}（基底有 ${state.rebase.behind} 個新提交），遇到衝突停住了。請先解衝突：用 git status 看哪些檔案衝突，照兩邊的意圖合併好，git add 之後用 GIT_EDITOR=true git rebase --continue 繼續，直到 rebase 完成；不要 git rebase --abort。在回覆裡說明每個衝突怎麼解的。rebase 完成後再開始開發。`
        : `- FlowPilot 已經把分支 rebase 到最新的 origin/${item.baseBranch}（基底有 ${state.rebase.behind} 個新提交），沒有衝突。`;
    const src = item.portOf;
    const sourceRef = src ? await this.fetchPortSource(cwd, item.project, src) : '';
    const instructions = src ? [
      `請使用 $${skill} 把 ${item.ticketKey} 從商戶 ${src.merchant} 移植到商戶 ${item.merchant}。以下是 FlowPilot 的安排，跟技能預設規則不同的地方以這裡為準：`,
      rebaseLine,
      '',
      `- 來源：${src.baseBranch} → ${src.branch}。FlowPilot 已經把來源抓到這個資料夾（${sourceRef}），用 git diff origin/${src.baseBranch}...${sourceRef} 看來源的完整改動，搞清楚這個功能的目的；不要另外 fetch 來源分支。`,
      `- 目標：${item.baseBranch} → ${item.branch}。` + (state.continuing
        ? `這條分支已經存在、之前做過一部分（比基底多 ${state.commits} 個提交、${state.dirty} 個未提交的修改），先看過現有的差異再接著做。`
        : `FlowPilot 已經在這個資料夾從 origin/${item.baseBranch} 開好並切換到 ${item.branch}。`) + '直接在目前分支做，不要切換分支、不要另外建分支。',
      `- 照商戶 ${item.merchant} 現有的架構重新實作同樣的功能，保留這個商戶自己的行為；不要 merge、cherry-pick 來源分支，也不要整個檔案複製過來。`,
      `- 需求以 Jira ${item.ticketKey}（主單 ${item.mainKey}）的「需求」與「預期結果」為準；完成時對照預期結果逐項確認。`,
      '- 技能裡的「提交、推送、開 PR」這次都不要做：做完由 FlowPilot 安排瀏覽器測試，提交、推送、發 PR 由我決定。',
      '- 做完跑一次跟提交時一樣的 lint，但只檢查這次改到的檔案，不要加 --fix。不要跑 build（正式版編譯很慢，實際跑過要好幾分鐘）：接下來的自動測試會啟動本機網站，編譯錯誤在那時就會出現。',
      `- 不要修改 ${ENVIRONMENT_FILE}（SIT／UAT 由 FlowPilot 切換）。`,
      '- 自己做，不要開子 AI（spawn_agent）分工。',
      '- 最後說明：來源改了什麼、在這個商戶怎麼對應、有哪些地方跟來源不一樣（為什麼）。',
      SHARED_BROWSER_LINE,
      FIGMA_LINE,
      i18nLine(i18nWorkFile(this.deps.dataDir, item.id)),
      brief,
    ] : [
      ...(item.members.length
        ? [
            `請使用 $${skill} 一起處理這 ${item.members.length} 張 Jira（合成一個任務：同一條分支、最後一個 PR）：`,
            ...item.members.map((m) => `  - ${m.key}（${m.summary}）：${m.url}`),
            rebaseLine,
            '',
            `- 每張單的需求都要做完，完成時對照各自的預期結果逐項確認；需求內容也可能寫在它們的主單 ${item.mainKey}。`,
            '- 這幾張單之間如果有衝突或重複，說明你怎麼處理。',
          ]
        : [
            `請使用 $${skill} 處理這張 Jira：${item.mainUrl}`,
            rebaseLine,
            '',
            `- 指派給我的子任務是 ${item.ticketKey}（${item.ticketSummary}）；需求內容寫在主單 ${item.mainKey}。`,
          ]),
      '- 需求以單上的「需求 / Requirements」與「預期結果 / Acceptance Criteria」為準，完成時要對照預期結果逐項確認；不理會「原始需求 / Merchant Requirements」。',
      brief ? '' : '- 這張單沒有開發前的審閱結果：請自己讀 Jira 單，整理成開發內容重點、牽涉頁面、後端API規格、預計執行內容、疑問五段之後再開發，不用要我先跑 jira-frontend-analysis。',
      branchLine,
      '- 這次只做開發：開發完 FlowPilot 會接著安排瀏覽器測試，你不用自己開瀏覽器測試。',
      // 提交時專案會跑 lint，開發時就先檢查，不要等到提交才冒出來（也不要 --fix，那會改到無關的檔案）
      '- 開發完跑一次跟提交時一樣的 lint，但只檢查這次改到的檔案，不要加 --fix 去動到其他檔案；有問題就修。',
      `- 不要修改 ${ENVIRONMENT_FILE}（SIT／UAT 由 FlowPilot 切換）。`,
      '- 不要提交、不要推送；完成後由我審查並提交。',
      '- 自己做，不要開子 AI（spawn_agent）分工。',
      SHARED_BROWSER_LINE,
      FIGMA_LINE,
      i18nLine(i18nWorkFile(this.deps.dataDir, item.id)),
      item.targetMerchants.length ? `- 這張單之後還要移植到商戶 ${item.targetMerchants.join('、')}，那是下一階段的事，這次只做目前這個商戶。` : '',
      brief,
    ];
    const text = instructions
      .filter((line) => line !== '')
      .join('\n');
    // 開工這一輪也要附上回覆語言（以前漏了：英文介面開工後，整段開發都用中文回覆）
    const { turn } = await codex.request<{ turn: { id: string } }>('turn/start', {
      threadId: thread.id,
      input: withReplyLanguage([
        { type: 'skill', name: skill, path: await this.skillPath(skill) },
        { type: 'text', text, text_elements: [] },
        // 補充資料裡的截圖（例如 Confluence 問題表那一列的截圖）一起給開發的 AI 看
        ...(this.deps.store.getReview(item.ticketKey)?.review.supplementImages ?? []).filter((p) => existsSync(p)).map((path) => ({ type: 'localImage', path })),
      ]),
    });
    this.turns.set(thread.id, turn.id);
    // 不自動打開 VS Code：工作台就看得到對話與改動；需要時再按「在 VS Code 查看」
  }

  // ---- 瀏覽器測試 ----

  /**
   * 開始瀏覽器測試（同一段對話裡的新一輪）：
   * - 自動測試（開發完自動接著做）：無頭、不用你確認測試計畫、只做不改資料的操作、前端問題自己修正重測最多 3 次
   * - 重測（你按了才做）：有頭、先列測試計畫給你確認
   * 兩者都用測試帳號自動登入；網站由 FlowPilot 在資料夾終端機啟動；環境照資料夾目前的 environment.ts。
   */
  private async startTest(id: number, headed: boolean): Promise<void> {
    const { codex, settings: getSettings } = this.deps;
    const item = this.deps.store.getWorkItem(id)!;
    const settings = getSettings();
    const rule = settings.projects[item.project];
    const label = headed ? t('重測') : t('自動測試');
    this.update(id, { stage: headed ? 'retest' : 'autotest', status: 'running', activity: t('準備瀏覽器測試：啟動本機網站'), pending: null });
    try {
      if (!item.threadId || !item.folder) throw new Error(t('這張單還沒有 AI 對話'));
      const cwd = this.folderPath(item.folder);
      const env = readEnvironment(cwd);
      if (env === null) throw new Error(t('{file} 裡找不到 SIT／UAT 的標記', { file: ENVIRONMENT_FILE }));
      if (env === 'mixed') throw new Error(t('{file} 的 SIT、UAT 兩組都開著或都註解掉了，請在右邊「測試」選一個環境', { file: ENVIRONMENT_FILE }));
      const account = resolveAccount(settings.testConfigDir, item.project, item.merchant, env);
      const where = t('{project} 的 {env}', { project: `${item.project}${item.merchant ? ` m${item.merchant}` : ''}`, env: env.toUpperCase() });
      if (!account) throw new Error(t('帳號檔裡沒有 {where} 的測試帳號，請在 {file} 補上', { where, file: configFile(settings.testConfigDir, item.project) }));
      // 先確認連得到後端：沒開 VPN 時馬上告訴你，不用等 AI 試好幾分鐘
      const apiUrl = readApiUrl(cwd);
      if (apiUrl && !(await (this.deps.canReach ?? reachable)(apiUrl))) {
        throw new Error(t('連不到 {env} 的後端（{url}），VPN 有開嗎？開了之後按「開瀏覽器測給我看」再測', { env: env.toUpperCase(), url: apiUrl }));
      }
      if (!account.password) throw new Error(t('{where} 的測試帳號 {username} 還沒有密碼，請在 {file} 補上', { where, username: account.username, file: configFile(settings.testConfigDir, item.project) }));
      const url = await this.deps.ensureSite(item.folder);
      const accountFile = writeAccountFile(join(this.deps.dataDir, '測試帳號'), id, { project: item.project, merchant: item.merchant, environment: env, url, account });
      const requestLog = requestLogFile(this.deps.dataDir, id);
      mkdirSync(dirname(requestLog), { recursive: true });
      writeFileSync(requestLog, ''); // 每次測試從空的紀錄開始
      const common = [
        `- 寫入防護：這個測試瀏覽器會擋下所有會新增、修改、刪除資料的請求（PUT、PATCH、DELETE，以及網址看起來會改資料的 POST），不會送到後端，並回一個假的成功（success: true）。登入和查詢會正常放行。`,
        `  每個被擋下或放行的請求（含送出的內容）都記在 ${requestLog}，一行一筆 JSON。按下儲存、送出之後，用終端機讀這個檔案（例如 cat），逐欄對照預期的 payload（欄位、值、不該送的欄位、null）。`,
        '  寫入防護是照網址猜的，可能猜錯：如果某個被擋下的請求其實是查詢或登入步驟（例如被擋之後畫面變空、資料不見、被登出），在結果的「要你注意」裡寫出那個網址，FlowPilot 會修正規則。',
        '  因為回的是假的成功，存檔之後的畫面（例如列表多一筆、詳情變成新的值）不會跟真的一樣，這部分列進要我手動測的項目。不要用任何方式繞過防護（例如用 curl 或腳本直接打後端）。',
        `- 本機網站已經由 FlowPilot 啟動：${url}，直接用；不要自己啟動、重啟或關掉網站。`,
        `- 環境：FlowPilot 已經切到 ${env.toUpperCase()}，不要修改 ${ENVIRONMENT_FILE}。`,
        // 實測：AI 曾試著在瀏覽器裡讀這個檔案（讀不到）就放棄登入，所以寫清楚用終端機讀
        `- 登入：先用終端機指令讀 ${accountFile}（例如 cat）取得帳號密碼，再用瀏覽器工具填進登入表單自動登入（登入畫面要 OTP 時，填檔案裡的 otp）。這個檔案在電腦上，瀏覽器裡讀不到，不要在瀏覽器裡讀。不要停下來等我登入，也不要把密碼印出來或寫進任何檔案、回覆。`,
        '- 第一步先登入：登入失敗（帳號密碼錯、OTP、被擋）就立刻停止，不要再試別的，直接回報「測試結果：沒測成（登入失敗：原因）」。',
        '- 按下登入後什麼都沒發生（沒有送出登入請求、還停在登入畫面）：先看表單有沒有錯誤提示、欄位要求的格式（例如欄位要信箱、帳號檔給的卻是帳號名稱），把具體原因寫進結果（例如「帳號格式不符：登入欄位要信箱，帳號檔是 bantest」），不要猜是攔截或驗證碼的問題。',
        '- 看到跨網域（CORS）錯誤先不要下結論：重新整理再試一次，並用終端機 curl 帶 Origin 標頭（例如 curl -sI -H "Origin: 本機網站網址" 後端網址/version）看後端有沒有回 Access-Control-Allow-Origin。後端有回就不是後端的問題，重試或換方式繼續測；確定是環境問題才回報沒測成，並附上 curl 的結果。',
        '- 失敗時先判斷原因：是前端程式的問題就直接修正，然後重測失敗的部分，最多 3 輪；不是前端的問題（後端、資料、權限、環境）就記下來，不要修。API 回 404 通常是後端還沒部署這支 API，不是前端的錯。',
        '- 不要提交、不要推送。自己做，不要開子 AI（spawn_agent）分工。',
        ...designCompareLines(this.deps.store.getReview(item.ticketKey)?.review ?? null),
        ...reportLines(this.deps.store.getReview(item.ticketKey)?.review ?? null),
        '- 回覆的最後一行一定要照這個格式寫結果（FlowPilot 會讀這一行）：「測試結果：通過」、「測試結果：部分通過（原因）」或「測試結果：沒測成（原因）」。主要功能一個都沒測到（例如登入失敗、網站打不開）就是「沒測成」；有測到但有些項目沒測或沒過是「部分通過」。',
      ];
      const text = headed
        ? [
            `請使用 $${rule.testSkill} 開瀏覽器重新測試給我看（我手動測過，也可能請你改過了）。以下是 FlowPilot 的安排，跟技能預設規則不同的地方以這裡為準：`,
            '',
            `- 這次是有頭模式：只能用 ${HEADED_BROWSER} 這個瀏覽器工具（在 exec 裡用 ${toolCall(HEADED_BROWSER)} 這類名稱呼叫，會開出視窗讓我看）；不要用 ${HEADLESS_BROWSER}、${SHARED_BROWSER}（共用瀏覽器沒有寫入防護），也不要另外寫 Playwright 腳本開瀏覽器。`,
            '- 先列出測試計畫（要測的頁面、操作、預期的 API），等我確認後才開始。重點放在我在這段對話裡要求修改的部分，再加上這張單的主要流程。',
            '- 新增、儲存這類操作可以直接做，不用每一步問我：寫入一律會被擋下（見下面），資料不會寫進後端。',
            ...common,
          ]
        : [
            `請使用 $${rule.testSkill} 測試剛才完成的開發（這是開發完 FlowPilot 自動安排的測試，只是先幫我抓明顯的錯，我之後一定會自己手動測）。以下是 FlowPilot 的安排，跟技能預設規則不同的地方以這裡為準：`,
            '',
            `- 我已經授權這次用無頭模式：只能用 ${HEADLESS_BROWSER} 這個瀏覽器工具（在 exec 裡用 ${toolCall(HEADLESS_BROWSER)} 這類名稱呼叫，不會開出視窗）；不要用 ${HEADED_BROWSER}、${SHARED_BROWSER}（共用瀏覽器沒有寫入防護），也不要另外寫 Playwright 腳本開有頭的瀏覽器。`,
            '- 不用先給我確認測試計畫：列出測試案例後直接開始測，中途也不要停下來問我。',
            '- 新增、編輯、儲存的流程也要測（這通常是最容易出錯的地方）：寫入一律會被擋下（見下面），不用跳過，也不用問我。',
            ...common,
            '- 最後照技能的結果格式回報，並另外列出「跳過、要你手動測的項目」。',
          ];
      await codex.start();
      await this.startTurn(item, [
        { type: 'skill', name: rule.testSkill, path: await this.skillPath(rule.testSkill) },
        { type: 'text', text: text.join('\n'), text_elements: [] },
      ]);
      this.update(id, { activity: headed ? t('列測試計畫給你確認') : t('自動測試中（無頭）'), ...(headed ? {} : { autotested: true }) });
    } catch (error) {
      if (['removed', 'stopped'].includes(this.deps.store.getWorkItem(id)!.status)) return;
      const message = t('{label}沒辦法開始：{error}', { label, error: (error as Error).message });
      // 自動測試沒開始成，也算沒測成（不會再顯示成打勾或略過）
      const result = headed ? {} : { autotestResult: { kind: 'failed' as const, reason: (error as Error).message } };
      this.update(id, { stage: 'manual', status: 'waiting', activity: message, ...result });
      this.notify(id, t('{ticket} {label}沒辦法開始', { ticket: item.ticketKey, label }), (error as Error).message);
    }
  }

  /**
   * AI 自我審查（檢查計畫要做時）：對照需求分析與團隊慣例，看一次自己的改動，有問題直接修。
   * 開始不了就直接進自動測試，不擋流程。
   */
  private async startSelfCheck(id: number): Promise<void> {
    const item = this.deps.store.getWorkItem(id)!;
    try {
      if (!item.threadId) throw new Error(t('沒有 AI 對話'));
      this.update(id, { stage: 'selfcheck', status: 'running', activity: t('AI 自我審查中'), pending: null });
      const text = [
        '## 自我審查',
        '',
        `請審查你這次的改動（git diff origin/${item.baseBranch}...HEAD，以及還沒提交的修改），發現問題就直接修正：`,
        '- 對照上面需求分析的「預期結果」：每一條都有做到嗎？有沒有做了需求沒要的東西？',
        '- 團隊慣例：多語系的文字有沒有都加到翻譯檔、有沒有重複的程式、命名和既有的寫法一不一致、錯誤處理和型別有沒有漏。',
        '- 跑跟提交時一樣的 lint，但只檢查這次改到的檔案，而且不要加 --fix 去動到其他檔案。',
        `- 不要提交、不要推送，不要修改 ${ENVIRONMENT_FILE}。自己做，不要開子 AI（spawn_agent）分工。`,
        '最後簡短列出：審查了什麼、修正了什麼、還有什麼風險。',
      ].join('\n');
      await this.deps.codex.start();
      await this.startTurn(item, [{ type: 'text', text, text_elements: [] }]);
    } catch (error) {
      this.deps.log(`${item.ticketKey} 自我審查開始不了，直接進自動測試：${(error as Error).message}`);
      await this.startTest(id, false);
    }
  }

  /** 開瀏覽器測給我看（你按了才做） */
  async retest(id: number) {
    this.assertIdle(id, t('重測'));
    await this.startTest(id, true);
  }

  /** 重跑自動測試（無頭）：上次沒測成（例如登入失敗、沒開 VPN）處理好之後用 */
  async rerunAutotest(id: number) {
    this.assertIdle(id, t('重跑自動測試'));
    await this.startTest(id, false);
  }

  private assertIdle(id: number, what: string) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.threadId) throw new Error(t('這張單還沒有 AI 對話'));
    if (this.turns.has(item.threadId) || item.status === 'running' || item.status === 'preparing') throw new Error(t('AI 還在執行，請等它停下來（或中斷）再{what}', { what }));
    if (item.pending) throw new Error(t('AI 有事在等你回答，先處理再{what}', { what }));
  }

  /** 勾選或取消手動測試清單的一項 */
  setManualDone(id: number, index: number, done: boolean) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.testReport?.manual[index]) throw new Error(t('找不到這個手動測試項目'));
    const manual = item.testReport.manual.map((m, i) => (i === index ? { ...m, done } : m));
    this.update(id, { testReport: { ...item.testReport, manual } });
  }

  /** 驗收表的一條勾選「我測過了」 */
  setChecked(id: number, no: number, checked: boolean) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.testReport?.acceptance.some((a) => a.no === no)) throw new Error(t('找不到這一條'));
    const acceptance = item.testReport.acceptance.map((a) => (a.no === no ? { ...a, checked } : a));
    this.update(id, { testReport: { ...item.testReport, acceptance } });
  }

  /** 請 AI 整理驗收表，不重新測試（例如自動測試沒跑成、還沒有驗收表） */
  /**
   * 開發完接著自動測試；檢查計畫裡你取消了「開發完自動測試」就跳過：
   * 不開瀏覽器，請 AI 照改動整理驗收表（每一條都要你測），整理好就等你測試（階段顯示「略過」）
   */
  private async autotestOrSkip(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    if (this.deps.store.getReview(item.ticketKey)?.review.checks?.autotest?.need !== false) return this.startTest(id, false);
    this.skippedAutotest.add(id);
    this.update(id, { stage: 'manual' });
    const review = this.deps.store.getReview(item.ticketKey)?.review ?? null;
    const text = [
      '## 整理驗收表',
      '',
      '這張單我選了不跑自動測試。請整理驗收表給我手動測試用：不要開瀏覽器測試、不要改程式碼。用 git diff 對照基底分支，確認每個改到的檔案都有說明。每一條的 result 都寫「沒測」、needYou 都寫 true。',
      ...reportLines(review),
    ].join('\n');
    await this.reply(id, text, [], { asFix: false, activity: t('已跳過自動測試：AI 整理驗收表中') });
  }

  async requestAcceptance(id: number) {
    this.assertIdle(id, t('整理驗收表'));
    const review = this.deps.store.getReview(this.deps.store.getWorkItem(id)!.ticketKey)?.review ?? null;
    const text = [
      '## 整理驗收表',
      '',
      '請整理這張單的驗收表給我手動測試用，不用重新測試、不要改程式碼。用 git diff 對照基底分支，確認每個改到的檔案都有說明。沒測過的 result 寫「沒測」、needYou 寫 true。',
      ...reportLines(review),
    ].join('\n');
    await this.reply(id, text, [], { asFix: false, activity: t('AI 整理驗收表中') });
  }

  /** 這張單從基底分支到現在改到的檔案（含還沒提交、還沒追蹤的），environment.ts 不算 */
  async changedFiles(id: number): Promise<string[]> {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.folder) return [];
    const cwd = this.folderPath(item.folder);
    const files = new Set<string>();
    const add = (out: string) => out.split('\n').map((l) => l.trim()).filter(Boolean).forEach((f) => files.add(f));
    const committed = await runGit(cwd, ['diff', '--name-only', `origin/${item.baseBranch}...HEAD`]);
    if (committed.code === 0) add(committed.stdout);
    add((await runGit(cwd, ['diff', '--name-only', 'HEAD'])).stdout);
    add((await runGit(cwd, ['ls-files', '--others', '--exclude-standard'])).stdout);
    return [...files].filter((f) => !isEnvironmentFile(f)).sort();
  }

  /** 本機網站某一頁的網址（網站沒開會先啟動）；只開本機網站，不開別的網址 */
  async pageUrl(id: number, page: string): Promise<string> {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.folder) throw new Error(t('這張單還沒有資料夾'));
    if (/^[a-z]+:/i.test(page.trim())) throw new Error(t('只能打開本機網站的頁面'));
    const base = (await this.deps.ensureSite(item.folder)).replace(/\/$/, '');
    const path = page.trim();
    return base + (!path ? '/' : path.startsWith('/') || path.startsWith('#') ? path : `/${path}`);
  }

  /** 試登一次要用的東西：網站網址、環境、這次的登入資料檔（沒辦法試就丟出原因） */
  async prepareTrialLogin(id: number): Promise<{ url: string; env: Env; accountFile: string; username: string; hosts: string[] }> {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.folder) throw new Error(t('這張單還沒有分配資料夾'));
    const settings = this.deps.settings();
    const cwd = this.folderPath(item.folder);
    const env = readEnvironment(cwd);
    if (env !== 'sit' && env !== 'uat') throw new Error(t('{file} 的環境看不出來，請先在上面選 SIT 或 UAT', { file: ENVIRONMENT_FILE }));
    const account = resolveAccount(settings.testConfigDir, item.project, item.merchant, env);
    if (!account) throw new Error(t('帳號檔裡沒有 {env} 的帳號', { env: env.toUpperCase() }));
    if (!account.password) throw new Error(t('{username} 還沒有密碼', { username: account.username }));
    const apiUrl = readApiUrl(cwd);
    if (apiUrl && !(await (this.deps.canReach ?? reachable)(apiUrl))) throw new Error(t('連不到 {env} 的後端（{url}），VPN 有開嗎？', { env: env.toUpperCase(), url: apiUrl }));
    const url = await this.deps.ensureSite(item.folder);
    const accountFile = writeAccountFile(join(this.deps.dataDir, '測試帳號'), id, { project: item.project, merchant: item.merchant, environment: env, url, account });
    return { url, env, accountFile, username: account.username, hosts: apiHosts(cwd) };
  }

  /** 工作台右邊「測試」區塊：目前的環境、會用哪個帳號（不含密碼） */
  testState(id: number): TestState {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.folder) throw new Error(t('這張單還沒有分配資料夾'));
    const settings = this.deps.settings();
    const environment = readEnvironment(this.folderPath(item.folder));
    const account = environment === 'sit' || environment === 'uat' ? resolveAccount(settings.testConfigDir, item.project, item.merchant, environment) : null;
    return { environment, account: account ? { username: account.username, hasPassword: !!account.password } : null, accountFile: configFile(settings.testConfigDir, item.project) };
  }

  /** 切換 SIT／UAT：只切換 environment.ts 裡的註解 */
  switchEnvironment(id: number, env: Env): TestState {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.folder) throw new Error(t('這張單還沒有分配資料夾'));
    if (item.status === 'running' && (item.stage === 'autotest' || item.stage === 'retest')) throw new Error(t('瀏覽器測試進行中，切換環境會影響測試，請等它停下來（或中斷）'));
    setEnvironment(this.folderPath(item.folder), env);
    return this.testState(id);
  }


  // ---- Codex 訊息 ----

  private async handle(message: RpcMessage): Promise<void> {
    const threadId: string | undefined = message.params?.threadId;
    if (!threadId) return;
    const own = this.deps.store.findWorkItemByThread(threadId);
    // AI 開的子 AI：用另一個對話編號，只處理它要我們回答的事（同意、提問），其他事件不算這張單的進度
    const parentId = own ? null : this.childThreads.get(threadId);
    const item = own ?? (parentId !== undefined && parentId !== null ? this.deps.store.getWorkItem(parentId) : null);
    if (!item || item.status === 'removed') return;
    if (!own && message.id === undefined) return;
    const method = message.method!;
    if (own) this.rememberChildThreads(item.id, threadId, message.params);

    // Codex 問我們的事
    if (message.id !== undefined) {
      if (APPROVAL_METHODS.test(method)) return this.onApproval(item, message);
      if (method === 'item/tool/requestUserInput') {
        const questions = (message.params.questions ?? []).map((q: any) => ({
          id: q.id,
          header: q.header ?? '',
          question: q.question ?? '',
          options: (q.options ?? []).map((o: any) => o.label ?? String(o)),
        }));
        this.update(item.id, { status: 'waiting', activity: t('AI 在問你問題'), pending: { kind: 'userInput', requestId: message.id, questions } });
        this.notify(item.id, t('{ticket} 在等你回答', { ticket: item.ticketKey }), short(questions.map((q: any) => q.question).join(t('；'))));
        return;
      }
      if (method === 'mcpServer/elicitation/request') return this.onElicitation(item, message);
      // 其他不認得的請求：記下來並拒絕，不要默默回空結果
      this.deps.log(`${item.ticketKey} 收到不認得的請求 ${method}：${JSON.stringify(message.params).slice(0, 300)}`);
      this.deps.codex.reply(message.id, { decision: 'decline' });
      return;
    }

    this.forwardChat(item.id, method, message.params);

    switch (method) {
      case 'thread/tokenUsage/updated': {
        // 這段對話目前用掉多少（最近一次送給 AI 的量 ÷ 上限）
        const usage = message.params.tokenUsage;
        if (usage?.modelContextWindow) this.contextUse.set(threadId, (usage.last?.inputTokens ?? 0) / usage.modelContextWindow);
        break;
      }
      case 'turn/started':
        this.turns.set(threadId, message.params.turn?.id);
        if (item.status !== 'running') this.update(item.id, { status: 'running', activity: t('執行中'), pending: null });
        break;
      case 'item/agentMessage/delta': {
        const text = (this.streaming.get(item.id) ?? '') + (message.params.delta ?? '');
        this.streaming.set(item.id, text);
        this.deps.onStream(item.id, text);
        break;
      }
      case 'item/started': {
        const it = message.params.item ?? {};
        if (it.type === 'agentMessage') {
          this.streaming.set(item.id, '');
          this.deps.onStream(item.id, '');
        }
        const activity =
          it.type === 'commandExecution' ? t('執行：{command}', { command: short(it.command ?? '', 80) })
          : it.type === 'fileChange' ? t('修改檔案')
          : it.type === 'reasoning' ? t('思考中')
          : it.type === 'mcpToolCall' ? t('使用工具：{server} {tool}', { server: it.server ?? '', tool: it.tool ?? '' })
          : it.type === 'webSearch' ? t('搜尋資料')
          : null;
        if (activity) this.update(item.id, { activity });
        break;
      }
      case 'item/completed':
        if (message.params.item?.type === 'agentMessage') {
          this.streaming.delete(item.id);
          this.update(item.id, { lastMessage: message.params.item.text ?? '' });
        }
        break;
      case 'serverRequest/resolved':
        // 你在 VS Code 那邊回覆了：清掉 FlowPilot 這邊的待處理
        if (item.pending && String(item.pending.requestId) === String(message.params.requestId)) {
          this.update(item.id, { status: 'running', activity: t('已在 VS Code 回覆，繼續執行'), pending: null });
        }
        break;
      case 'turn/completed': {
        this.turns.delete(threadId);
        this.streaming.delete(item.id);
        // 換新對話後讀交接的那一輪：回到換之前的狀態，不走一般的流程
        const warmup = this.warmups.get(threadId);
        if (warmup) {
          this.warmups.delete(threadId);
          this.update(item.id, { status: warmup.status, activity: t('已換新對話（前一段太長，整理了重點交接）；{activity}', { activity: warmup.activity }), pending: null });
          warmup.done?.();
          break;
        }
        const turn = message.params.turn ?? {};
        const latest = this.deps.store.getWorkItem(item.id)!;
        let i18n: { retry: boolean; note?: string } = { retry: false };
        if (turn.status === 'failed') {
          this.update(item.id, { status: 'failed', activity: t('AI 失敗：{error}', { error: turn.error?.message ?? t('原因不明') }), pending: null });
          this.notify(item.id, t('{ticket} 失敗', { ticket: item.ticketKey }), turn.error?.message ?? '');
          void this.schedule();
        } else if (turn.status === 'interrupted') {
          if (latest.status !== 'stopped') this.update(item.id, { status: 'waiting', activity: t('這一輪被中斷了，可以補充指示讓它繼續'), pending: null });
        } else if ((i18n = await this.handleI18n(latest)).retry) {
          // key 被用過了：已經請 AI 換名字，等它改完再往下
        } else if (looksLikeQuestion(withoutProgress(latest.lastMessage))) {
          this.update(item.id, { status: 'waiting', activity: i18n.note ? t('AI 在問你問題；{note}', { note: i18n.note }) : t('AI 在問你問題'), pending: null });
          this.notify(item.id, t('{ticket} 在等你回答', { ticket: item.ticketKey }), short(latest.lastMessage.slice(-200)));
        } else if (latest.stage === 'develop' && latest.folder && !(await this.hasChanges(latest))) {
          // 開發完卻沒有改任何檔案：多半是 AI 遇到問題停下來了（例如需求說的頁面不存在）。
          // 不要繼續自我審查、自動測試（實際發生過：一路空轉，還被按了完成、移植到 6 個商戶）
          this.update(item.id, { status: 'waiting', activity: t('AI 沒有改任何檔案：看一下它最後說的原因，決定怎麼處理'), pending: null });
          this.notify(item.id, t('{ticket} 沒有任何改動', { ticket: item.ticketKey }), short(latest.lastMessage.slice(-200)));
        } else if (latest.stage === 'develop') {
          // 開發完：檢查計畫要自我審查就先審查，否則直接做無頭測試
          // 移植的不做自我審查：來源商戶開發時已經審過，移植只是照著改（自動測試照樣跑）
          if (!latest.portOf && this.deps.store.getReview(latest.ticketKey)?.review.checks?.codeReview.need) void this.startSelfCheck(item.id);
          else void this.autotestOrSkip(item.id);
        } else if (latest.stage === 'selfcheck') {
          void this.autotestOrSkip(item.id);
        } else {
          const stageDone = STAGE_DONE[latest.stage];
          let activity = this.skippedAutotest.delete(item.id) ? t('已跳過自動測試，等你測試') : stageDone ? t(stageDone) : t('等你測試');
          // 修改的這一輪什麼檔案都沒改：不要寫「改好了」（多半是回答了問題就停了，或遇到問題）
          const before = this.fixSnapshots.get(item.id);
          this.fixSnapshots.delete(item.id);
          if (latest.stage === 'fix' && before && latest.folder && before === (await this.folderSnapshot(latest).catch(() => ''))) {
            activity = t('AI 這次沒有改任何檔案：看它最後說了什麼，要它繼續就跟它說');
          }
          if (i18n.note) activity = t('{activity}；{note}', { activity, note: i18n.note });
          const tested: { autotestResult?: TestResult; testReport?: TestReport } = {};
          // 修改、整理驗收表時 AI 也會附上更新過的驗收表
          const report = parseTestReport(latest.lastMessage, latest.testReport);
          if (report) tested.testReport = report;
          if (latest.stage === 'autotest' || latest.stage === 'retest') {
            const result = parseTestResult(latest.lastMessage);
            activity = testActivity(latest.stage === 'autotest' ? t('自動測試') : t('重測'), result);
            if (latest.stage === 'autotest') tested.autotestResult = result;
          }
          this.update(item.id, { status: 'review', stage: 'manual', activity, pending: null, ...tested });
          this.notify(item.id, t('{ticket} {activity}', { ticket: item.ticketKey, activity }), short(latest.lastMessage.slice(-200)));
        }
        // 對話太長：趁它停下來（等你測試、等你回答）時整理重點、換新對話；正在做事、等你同意指令的不換
        const after = this.deps.store.getWorkItem(item.id)!;
        if (turn.status === 'completed' && ['review', 'waiting'].includes(after.status) && !after.pending && (this.contextUse.get(threadId) ?? 0) >= HANDOFF_AT) {
          void this.handoff(item.id);
        }
        break;
      }
    }
  }

  /** 換新對話時給新對話的開發規則（開工指示裡長期有效的部分） */
  private handoffRules(item: StoredWorkItem): string {
    const brief = reviewBrief(this.deps.store.getReview(item.ticketKey)?.review ?? null);
    const tickets = item.members.length
      ? [`- 這是 ${item.members.length} 張 Jira 合成的一個任務（同一條分支、最後一個 PR）：`, ...item.members.map((m) => `  - ${m.key}（${m.summary}）：${m.url}`)]
      : [`- 這張單：${item.ticketKey}（${item.ticketSummary}），主單 ${item.mainKey}：${item.mainUrl}`];
    return [
      ...tickets,
      item.portOf ? `- 這是從商戶 ${item.portOf.merchant}（${item.portOf.branch}）移植到商戶 ${item.merchant}：照這個商戶現有的架構實作，不要 merge、cherry-pick 或整個檔案複製。` : '',
      '- 需求以單上的「需求 / Requirements」與「預期結果 / Acceptance Criteria」為準；不理會「原始需求 / Merchant Requirements」。',
      `- 目前在分支 ${item.branch}（基底 origin/${item.baseBranch}），FlowPilot 已經切好，不要切換分支、不要另外建分支。`,
      '- 改完跑一次跟提交時一樣的 lint，只檢查改到的檔案，不要加 --fix。',
      `- 不要修改 ${ENVIRONMENT_FILE}（SIT／UAT 由 FlowPilot 切換）。`,
      '- 不要提交、不要推送；由我審查後提交。',
      '- 自己做，不要開子 AI（spawn_agent）分工。',
      SHARED_BROWSER_LINE,
      FIGMA_LINE,
      i18nLine(i18nWorkFile(this.deps.dataDir, item.id)),
      brief,
    ].filter(Boolean).join('\n');
  }

  /**
   * 對話太長（用掉上限的四成以上）：請舊對話寫交接，開一段新對話、讓它讀規則和交接，之後都在新對話做。
   * 為什麼：對話太長 AI 會變懶、混淆（實際發生過：合成 15 張的單用到五成多，改多語系每輪只回一句「未完成」就停）。
   * 先把單換到新對話再請舊對話整理：舊對話整理時的事件就不會被當成這張單的進度。
   */
  /** wait：等新對話讀完交接才回來（送出訊息前換的，接著要把訊息交給新對話） */
  private async handoff(id: number, wait = false) {
    const { codex } = this.deps;
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.threadId || !item.folder || this.handingOff.has(id)) return;
    this.handingOff.add(id);
    const oldThread = item.threadId;
    const before = { status: item.status, activity: item.activity };
    this.update(id, { activity: t('對話太長：整理重點、換新對話中（大約一分鐘）') });
    try {
      const threadId = await this.newThread(item, '（續）');
      this.update(id, { threadId, oldThreads: [...item.oldThreads, oldThread] });
      this.sharedBrowserTold.add(threadId); // 規則裡已經寫了
      this.i18nJobs.delete(id);
      let summary: string;
      try {
        const { result } = await runStructured<{ handoff: string }>(codex, {
          cwd: this.folderPath(item.folder),
          threadId: oldThread,
          prompt: HANDOFF_PROMPT,
          schema: HANDOFF_SCHEMA,
          timeoutMs: 300_000,
        });
        summary = result.handoff.trim();
      } catch (error) {
        this.deps.log(`${item.ticketKey}：整理交接失敗：${(error as Error).message}`);
        summary = `（前一段對話整理交接失敗，以下是它最後的回覆）\n\n${item.lastMessage}`;
      }
      const skill = item.portOf ? PORT_SKILL : this.deps.settings().projects[item.project]?.devSkill ?? item.skill;
      const text = [
        HANDOFF_TITLE,
        '前一段對話太長了，FlowPilot 幫你換了這段新對話接手。下面是開發規則和前一段對話寫的交接。讀完回一句「了解」就好，先不要做任何事，等我下一句話。',
        '',
        '### 開發規則',
        this.handoffRules(item),
        '',
        '### 交接',
        summary,
      ].join('\n');
      const warmup: { status: WorkStatus; activity: string; done?: () => void } = { ...before };
      const read = new Promise<void>((resolve) => {
        warmup.done = resolve;
        setTimeout(resolve, 180_000);
      });
      this.warmups.set(threadId, warmup);
      const current = this.deps.store.getWorkItem(id)!;
      await this.startTurn(current, [
        { type: 'skill', name: skill, path: await this.skillPath(skill) },
        { type: 'text', text, text_elements: [] },
      ]);
      this.deps.log(`${item.ticketKey}：對話太長，換新對話（${oldThread} → ${threadId}）`);
      if (wait) await read;
    } catch (error) {
      this.deps.log(`${item.ticketKey}：換新對話失敗：${(error as Error).message}`);
      // 換不成就留在原本的對話
      this.update(id, { threadId: oldThread, oldThreads: item.oldThreads, status: before.status, activity: t('{activity}（對話太長，想換新對話但失敗了）', { activity: before.activity }) });
    } finally {
      this.handingOff.delete(id);
    }
  }

  /**
   * 改多語系：AI 這一輪結束時看工作檔和它寫的進度。
   * 沒做完 → 自動叫它繼續（最多 5 次）；做完 → 檢查 key 有沒有被用過（被用過請它換名字，最多 2 次）→ 在背景分批翻譯、存到桌面。
   * retry 是 true 表示已經叫 AI 接著做，這一輪的其他處理先跳過
   */
  private async handleI18n(item: StoredWorkItem): Promise<{ retry: boolean; note?: string }> {
    const workFile = i18nWorkFile(this.deps.dataDir, item.id);
    const progress = parseProgress(item.lastMessage);
    const entries = readWorkFile(workFile);
    // 工作檔是空的、你也沒叫它改多語系：不是在做這件事（AI 只是順手寫了進度那行），不理它
    if (!entries.length && (progress === null || !this.i18nRequested.has(item.id))) return { retry: false };
    const state = this.i18nJobs.get(item.id) ?? { continues: 0, renames: 0 };
    this.i18nJobs.set(item.id, state);
    const stopJob = (note: string) => {
      this.i18nJobs.delete(item.id);
      this.i18nRequested.delete(item.id);
      return { retry: false, note };
    };

    if (progress !== 'done') {
      // 在問你問題就不自動繼續，等你回答
      // 在問你問題、或叫了 5 次還沒做完：暫停自動繼續，等你說到「多語系」再接手
      if (state.paused || looksLikeQuestion(withoutProgress(item.lastMessage)) || state.continues >= 5) {
        state.paused = true;
        return { retry: false, note: t('多語系還沒做完（已記下 {count} 條），要它接著做就跟它說「繼續改多語系」', { count: entries.length }) };
      }
      state.continues++;
      await this.reply(
        item.id,
        [
          '## 繼續改多語系',
          `還沒做完：目前工作檔記下 ${entries.length} 條。接著把剩下的寫死英文改完，每批照樣附加到工作檔，全部做完才停。`,
          '回覆最後一行寫「多語系進度：完成」或「多語系進度：未完成（還剩哪些）」。',
        ].join('\n'),
        [],
        { noReportNote: true, activity: t('多語系：已記下 {count} 條，自動請 AI 繼續（第 {times} 次）', { count: entries.length, times: state.continues }) },
      );
      return { retry: true };
    }
    if (!entries.length) return stopJob(t('AI 說多語系做完了，但工作檔裡沒有任何 key，跟 AI 確認一下'));
    if (!item.folder || item.merchant === null) return stopJob(t('多語系沒產生：這張單沒有資料夾或商戶'));

    const cwd = this.folderPath(item.folder);
    const keys = entries.map((e) => e.key);
    let environment = '';
    try {
      environment = readFileSync(join(cwd, 'src/environments/environment.ts'), 'utf8');
    } catch {}
    const [code, remote] = await Promise.all([usedInCode(cwd, item.baseBranch, keys), remoteKeys(translateUrls(environment, item.merchant))]);
    const taken = keys.filter((k) => code.has(k) || remote.keys.has(k));
    if (taken.length) {
      if (state.renames >= 2) return stopJob(t('多語系沒產生：key 還是跟現有的重複（{keys}）', { keys: taken.join(t('、')) }));
      state.renames++;
      const where = (k: string) => [remote.keys.has(k) ? '遠端翻譯檔' : '', ...(code.get(k) ?? [])].filter(Boolean).join('、');
      await this.reply(
        item.id,
        [
          '## 多語系 key 重複',
          ...taken.map((k) => `- ${k}：已經用在 ${where(k)}`),
          `這些 key 換一個沒用過的名字：程式碼裡一起改，工作檔「${workFile}」裡對應的那幾行也改掉（可以直接改檔案）。`,
          '改完回覆最後一行寫「多語系進度：完成」。',
        ].join('\n'),
        [],
        { noReportNote: true, activity: t('多語系 key 重複（{keys}），請 AI 換名字', { keys: taken.join(t('、')) }) },
      );
      return { retry: true };
    }

    this.i18nJobs.delete(item.id);
    this.i18nRequested.delete(item.id);
    // 工作檔先搬走：翻譯途中你又叫 AI 改多語系，新的會記在新的工作檔
    const taking = `${workFile}.${Date.now()}`;
    renameSync(workFile, taking);
    void this.translateI18n(item, entries, cwd, taking);
    return { retry: false, note: t('多語系 {count} 條翻譯中', { count: entries.length }) };
  }

  /** 在背景分批翻譯、存到桌面；進度和結果寫在狀態列 */
  private async translateI18n(item: StoredWorkItem, entries: I18nEntry[], cwd: string, taken: string) {
    const show = (activity: string) => this.update(item.id, { activity });
    const count = entries.length;
    const cacheFile = translationCacheFile(this.deps.dataDir);
    const todo = fillFromCache(entries, cacheFile);
    const at = Date.now();
    this.i18nRuns.set(item.id, { phase: 'translating', count, at, batches: { done: 0, total: Math.ceil(todo.length / 10) } });
    this.deps.onChange();
    try {
      const missing = await translateAll(
        todo,
        (prompt) => askStructured(this.deps.codex, { cwd, prompt, schema: TRANSLATION_SCHEMA, timeoutMs: 600_000, keepLanguage: true }),
        (done, total) => {
          this.i18nRuns.set(item.id, { phase: 'translating', count, at, batches: { done, total } });
          show(t('多語系翻譯中（{done}/{total} 批）', { done, total }));
        },
      );
      saveToCache(todo, cacheFile);
      const { path } = await writeI18nSheet(entries, item.merchant!);
      const lackKeys = `${missing.slice(0, 5).join(t('、'))}${missing.length > 5 ? '…' : ''}`;
      const lack = missing.length ? t('，其中 {count} 條沒翻好（Excel 裡那幾格是空的：{keys}）', { count: missing.length, keys: lackKeys }) : '';
      const lackNote = missing.length ? t('其中 {count} 條沒翻好（Excel 裡那幾格是空的：{keys}）', { count: missing.length, keys: lackKeys }) : '';
      this.i18nRuns.set(item.id, { phase: 'saved', count, at, file: basename(path), path, note: lackNote || undefined });
      show(t('多語系 {count} 條已存到桌面 {file}{lack}', { count: entries.length, file: basename(path), lack }));
      this.deps.log(`${item.ticketKey}：多語系 ${entries.length} 條寫進 ${path}${lack}`);
      this.notify(item.id, t('{ticket} 多語系檔好了', { ticket: item.ticketKey }), t('{count} 條，存到桌面 {file}', { count: entries.length, file: basename(path) }));
    } catch (error) {
      // 翻譯失敗：把工作檔放回去，之後再叫 AI 說「多語系進度：完成」就會重新翻
      try {
        renameSync(taken, i18nWorkFile(this.deps.dataDir, item.id));
      } catch {}
      this.i18nRuns.set(item.id, { phase: 'failed', count, at, note: (error as Error).message });
      show(t('多語系翻譯失敗：{error}', { error: (error as Error).message }));
    }
  }

  /** 主對話的事件裡出現別的對話編號（開子 AI 時會帶），記下來屬於這張單 */
  private rememberChildThreads(itemId: number, ownThread: string, params: unknown) {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const visit = (value: unknown, key: string, depth: number) => {
      if (depth > 6 || value === null || value === undefined) return;
      if (typeof value === 'string') {
        if (/thread/i.test(key) && UUID.test(value) && value !== ownThread) this.childThreads.set(value, itemId);
        return;
      }
      if (Array.isArray(value)) return value.forEach((v) => visit(v, key, depth + 1));
      if (typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k, depth + 1);
    };
    visit((params as { item?: unknown })?.item, '', 0);
  }

  /**
   * MCP 伺服器要確認的事（例如呼叫工具前的同意）：
   * 不需要填任何欄位的，直接同意；要填資料或要開網址的，轉給你決定。
   */
  private onElicitation(item: StoredWorkItem, message: RpcMessage) {
    const params = message.params ?? {};
    const fields = Object.keys(params.requestedSchema?.properties ?? {});
    if (params.mode !== 'url' && fields.length === 0) {
      this.deps.codex.reply(message.id!, { action: 'accept', content: {}, _meta: null });
      return;
    }
    const detail = params.mode === 'url' ? t('{message}（{url}）', { message: params.message ?? '', url: params.url }) : t('{message}（需要填：{fields}）', { message: params.message ?? '', fields: fields.join(t('、')) });
    const pending: PendingRequest = { kind: 'approval', requestId: message.id!, method: message.method!, command: t('{server}：{message}', { server: params.serverName, message: detail }), reason: t('{server} 要你確認', { server: params.serverName }) };
    this.update(item.id, { status: 'waiting', activity: t('等你確認：{server}', { server: params.serverName }), pending });
    this.notify(item.id, t('{ticket} 要你確認', { ticket: item.ticketKey }), t('{server}：{message}', { server: params.serverName, message: short(params.message ?? '', 80) }));
  }

  /** 把 Codex 的事件轉成聊天畫面的即時更新 */
  private forwardChat(itemId: number, method: string, params: any) {
    const emit = this.deps.onChat;
    if (!emit) return;
    if (method === 'item/started' || method === 'item/completed') {
      const entry = toEntry(params.item, Date.now());
      if (entry) emit(itemId, { type: 'upsert', entry });
    } else if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/plan/delta') {
      emit(itemId, { type: 'delta', id: params.itemId, field: 'text', delta: params.delta ?? '' });
    } else if (method === 'item/commandExecution/outputDelta') {
      emit(itemId, { type: 'delta', id: params.itemId, field: 'output', delta: params.delta ?? '' });
    }
  }

  private onApproval(item: StoredWorkItem, message: RpcMessage) {
    const params = message.params ?? {};
    const command: string = params.command ?? (Array.isArray(params.command) ? params.command.join(' ') : '');
    const isFileChange = /fileChange|applyPatch/.test(message.method!);
    const policy = isFileChange ? { ask: false, reason: '' } : commandPolicy(command);
    if (!policy.ask) {
      this.deps.codex.reply(message.id!, { decision: 'accept' });
      return;
    }
    const pending: PendingRequest = { kind: 'approval', requestId: message.id!, method: message.method!, command, reason: policy.reason };
    this.update(item.id, { status: 'waiting', activity: t('等你同意：{reason}', { reason: policy.reason }), pending });
    this.notify(item.id, t('{ticket} 要執行危險指令', { ticket: item.ticketKey }), t('{reason}：{command}', { reason: policy.reason, command: short(command, 80) }));
  }

  // ---- 你的操作 ----

  async approve(id: number, accept: boolean) {
    const item = this.deps.store.getWorkItem(id)!;
    if (item.pending?.kind !== 'approval') throw new Error(t('目前沒有等你同意的指令'));
    this.deps.codex.reply(
      item.pending.requestId,
      item.pending.method === 'mcpServer/elicitation/request' ? { action: accept ? 'accept' : 'decline', content: accept ? {} : null, _meta: null } : { decision: accept ? 'accept' : 'decline' },
    );
    this.update(id, { status: 'running', activity: accept ? t('已同意，繼續執行') : t('已拒絕，繼續執行'), pending: null });
  }

  /** asFix 為 false 時不當成「要求修改」（例如更新需求），做完說明不會寫「改好了」 */
  async reply(id: number, text: string, images: string[] = [], options: { asFix?: boolean; activity?: string; noReportNote?: boolean } = {}) {
    const { codex } = this.deps;
    let item = this.deps.store.getWorkItem(id)!;
    if (!item.threadId) throw new Error(t('這張單還沒有 AI 對話'));
    this.assertOnBranch(item);
    if (this.handingOff.has(id)) throw new Error(t('對話太長，FlowPilot 正在整理重點、換新對話，大約一分鐘，好了再說'));
    await codex.start();
    // 要開新的一輪、對話卻已經太長（例如自動叫它繼續、或上一輪結束時沒換成）：先換新對話，再把這句交給新對話
    if (!this.turns.get(item.threadId) && !item.pending && (this.contextUse.get(item.threadId) ?? 0) >= HANDOFF_AT) {
      await this.handoff(id, true);
      item = this.deps.store.getWorkItem(id)!;
    }
    if (item.pending?.kind === 'userInput') {
      // 只有一題就直接當答案；好幾題時整段文字都交給每一題
      const answers = Object.fromEntries(item.pending.questions.map((q) => [q.id, { answers: [text] }]));
      codex.reply(item.pending.requestId, { answers });
      this.update(id, { status: 'running', activity: t('已回答，繼續執行'), pending: null });
      return;
    }
    // 你又說到多語系（英文介面時說 translation 也算）：暫停的自動繼續重新開始算
    if (/多語系|translat|i18n/i.test(text) && !text.startsWith('## ')) {
      this.i18nJobs.delete(id);
      this.i18nRequested.add(id);
    }
    // 等你測試時要求修改：附上請 AI 一併更新驗收表的說明
    const asFix = !this.turns.get(item.threadId!) && item.stage === 'manual' && options.asFix !== false;
    let note = asFix && text.trim() && !options.noReportNote ? acceptanceUpdateNote(this.deps.store.getReview(item.ticketKey)?.review ?? null) : '';
    // 這段對話在這次啟動後第一次收到你的話：告訴它有共用瀏覽器可以用（新功能之前就開工的單，開工指示裡沒寫）
    if (text.trim() && !this.sharedBrowserTold.has(item.threadId!)) {
      this.sharedBrowserTold.add(item.threadId!);
      note += `\n\n${ACCEPTANCE_NOTE}\n${SHARED_BROWSER_LINE}\n${FIGMA_LINE}\n${i18nLine(i18nWorkFile(this.deps.dataDir, item.id))}`;
    }
    // 測試做到一半（例如重試、補充指示）：本機網站可能已經關了（FlowPilot 重新啟動時會跟著關），先確認有在跑
    if (['autotest', 'retest'].includes(item.stage) && item.folder) {
      await this.deps.ensureSite(item.folder).catch((error) => this.deps.log(`${item.ticketKey}：啟動本機網站失敗：${(error as Error).message}`));
    }
    const input: object[] = [
      ...(text.trim() ? [{ type: 'text', text: text + note, text_elements: [] }] : []),
      ...images.map((path) => ({ type: 'localImage', path })),
    ];
    if (input.length === 0) throw new Error(t('訊息是空的'));
    const turnId = this.turns.get(item.threadId!);
    // AI 做到一半你插話：它常常回答完就結束這一輪，原本的工作沒做完（實際發生過：問了「語系檔放哪」，答完就停，還顯示改好了）
    const first = input[0] as { type: string; text?: string } | undefined;
    if (turnId && first?.type === 'text' && text.trim()) first.text += `\n\n${ACCEPTANCE_NOTE}\n回答或照做完這句之後，繼續剛才還沒做完的工作，全部做完才停（除非我這句是叫你停）。`;
    if (!turnId && item.folder && (item.stage === 'manual' || item.stage === 'fix') && options.asFix !== false) {
      this.fixSnapshots.set(id, await this.folderSnapshot(item).catch(() => ''));
    }
    if (turnId) {
      await codex.request('turn/steer', { threadId: item.threadId, input: withReplyLanguage(input), expectedTurnId: turnId });
    } else {
      await this.startTurn(item, input);
    }
    // 等你測試時你在對話裡說的話，當成要求修改；改完回到等你測試（不會再自動測試，要重測按「開瀏覽器測給我看」）
    const stage = !turnId && item.stage === 'manual' && options.asFix !== false ? { stage: 'fix' as const } : {};
    this.update(id, { status: 'running', activity: options.activity ?? t('已送出，繼續執行'), pending: null, ...stage });
  }

  /** 中斷 AI 這一輪：單不停止，之後可以再補充指示讓它繼續 */
  async interrupt(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    const turnId = item.threadId ? this.turns.get(item.threadId) : undefined;
    if (!item.threadId || !turnId) throw new Error(t('AI 目前沒有在執行'));
    await this.deps.codex.request('turn/interrupt', { threadId: item.threadId, turnId });
  }

  async stop(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    const turnId = item.threadId ? this.turns.get(item.threadId) : undefined;
    this.update(id, { status: 'stopped', activity: t('你停止了這張單'), pending: null });
    if (item.threadId && turnId) await this.deps.codex.request('turn/interrupt', { threadId: item.threadId, turnId }).catch(() => {});
    void this.schedule();
  }

  // ---- 先交付、待補測 ----

  /** 本機有這張單分支的資料夾（待補測的單不佔資料夾，分支留在原本做的那個資料夾） */
  private async folderHolding(item: StoredWorkItem): Promise<string | null> {
    for (const f of this.deps.settings().folders.filter((x) => x.project === item.project)) {
      if (await localBranchExists(f.path, item.branch).catch(() => false)) return f.path;
    }
    return null;
  }

  /**
   * 先交付、待補測：改動都提交了、還有測試沒勾。讓出資料夾給下一張（分支、提交、對話都留著），
   * 驗收表照樣看得到、勾得到，也可以發 PR；要修時按「繼續修」。
   */
  async park(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    if (['running', 'preparing'].includes(item.status)) throw new Error(t('AI 還在執行，請先等它停下來（或中斷）'));
    if (!item.folder) throw new Error(t('這張單沒有在用資料夾'));
    const owed = pendingTests(item.testReport);
    if (!owed) throw new Error(t('測試都勾完了，直接「完成這張單」就好'));
    const cwd = this.folderPath(item.folder);
    if ((await currentBranch(cwd)) === item.branch) {
      for (const file of (await dirtyFiles(cwd)).filter(isEnvironmentFile)) await runGit(cwd, ['restore', '--staged', '--worktree', '--', file]);
      const dirty = await dirtyFiles(cwd);
      if (dirty.length) throw new Error(t('還有 {count} 個沒提交的改動（{files}{more}），先提交再交付', { count: dirty.length, files: dirty.slice(0, 3).join(t('、')), more: dirty.length > 3 ? t(' 等') : '' }));
    }
    this.deps.stopSite?.(item.folder);
    this.update(id, { status: 'parked', folder: null, pending: null, activity: t('先交付了，待補測 {count} 項；要修時按「繼續修」', { count: owed }) });
    await this.schedule();
  }

  /**
   * 繼續修待補測的單、或把已完成的單退回作戰中：拿一個資料夾（先找原本有這條分支的；被佔用就找同專案其他空的），切回分支，接著原本的對話。
   * 資料夾都在用就不動，告訴你哪張單在用——不會去搶別張單的資料夾。
   */
  async resume(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!['parked', 'committed'].includes(item.status)) throw new Error(t('只有待補測或已完成的單可以繼續修'));
    const reopening = item.status === 'committed';
    // 這條分支已經在別張卡片上開發（例如從單列表再次開發），不要兩張卡片搶同一條分支
    if (reopening && this.deps.store.activeWorkItem(item.project, item.branch)) throw new Error(t('{branch} 已經有另一張卡片在作戰中，到那張繼續就好', { branch: item.branch }));
    const folder = await this.claimFolder(item);
    this.update(id, {
      status: 'review',
      lane: 'development',
      stage: 'manual',
      folder: folder.name,
      // 之前「直接完成（不補測）」留下的記號：退回來就是還要做，不再算已完成
      ...(reopening && item.testReport?.finishedUntested ? { testReport: { ...item.testReport, finishedUntested: undefined } } : {}),
      activity: reopening ? t('退回作戰中（在 {folder}）：跟 AI 說要改什麼', { folder: folder.name }) : t('繼續修（在 {folder}）：跟 AI 說要改什麼', { folder: folder.name }),
    });
    await this.schedule();
  }

  /**
   * 拿一個空的資料夾給這張單、切到它的分支（繼續修、退回作戰中、搬離退役資料夾共用）。退役的資料夾不拿。
   * 原本有這條分支的資料夾優先；資料夾都在用就不動，告訴你哪張單在用——不會去搶別張單的資料夾。
   */
  private async claimFolder(item: StoredWorkItem): Promise<FolderSetting> {
    const folders = this.deps.settings().folders.filter((f) => f.project === item.project && !f.retired);
    const items = this.deps.store.listWorkItems();
    const owner = (name: string) => items.find((i) => i.id !== item.id && i.folder === name && OCCUPYING.includes(i.status));
    const free = folders.filter((f) => !owner(f.name));
    if (!free.length) {
      throw new Error(
        t('{project} 的資料夾都在用（{busy}），等其中一張完成或先交付再繼續修', {
          project: item.project,
          busy: folders.map((f) => t('{folder} 在做 {ticket}', { folder: f.name, ticket: owner(f.name)!.ticketKey })).join(t('、')),
        }),
      );
    }
    let folder = free[0];
    for (const f of free) if (await localBranchExists(f.path, item.branch).catch(() => false)) { folder = f; break; }
    await this.checkoutTaskBranch(item, folder);
    return folder;
  }

  /**
   * 把資料夾切到這張單的分支。environment.ts 先還原；其他沒提交的改動不動，告訴你是哪些、請你先處理。
   * 這個資料夾沒有這條本機分支時：別的資料夾（例如退役的）有就直接從那裡抓過來（沒推送的提交也帶得到），再不然用遠端的。
   * 切完套件不同就重新安裝。
   */
  private async checkoutTaskBranch(item: StoredWorkItem, folder: FolderSetting) {
    const cwd = folder.path;
    const here = await currentBranch(cwd);
    if (here === item.branch) return;
    for (const file of (await dirtyFiles(cwd)).filter(isEnvironmentFile)) await runGit(cwd, ['restore', '--staged', '--worktree', '--', file]);
    const dirty = await dirtyFiles(cwd);
    if (dirty.length) {
      throw new Error(
        t('{folder} 現在在 {current}，有 {count} 個沒提交的改動（{files}{more}）：這些是 {current} 的改動，先提交或捨棄，再切回這張單的分支', {
          folder: folder.name,
          current: here || t('（不在任何分支）'),
          count: dirty.length,
          files: dirty.slice(0, 3).join(t('、')),
          more: dirty.length > 3 ? t(' 等') : '',
        }),
      );
    }
    const lockBefore = await fileHash(cwd, 'package-lock.json');
    await fetchOrigin(cwd).catch(() => {});
    if (await localBranchExists(cwd, item.branch)) await switchBranch(cwd, item.branch);
    else if (await this.fetchFromOtherFolder(item, cwd)) await switchBranch(cwd, item.branch);
    else if (await remoteBranchExists(cwd, item.branch)) await switchToRemoteBranch(cwd, item.branch);
    else throw new Error(t('找不到 {branch}：{folder} 本機和遠端都沒有，原本做的資料夾可能已經刪掉了', { branch: item.branch, folder: folder.name }));
    await this.reinstallIfNeeded(item, cwd, lockBefore);
  }

  /** 同專案別的資料夾有這條本機分支：直接抓過來變成這裡的本機分支（不經過遠端，沒推送的提交也帶得到） */
  private async fetchFromOtherFolder(item: StoredWorkItem, cwd: string): Promise<boolean> {
    for (const f of this.deps.settings().folders.filter((x) => x.path !== cwd && x.project === item.project)) {
      if (!(await localBranchExists(f.path, item.branch).catch(() => false))) continue;
      if ((await runGit(cwd, ['fetch', f.path, `+refs/heads/${item.branch}:refs/heads/${item.branch}`])).code === 0) return true;
    }
    return false;
  }

  private async reinstallIfNeeded(item: StoredWorkItem, cwd: string, lockBefore: string | null) {
    if (!existsSync(join(cwd, 'package.json'))) return;
    if (lockBefore === (await fileHash(cwd, 'package-lock.json')) && existsSync(join(cwd, 'node_modules'))) return;
    this.update(item.id, { activity: t('套件不同，安裝套件中（npm install，可能要幾分鐘）') });
    await shell(cwd, 'npm install', 20 * 60_000);
  }

  /** 資料夾不在這張單的分支上（例如你在 VS Code 切走了）：叫 AI 做事、完成這張單之前都要擋下來，免得改到別條分支 */
  private assertOnBranch(item: StoredWorkItem) {
    if (!item.folder) return;
    const here = headBranch(this.folderPath(item.folder));
    if (here === null) return; // 讀不到：看不出來，不擋
    if (here !== item.branch) {
      throw new Error(t('資料夾 {folder} 現在在 {current}，不是這張單的分支 {branch}；先切回來才能繼續', { folder: item.folder, current: here || t('（不在任何分支）'), branch: item.branch }));
    }
  }

  /** 資料夾被切到別的分支：切回這張單的分支（只用在 FlowPilot 自己的資料夾；退役的資料夾用「搬到 FlowPilot 的資料夾」） */
  async switchBack(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.folder) throw new Error(t('這張單沒有在用資料夾'));
    if (['running', 'preparing'].includes(item.status)) throw new Error(t('AI 還在執行，請先等它停下來（或中斷）'));
    const folder = this.deps.settings().folders.find((f) => f.name === item.folder);
    if (!folder) throw new Error(t('設定檔裡沒有資料夾「{folder}」', { folder: item.folder }));
    await this.checkoutTaskBranch(item, folder);
    this.update(id, { activity: t('已切回 {branch}', { branch: item.branch }) });
  }

  /**
   * 卡片在退役的資料夾（你自己也在用的），而且被你切到別的分支了：搬到 FlowPilot 的資料夾繼續，不動你的資料夾。
   * 分支沒推送的提交直接從原本的資料夾抓過來；對話、驗收表都照舊。
   */
  async relocate(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.folder) throw new Error(t('這張單沒有在用資料夾'));
    if (['running', 'preparing'].includes(item.status)) throw new Error(t('AI 還在執行，請先等它停下來（或中斷）'));
    const from = item.folder;
    const folder = await this.claimFolder(item);
    this.deps.stopSite?.(from);
    this.update(id, { folder: folder.name, activity: t('從 {from} 搬到 {folder} 繼續（{from} 不再動）', { from, folder: folder.name }) });
  }

  // ---- 完成 ----

  /**
   * 這張單做完了：讓出資料夾給下一張。
   * 資料夾要乾淨（提交或捨棄都可以）；environment.ts（瀏覽器測試切 SIT／UAT 用的）可以選擇直接還原。
   * skipTests：你選了「直接完成（不補測）」：欠的測試不擋，但記在驗收表上（之後查得到）。
   */
  async finish(id: number, restoreEnvironment: boolean, skipTests = false) {
    const item = this.deps.store.getWorkItem(id)!;
    if (['running', 'preparing'].includes(item.status)) throw new Error(t('AI 還在執行，請先等它停下來（或中斷）'));
    this.assertOnBranch(item);
    // 欠的測試要補完才能完成（可以先「先交付，待補測」讓出資料夾）
    const owed = pendingTests(item.testReport);
    if (owed && !skipTests) throw new Error(t('還有 {count} 項測試沒勾「我測過了」，補測完才能完成；要先讓出資料夾，按「先交付，待補測」', { count: owed }));
    if (item.folder) {
      const cwd = this.folderPath(item.folder);
      if ((await currentBranch(cwd)) === item.branch) {
        let dirty = await dirtyFiles(cwd);
        if (restoreEnvironment) {
          for (const file of dirty.filter(isEnvironmentFile)) await runGit(cwd, ['restore', '--staged', '--worktree', '--', file]);
          dirty = await dirtyFiles(cwd);
        }
        if (dirty.length) throw new Error(t('還有 {count} 個未提交的修改（{files}{more}），請先提交或捨棄', { count: dirty.length, files: dirty.slice(0, 3).join(t('、')), more: dirty.length > 3 ? t(' 等') : '' }));
      }
    }
    const holder = item.folder ? this.folderPath(item.folder) : await this.folderHolding(item);
    const sha = holder ? (await runGit(holder, ['rev-parse', '--short', item.folder ? 'HEAD' : item.branch])).stdout.trim() || null : null;
    // 讓出資料夾時順便停掉本機網站（下一張單會自己重新啟動）
    if (item.folder) this.deps.stopSite?.(item.folder);
    this.update(id, {
      status: 'committed',
      lane: 'done',
      commitSha: sha,
      pending: null,
      ...(owed && skipTests && item.testReport ? { testReport: { ...item.testReport, finishedUntested: owed } } : {}),
      activity:
        (owed && skipTests ? t('已完成（{count} 項沒測就完成）', { count: owed }) : t('已完成')) +
        (item.targetMerchants.length ? t('；還要移植到 {merchants}（推送之後按右邊的「移植」）', { merchants: item.targetMerchants.map((m) => `m${m}`).join(t('、')) }) : ''),
    });
    await this.schedule();
  }

  /**
   * 再次開發：把這幾張單在工作台上已完成的舊卡片收起來。
   * 跟「移除」不同，分支和審閱紀錄都不動（新任務接著用或從它旁邊開新分支）。
   */
  shelveDone(ticketKeys: string[]) {
    const ids = new Set(ticketKeys.flatMap((key) => this.deps.store.doneWorkItemIds(key)));
    for (const id of ids) this.update(id, { status: 'removed', lane: 'done', activity: t('再次開發，舊的已完成卡片收起來了'), pending: null });
  }

  /** 審閱紀錄跟著工作台走：這張單沒有別的列還在工作台上，就刪掉審閱紀錄 */
  private forgetReview(ticketKey: string) {
    if (!this.deps.store.hasActiveTicket(ticketKey)) this.deps.store.deleteReview(ticketKey);
  }

  /** 移除前查分支的狀況，讓你決定要不要一起刪；還沒分到資料夾的回傳 null */
  async branchInfo(id: number): Promise<BranchInfo | null> {
    const item = this.deps.store.getWorkItem(id)!;
    // 待補測的單不佔資料夾：看原本有這條分支的資料夾
    const cwd = item.folder ? this.folderPath(item.folder) : item.status === 'parked' ? await this.folderHolding(item) : null;
    if (!cwd) return null;
    const exists = await localBranchExists(cwd, item.branch);
    const hasRemote = exists && (await remoteBranchExists(cwd, item.branch));
    // 只在這台電腦上的提交：遠端有這條分支就跟遠端比，沒有就跟基底比
    const against = hasRemote ? `refs/remotes/origin/${item.branch}` : `origin/${item.baseBranch}`;
    const counted = exists ? await runGit(cwd, ['rev-list', '--count', `${against}..refs/heads/${item.branch}`]) : null;
    const unpushed = !exists ? 0 : counted!.code === 0 ? Number(counted!.stdout.trim()) : null;
    const onBranch = (await currentBranch(cwd)) === item.branch;
    const dirty = onBranch ? (await dirtyFiles(cwd)).filter((f) => !isEnvironmentFile(f)) : [];
    const folder = item.folder ?? this.deps.settings().folders.find((f) => f.path === cwd)?.name ?? '';
    return { branch: item.branch, folder, baseBranch: item.baseBranch, exists, hasRemote, unpushed, dirty };
  }

  /**
   * 刪掉這張單的本機分支（只刪本機，絕對不動遠端）：
   * 資料夾停在這條分支上時，先還原 environment.ts、切回基底分支再刪；有其他沒提交的修改就不刪，回傳原因。
   */
  private async deleteLocalBranch(item: StoredWorkItem): Promise<RemoveResult> {
    const info = await this.branchInfo(item.id);
    if (!info?.exists) return { branchDeleted: false, reason: t('本機沒有這條分支') };
    const cwd = this.folderPath(item.folder!);
    // 資料夾停在這條分支上：還原成原本的樣子（丟掉沒提交的改動、切回基底）；
    // 資料夾已經換到別的分支（在做別張單）：只刪分支，不碰資料夾裡的檔案
    if ((await currentBranch(cwd)) === item.branch) {
      await runGit(cwd, ['reset', '-q', '--', '.']);
      await runGit(cwd, ['checkout', '--', '.']);
      for (const path of (await runGit(cwd, ['ls-files', '--others', '--exclude-standard'])).stdout.split('\n').filter(Boolean)) {
        rmSync(join(cwd, path), { force: true });
      }
      if (await localBranchExists(cwd, item.baseBranch)) await switchBranch(cwd, item.baseBranch);
      else await switchToRemoteBranch(cwd, item.baseBranch);
    }
    const result = await runGit(cwd, ['branch', '-D', item.branch]);
    if (result.code !== 0) return { branchDeleted: false, reason: t('刪除失敗：{error}', { error: result.stderr.trim() }) };
    this.deps.log(`${item.ticketKey}：移除時刪除 ${item.folder} 的本機分支 ${item.branch}（丟掉 ${info.dirty.length} 個沒提交的改動、${info.unpushed ?? '?'} 個沒推送的提交）`);
    return { branchDeleted: true };
  }

  /**
   * 從工作台移除（進行中、已完成都可以）：回到從沒做過的樣子。
   * 刪掉本機分支（資料夾停在這條分支上時，先丟掉沒提交的改動、切回基底）；遠端分支絕對不動，由你自己刪。
   * 也刪掉審閱紀錄，單列表上的標籤跟著消失。
   */
  async remove(id: number): Promise<RemoveResult> {
    const item = this.deps.store.getWorkItem(id)!;
    // 移除會刪本機分支、還原資料夾；AI 還在改檔案時會亂掉，要等它停下來
    if (['running', 'preparing'].includes(item.status)) throw new Error(t('AI 還在執行，請先中斷這一輪再移除'));
    const turnId = item.threadId ? this.turns.get(item.threadId) : undefined;
    if (item.threadId && turnId) await this.deps.codex.request('turn/interrupt', { threadId: item.threadId, turnId }).catch(() => {});
    this.streaming.delete(id);
    this.allowed.delete(id);
    let result: RemoveResult = { branchDeleted: false };
    // 移除一律刪本機分支（遠端不動）；還沒分到資料夾的（排隊中）沒有分支要刪；
    // 待補測的單不佔資料夾，分支在原本做的那個資料夾
    const holder = !item.folder && item.status === 'parked' ? await this.folderHolding(item) : null;
    const target = holder ? { ...item, folder: this.deps.settings().folders.find((f) => f.path === holder)?.name ?? null } : item;
    if (target.folder) {
      try {
        result = await this.deleteLocalBranch(target);
      } catch (error) {
        result = { branchDeleted: false, reason: t('刪除失敗：{error}', { error: (error as Error).message }) };
      }
    }
    // 移植時抓過來的來源（refs/flowpilot-source/…）一起清掉；同一個來源還有別的移植在做就留著
    const sharing = this.deps.store.listWorkItems().some((i) => i.id !== id && i.portOf?.branch === item.portOf?.branch);
    if (item.portOf && !sharing) {
      for (const f of this.deps.settings().folders.filter((x) => x.project === item.project)) {
        await runGit(f.path, ['update-ref', '-d', `refs/flowpilot-source/${item.portOf.branch}`]).catch(() => null);
      }
    }
    this.update(id, { status: 'removed', lane: 'done', activity: result.branchDeleted ? t('你從看板移除了，也刪掉了本機分支') : t('你從看板移除了'), pending: null });
    this.forgetReview(item.ticketKey);
    void this.schedule();
    return result;
  }

  async retry(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!['blocked', 'failed', 'stopped'].includes(item.status)) throw new Error(t('只有卡住、失敗或停止的單可以重試'));
    if (item.threadId) {
      // 失敗、停止時資料夾已經讓出：先確認沒有別張單在用、資料夾還在這張單的分支上，才接著原本的對話繼續
      if (item.folder) {
        const other = this.deps.store.listWorkItems().find((i) => i.id !== id && i.folder === item.folder && OCCUPYING.includes(i.status));
        if (other) throw new Error(t('資料夾 {folder} 正在做 {ticket}，等它完成或移除後再重試', { folder: item.folder, ticket: other.ticketKey }));
        const branch = await currentBranch(this.folderPath(item.folder)).catch(() => '');
        if (branch !== item.branch) throw new Error(t('資料夾 {folder} 現在在 {current}，不是這張單的分支 {branch}；切回這條分支後再重試', { folder: item.folder, current: branch || t('（讀不到）'), branch: item.branch }));
      }
      const before = { status: item.status, activity: item.activity };
      this.update(id, { status: 'running', activity: t('繼續執行') });
      try {
        await this.reply(id, '請從剛才中斷的地方繼續。');
      } catch (error) {
        // 沒接上就回到原本的狀態，不要卡在「執行中」
        this.update(id, before);
        throw error;
      }
      return;
    }
    this.allowed.delete(id);
    this.update(id, { status: 'queued', lane: 'waiting', folder: null, activity: '' });
    await this.schedule();
  }

  async openInVSCode(id: number) {
    const item = this.deps.store.getWorkItem(id)!;
    if (!item.threadId || !item.folder) throw new Error(t('這張單還沒開始執行'));
    await this.deps.vscode.attach(this.deps.settings().folders, { threadId: item.threadId, folder: item.folder, ticketKey: item.ticketKey });
  }

  /**
   * 在這張單的對話開始新的一輪。
   * 對話不在 Codex 的記憶體裡時（例如 FlowPilot 重新啟動過，失敗或停止的單不會自動接回），先接回再開始。
   */
  private async startTurn(item: StoredWorkItem, input: object[]): Promise<string> {
    this.assertOnBranch(item); // 叫 AI 做事一律經過這裡：資料夾不在這張單的分支就不開始
    const threadId = item.threadId!;
    input = withReplyLanguage(input);
    const start = () => this.deps.codex.request<{ turn: { id: string } }>('turn/start', { threadId, input });
    let turn: { id: string };
    try {
      ({ turn } = await start());
    } catch (error) {
      if (!/thread not found/i.test((error as Error).message)) throw error;
      this.deps.log(`${item.ticketKey}：對話不在 Codex 的記憶體裡，先接回再繼續`);
      await this.deps.codex.request('thread/resume', { threadId, excludeTurns: true, config: threadConfig(this.deps.dataDir, this.deps.writeGuard, item.id, item.folder ? apiHosts(this.folderPath(item.folder)) : []) });
      ({ turn } = await start());
    }
    this.turns.set(threadId, turn.id);
    return turn.id;
  }

  /**
   * 移植的來源分支在哪裡：先找本機的資料夾（不用先推送，也拿得到還沒推送的提交），找不到才看遠端。
   * 回傳 { folder: 本機資料夾路徑 } 或 { remote: true }；都沒有就是 null。
   */
  private async findPortSource(project: string, branch: string): Promise<{ folder: string } | { remote: true } | null> {
    const folders = this.deps.settings().folders.filter((f) => f.project === project);
    for (const f of folders) if (await localBranchExists(f.path, branch).catch(() => false)) return { folder: f.path };
    for (const f of folders) {
      const remote = await runGit(f.path, ['ls-remote', '--heads', 'origin', branch]).catch(() => null);
      if (remote?.code === 0 && remote.stdout.trim()) return { remote: true };
    }
    return null;
  }

  /**
   * 把移植的來源抓到要做移植的資料夾，回傳可以拿來比對的 ref。
   * 來源在同一個資料夾就直接用本機分支；在別的資料夾就從那個資料夾抓（git fetch 本機路徑）；都沒有才從遠端抓。
   */
  private async fetchPortSource(cwd: string, project: string, src: PortSource): Promise<string> {
    await runGit(cwd, ['fetch', 'origin', src.baseBranch]).catch(() => null);
    const where = await this.findPortSource(project, src.branch);
    if (!where) throw new Error(t('找不到移植的來源 {branch}：本機的資料夾和遠端都沒有', { branch: src.branch }));
    if ('folder' in where) {
      if (where.folder === cwd) return src.branch;
      const ref = `refs/flowpilot-source/${src.branch}`;
      const result = await runGit(cwd, ['fetch', where.folder, `+refs/heads/${src.branch}:${ref}`]);
      if (result.code !== 0) throw new Error(t('從 {folder} 抓 {branch} 失敗：{error}', { folder: where.folder, branch: src.branch, error: result.stderr.trim() }));
      return ref;
    }
    await runGit(cwd, ['fetch', 'origin', src.branch]);
    return `origin/${src.branch}`;
  }

  /**
   * 多商戶的單：來源商戶完成之後，把功能移植到其他商戶。每個商戶一張新的工作（各自的分支、資料夾、對話），
   * 跟一般開發一樣排隊、開發（用 platform-web-copy 的做法）、自動測試、等你測試、提交推送發 PR 由你決定。
   * 來源分支不用先推送：移植前 FlowPilot 會從本機有這條分支的資料夾抓過來（都沒有才從遠端抓）。
   */
  async port(id: number): Promise<string[]> {
    const source = this.deps.store.getWorkItem(id)!;
    if (source.status !== 'committed') throw new Error(t('來源商戶要先完成（按「完成這張單」）才能移植'));
    if (!source.targetMerchants.length) throw new Error(t('這張單沒有要移植的商戶'));
    const settings = this.deps.settings();
    const rule = settings.projects[source.project];
    const folder = settings.folders.find((f) => f.project === source.project);
    if (!rule || !folder) throw new Error(t('設定檔裡沒有 {project} 的專案或資料夾', { project: source.project }));
    // 來源分支在本機任何一個資料夾、或在遠端都可以（不用先推送）
    const where = await this.findPortSource(source.project, source.branch);
    if (!where) throw new Error(t('找不到 {branch}：本機的資料夾和遠端都沒有', { branch: source.branch }));
    // 來源要真的有改動（比基底多提交）；沒有的話移植過去也是空的
    const at = 'folder' in where ? where.folder : folder.path;
    const ref = 'folder' in where ? source.branch : `origin/${source.branch}`;
    if (!('folder' in where)) await runGit(at, ['fetch', 'origin', source.branch]);
    const ahead = await runGit(at, ['rev-list', '--count', `origin/${source.baseBranch}..${ref}`]);
    if (ahead.code === 0 && Number(ahead.stdout.trim()) === 0) throw new Error(t('m{merchant} 的分支 {branch} 比 {base} 沒有任何提交，沒有東西可以移植', { merchant: source.merchant ?? '', branch: source.branch, base: source.baseBranch }));
    // 來源是開新分支（-2、-3）做的，移植目標也用同一版
    const seq = seqOf(source.branch, fill(rule.branch, { merchant: source.merchant, key: source.ticketKey })) ?? 1;
    const items = source.targetMerchants
      .map((m) => ({ m, branch: withSeq(fill(rule.branch, { merchant: m, key: source.ticketKey }), seq), baseBranch: fill(rule.baseBranch, { merchant: m, key: source.ticketKey }) }))
      .filter((t) => !this.deps.store.activeWorkItem(source.project, t.branch));
    if (!items.length) throw new Error(t('要移植的商戶都已經在工作台上了'));
    this.deps.store.createWorkItems(items.map((t) => ({
      runId: source.runId,
      ticketKey: source.ticketKey,
      ticketSummary: source.ticketSummary,
      mainKey: source.mainKey,
      mainUrl: source.mainUrl,
      project: source.project,
      merchant: t.m,
      targetMerchants: [],
      branch: t.branch,
      baseBranch: t.baseBranch,
      skill: PORT_SKILL,
      prTitle: source.prTitle,
      preferredFolder: null,
      portOf: { merchant: source.merchant!, branch: source.branch, baseBranch: source.baseBranch },
    })));
    this.update(id, { activity: t('已經開始移植到 {merchants}（在作戰中）', { merchants: items.map((x) => `m${x.m}`).join(t('、')) }) });
    void this.schedule();
    return items.map((t) => t.branch);
  }

  /** 啟動或重新連線後，重新訂閱還在進行中的對話，才收得到它們的進度 */
  async resubscribe(): Promise<void> {
    if (this.deps.paused) return;
    const active = this.deps.store.listWorkItems().filter((i) => i.threadId && ['running', 'waiting', 'review'].includes(i.status));
    if (active.length) await this.deps.codex.start();
    for (const item of active) {
      try {
        const { thread } = await this.deps.codex.request<{ thread: { status?: { type: string } } }>('thread/resume', { threadId: item.threadId, excludeTurns: true, config: threadConfig(this.deps.dataDir, this.deps.writeGuard, item.id, item.folder ? apiHosts(this.folderPath(item.folder)) : []) });
        if (item.status === 'running' && thread.status?.type === 'idle') {
          this.update(item.id, { status: 'waiting', activity: t('FlowPilot 重新啟動時這一輪已經結束，看一下最後的回覆'), pending: null });
        }
      } catch (error) {
        this.deps.log(`重新訂閱 ${item.ticketKey} 失敗：${(error as Error).message}`);
      }
    }
    // 正在做瀏覽器測試的單：本機網站是 FlowPilot 開的，重新啟動時跟著關了，馬上開回來（實際發生過：換版後 AI 測試時網站打不開）
    for (const item of this.deps.store.listWorkItems().filter((i) => i.folder && i.status === 'running' && ['autotest', 'retest'].includes(i.stage))) {
      void this.deps.ensureSite(item.folder!).catch((error) => this.deps.log(`${item.ticketKey}：重新啟動本機網站失敗：${(error as Error).message}`));
    }
    // 準備到一半被中斷的，重新準備
    for (const item of this.deps.store.listWorkItems().filter((i) => i.status === 'preparing')) void this.prepare(item.id);
    void this.schedule();
  }
}
