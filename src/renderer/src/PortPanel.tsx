// 多商戶的單：來源商戶完成後，移植到其他商戶。每個商戶一張新的工作（各自的分支、資料夾、對話），
// 跟一般開發一樣：AI 移植、自動測試、等你測試，提交、推送、發 PR 由你決定。
import { useState } from 'react';
import type { WorkItem } from '../../shared/types';
import { errorText, STATUS_LABEL } from './ChatPanel';

const api = window.flowpilot;

export function PortPanel({ item, all }: { item: WorkItem; all: WorkItem[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!item.targetMerchants.length) return null;

  // 每個要移植的商戶，現在工作台上有沒有它的工作
  const work = (m: number) => all.find((i) => i.ticketKey === item.ticketKey && i.project === item.project && i.merchant === m && i.status !== 'removed');
  const missing = item.targetMerchants.filter((m) => !work(m));
  const names = (list: number[]) => list.map((m) => `m${m}`).join('、');

  async function port() {
    const ok = window.confirm(
      `把 ${item.ticketKey} 從 m${item.merchant} 移植到 ${names(missing)}？\n\n每個商戶會變成一張新的工作：從各自的 master 開分支，AI 照 m${item.merchant} 的改動在那個商戶重新實作，接著自動測試、等你測試。\n提交、推送、發 PR 一樣由你決定。\n\nm${item.merchant} 的分支不用先推送：FlowPilot 會從本機的資料夾抓過去。`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.port(item.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel port-panel">
      <strong>移植到其他商戶</strong>
      <ul className="port-list">
        {item.targetMerchants.map((m) => {
          const w = work(m);
          return (
            <li key={m}>
              <code>m{m}</code>
              {w ? <span className={`status ${w.status}`}>{STATUS_LABEL[w.status]}</span> : <span className="muted small">還沒移植</span>}
            </li>
          );
        })}
      </ul>
      {missing.length > 0 && (
        <button className="primary" disabled={busy} onClick={port}>{busy ? '建立中…' : `移植到 ${names(missing)}`}</button>
      )}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}
