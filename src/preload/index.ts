// 把主程序的功能交給畫面使用（window.flowpilot）
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { FlowPilotApi } from '../shared/types';

const api: FlowPilotApi = {
  listTickets: (statuses) => ipcRenderer.invoke('tickets:list', statuses),
  statusOptions: () => ipcRenderer.invoke('tickets:statusOptions'),
  planDrafts: () => ipcRenderer.invoke('plan:drafts'),
  planAdd: (tickets) => ipcRenderer.invoke('plan:add', tickets),
  planAddGroup: (tickets) => ipcRenderer.invoke('plan:addGroup', tickets),
  planSaveDraft: (key, plan) => ipcRenderer.invoke('plan:saveDraft', key, plan),
  planSetExtras: (key, extras) => ipcRenderer.invoke('plan:setExtras', key, extras),
  planDiscard: (keys) => ipcRenderer.invoke('plan:discard', keys),
  latestRun: () => ipcRenderer.invoke('run:latest'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  revealI18n: (id) => ipcRenderer.invoke('i18n:reveal', id),
  setLang: (lang) => ipcRenderer.invoke('lang:set', lang),
  // 拖曳進來的檔案在電腦上的路徑（新版 Electron 不能直接從檔案拿到路徑）
  pathForFile: (file) => webUtils.getPathForFile(file),
  resetSharedBrowser: () => ipcRenderer.invoke('sharedBrowser:reset'),
  openSettingsFile: () => ipcRenderer.invoke('settings:open'),
  planOptions: () => ipcRenderer.invoke('plan:options'),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  reviewTicket: (ticket, force) => ipcRenderer.invoke('review:run', ticket, !!force),
  setReviewChecks: (key, checks) => ipcRenderer.invoke('review:setChecks', key, checks),
  retrySpec: (key) => ipcRenderer.invoke('review:retrySpec', key),
  updateIssue: (ticketKey, issueId, patch) => ipcRenderer.invoke('review:updateIssue', ticketKey, issueId, patch),
  discussReview: (ticketKey, text, images) => ipcRenderer.invoke('review:discuss', ticketKey, text, images ?? []),
  requestRequirementUpdate: (itemId) => ipcRenderer.invoke('req:update', itemId),
  checkBranches: (plans, fetch) => ipcRenderer.invoke('plan:check', plans, fetch),
  confirmPlan: (plans, judgements) => ipcRenderer.invoke('plan:confirm', plans, judgements),
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
  remove: (id) => ipcRenderer.invoke('item:remove', id),
  branchInfo: (id) => ipcRenderer.invoke('item:branchInfo', id),
  finish: (id, restoreEnvironment, skipTests) => ipcRenderer.invoke('item:finish', id, restoreEnvironment, !!skipTests),
  interrupt: (id) => ipcRenderer.invoke('item:interrupt', id),
  send: (id, text, images) => ipcRenderer.invoke('item:send', id, text, images),
  saveImage: (bytes, extension) => ipcRenderer.invoke('chat:saveImage', bytes, extension),
  captureScreen: () => ipcRenderer.invoke('shot:capture'),
  chatHistory: (id) => ipcRenderer.invoke('chat:history', id),
  onChat: (listener) => {
    const handler = (_event: unknown, batch: [number, Parameters<typeof listener>[1]][]) => batch.forEach(([id, e]) => listener(id, e));
    ipcRenderer.on('chat:events', handler);
    return () => ipcRenderer.removeListener('chat:events', handler);
  },
  git: {
    state: (id) => ipcRenderer.invoke('git:state', id),
    diff: (id, path, staged) => ipcRenderer.invoke('git:diff', id, path, staged),
    stage: (id, paths) => ipcRenderer.invoke('git:stage', id, paths),
    unstage: (id, paths) => ipcRenderer.invoke('git:unstage', id, paths),
    discard: (id, paths) => ipcRenderer.invoke('git:discard', id, paths),
    commit: (id, message, identity) => ipcRenderer.invoke('git:commit', id, message, identity),
    commitAll: (id, message, identity) => ipcRenderer.invoke('git:commitAll', id, message, identity),
    push: (id) => ipcRenderer.invoke('git:push', id),
    commits: (id) => ipcRenderer.invoke('git:commits', id),
    commitFiles: (id, sha) => ipcRenderer.invoke('git:commitFiles', id, sha),
    commitDiff: (id, sha, path) => ipcRenderer.invoke('git:commitDiff', id, sha, path),
  },
  folderTerminal: {
    open: (id, cols, rows) => ipcRenderer.invoke('folderTerm:open', id, cols, rows),
    write: (folder, data) => ipcRenderer.send('folderTerm:input', folder, data),
    resize: (folder, cols, rows) => ipcRenderer.send('folderTerm:resize', folder, cols, rows),
    startSite: (id) => ipcRenderer.invoke('folderTerm:startSite', id),
    interrupt: (folder) => ipcRenderer.send('folderTerm:interrupt', folder),
    onData: (listener) => {
      const handler = (_event: unknown, folder: string, data: string) => listener(folder, data);
      ipcRenderer.on('folderTerm:data', handler);
      return () => ipcRenderer.removeListener('folderTerm:data', handler);
    },
    onUrl: (listener) => {
      const handler = (_event: unknown, folder: string, url: string | null) => listener(folder, url);
      ipcRenderer.on('folderTerm:url', handler);
      return () => ipcRenderer.removeListener('folderTerm:url', handler);
    },
    onExit: (listener) => {
      const handler = (_event: unknown, folder: string) => listener(folder);
      ipcRenderer.on('folderTerm:exit', handler);
      return () => ipcRenderer.removeListener('folderTerm:exit', handler);
    },
  },
  openUrl: (url) => ipcRenderer.invoke('shell:openUrl', url),
  retry: (id) => ipcRenderer.invoke('item:retry', id),
  openInVSCode: (id) => ipcRenderer.invoke('item:openInVSCode', id),
  port: (id) => ipcRenderer.invoke('item:port', id),
  park: (id) => ipcRenderer.invoke('item:park', id),
  resume: (id) => ipcRenderer.invoke('item:resume', id),
  switchBack: (id) => ipcRenderer.invoke('item:switchBack', id),
  relocate: (id) => ipcRenderer.invoke('item:relocate', id),
  retest: (id, mock) => ipcRenderer.invoke('item:retest', id, !!mock),
  rerunAutotest: (id, mock, shared) => ipcRenderer.invoke('item:rerunAutotest', id, !!mock, !!shared),
  rerunSpecCheck: (id) => ipcRenderer.invoke('item:rerunSpecCheck', id),
  syncBase: (id) => ipcRenderer.invoke('item:syncBase', id),
  ticketMarks: (keys) => ipcRenderer.invoke('tickets:marks', keys),
  ticketTransitions: (key) => ipcRenderer.invoke('tickets:transitions', key),
  transitionTicket: (key, id) => ipcRenderer.invoke('tickets:transition', key, id),
  pr: {
    options: (id) => ipcRenderer.invoke('pr:options', id),
    refresh: (id) => ipcRenderer.invoke('pr:refresh', id),
    create: (id, input) => ipcRenderer.invoke('pr:create', id, input),
    resolveConflict: (id, prId) => ipcRenderer.invoke('pr:resolveConflict', id, prId),
    jobs: (id) => ipcRenderer.invoke('pr:jobs', id),
    onProgress: (listener) => {
      const handler = (_event: unknown, id: number, prId: number, text: string) => listener(id, prId, text);
      ipcRenderer.on('pr:progress', handler);
      return () => ipcRenderer.removeListener('pr:progress', handler);
    },
  },
  test: {
    state: (id) => ipcRenderer.invoke('test:state', id),
    setEnvironment: (id, env) => ipcRenderer.invoke('test:setEnvironment', id, env),
    closeBrowsers: () => ipcRenderer.invoke('test:closeBrowsers'),
    trialLogin: (id) => ipcRenderer.invoke('test:trialLogin', id),
    setManualDone: (id, index, done) => ipcRenderer.invoke('test:setManualDone', id, index, done),
    setChecked: (id, no, checked) => ipcRenderer.invoke('test:setChecked', id, no, checked),
    setSpecSeen: (id, no, seen) => ipcRenderer.invoke('test:setSpecSeen', id, no, seen),
    requestAcceptance: (id) => ipcRenderer.invoke('test:requestAcceptance', id),
    changedFiles: (id) => ipcRenderer.invoke('test:changedFiles', id),
    exportCsv: (id) => ipcRenderer.invoke('test:exportCsv', id),
    report: (id) => ipcRenderer.invoke('report:generate', id),
    onReportProgress: (listener) => {
      const handler = (_event: unknown, id: number, text: string) => listener(id, text);
      ipcRenderer.on('report:progress', handler);
      return () => ipcRenderer.removeListener('report:progress', handler);
    },
    openPage: (id, page) => ipcRenderer.invoke('test:openPage', id, page),
    shot: (name) => ipcRenderer.invoke('test:shot', name),
  },
};

contextBridge.exposeInMainWorld('flowpilot', api);
