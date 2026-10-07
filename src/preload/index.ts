// 把主程序的功能交給畫面使用（window.flowpilot）
import { contextBridge, ipcRenderer } from 'electron';
import type { FlowPilotApi } from '../shared/types';

const api: FlowPilotApi = {
  listTickets: () => ipcRenderer.invoke('tickets:list'),
  createRun: (tickets) => ipcRenderer.invoke('run:create', tickets),
  latestRun: () => ipcRenderer.invoke('run:latest'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openSettingsFile: () => ipcRenderer.invoke('settings:open'),
  planOptions: () => ipcRenderer.invoke('plan:options'),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  judgeTicket: (ticket) => ipcRenderer.invoke('plan:judge', ticket),
  checkBranches: (plans, fetch) => ipcRenderer.invoke('plan:check', plans, fetch),
  confirmPlan: (runId, plans, judgements) => ipcRenderer.invoke('plan:confirm', runId, plans, judgements),
  board: () => ipcRenderer.invoke('board:get'),
  onBoardChanged: (listener) => {
    const handler = (_event: unknown, board: Parameters<typeof listener>[0]) => listener(board);
    ipcRenderer.on('board:changed', handler);
    return () => ipcRenderer.removeListener('board:changed', handler);
  },
  onFocusItem: (listener) => {
    const handler = (_event: unknown, id: number) => listener(id);
    ipcRenderer.on('board:focus', handler);
    return () => ipcRenderer.removeListener('board:focus', handler);
  },
  startRun: (runId) => ipcRenderer.invoke('board:startRun', runId),
  reply: (id, text) => ipcRenderer.invoke('item:reply', id, text),
  approve: (id, accept) => ipcRenderer.invoke('item:approve', id, accept),
  stop: (id) => ipcRenderer.invoke('item:stop', id),
  retry: (id) => ipcRenderer.invoke('item:retry', id),
  openInVSCode: (id) => ipcRenderer.invoke('item:openInVSCode', id),
};

contextBridge.exposeInMainWorld('flowpilot', api);
