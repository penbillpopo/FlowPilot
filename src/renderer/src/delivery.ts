// 交付（提交、推送、完成）：標題列的主要按鈕與右邊的「改動」分頁共用同一份 Git 狀態與提交設定
import { useEffect, useState } from 'react';
import type { GitState, WorkItem } from '../../shared/types';

const api = window.flowpilot;
const CHANGED = 'flowpilot:git-changed';

/** environment.ts 是測試時切環境改的，不提交、不算改動 */
export const isTestOnly = (path: string) => /(^|\/)src\/environments\/environment[^/]*\.ts$/.test(path);

/** 提交訊息與身分（在「改動」分頁修改，標題列的「提交」按鈕照這個提交） */
const prefs = new Map<number, { message?: string; who?: string | null }>();
export const commitPrefs = (id: number) => prefs.get(id) ?? {};
export const setCommitPrefs = (id: number, next: { message?: string; who?: string | null }) => prefs.set(id, { ...prefs.get(id), ...next });

/** 提交、推送後通知另一邊馬上更新 */
export const gitChanged = () => window.dispatchEvent(new Event(CHANGED));

/** 讀 Git 狀態：AI 在改檔案時每 3 秒更新一次，一輪做完或提交、推送後馬上更新 */
export function useGitState(item: WorkItem, enabled = true) {
  const [state, setState] = useState<GitState | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function refresh() {
    if (!item.folder || !enabled) return;
    try {
      setState(await api.git.state(item.id));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }

  useEffect(() => {
    setState(null);
    if (!item.folder || !enabled) return;
    refresh();
    const timer = setInterval(refresh, 3000);
    window.addEventListener(CHANGED, refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener(CHANGED, refresh);
    };
  }, [item.id, item.folder, enabled]);

  useEffect(() => {
    refresh();
  }, [item.status]);

  return { state, error, refresh };
}

/** 從 Git 狀態看出交付走到哪：還有改動要提交、還有提交要推送、都推了 */
export function deliveryOf(item: WorkItem, state: GitState | null) {
  if (!state) return null;
  const changes = [...state.staged, ...state.unstaged].filter((f, i, all) => !isTestOnly(f.path) && all.findIndex((x) => x.path === f.path) === i);
  const pushCount = state.hasRemote ? (state.unpushed ?? 0) : state.ahead;
  return {
    onBranch: state.branch === item.branch,
    changes,
    pushCount,
    /** 已經提交過（這張單的分支比基底多了提交），而且沒有新的改動：進入交付 */
    delivering: state.branch === item.branch && changes.length === 0 && state.ahead > 0,
  };
}
