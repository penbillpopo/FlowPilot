// 把主程序的功能交給畫面使用（window.flowpilot）
import { contextBridge, ipcRenderer } from 'electron';
import type { FlowPilotApi } from '../shared/types';

const api: FlowPilotApi = {
  listTickets: (statuses) => ipcRenderer.invoke('tickets:list', statuses),
  statusOptions: () => ipcRenderer.invoke('tickets:statusOptions'),
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
  onStream: (listener) => {
    const handler = (_event: unknown, itemId: number, text: string) => listener(itemId, text);
    ipcRenderer.on('board:stream', handler);
    return () => ipcRenderer.removeListener('board:stream', handler);
  },
  onFocusItem: (listener) => {
    const handler = (_event: unknown, id: number) => listener(id);
    ipcRenderer.on('board:focus', handler);
    return () => ipcRenderer.removeListener('board:focus', handler);
  },
  startRun: (runId) => ipcRenderer.invoke('board:startRun', runId),
  reply: (id, text) => ipcRenderer.invoke('item:reply', id, text),
  approve: (id, accept) => ipcRenderer.invoke('item:approve', id, accept),
  decide: (id, optionId) => ipcRenderer.invoke('item:decide', id, optionId),
  stop: (id) => ipcRenderer.invoke('item:stop', id),
  retry: (id) => ipcRenderer.invoke('item:retry', id),
  openInVSCode: (id) => ipcRenderer.invoke('item:openInVSCode', id),
  terminal: {
    open: (id, cols, rows) => ipcRenderer.invoke('term:open', id, cols, rows),
    write: (id, data) => ipcRenderer.send('term:input', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    close: (id) => ipcRenderer.invoke('term:close', id),
    onData: (listener) => {
      const handler = (_event: unknown, id: number, data: string) => listener(id, data);
      ipcRenderer.on('term:data', handler);
      return () => ipcRenderer.removeListener('term:data', handler);
    },
    onExit: (listener) => {
      const handler = (_event: unknown, id: number, code: number) => listener(id, code);
      ipcRenderer.on('term:exit', handler);
      return () => ipcRenderer.removeListener('term:exit', handler);
    },
  },
};

contextBridge.exposeInMainWorld('flowpilot', api);
