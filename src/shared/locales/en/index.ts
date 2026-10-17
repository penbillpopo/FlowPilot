// 英文對照表：照區域分檔，這裡合起來
import app from './app';
import chat from './chat';
import main from './main';
import plan from './plan';
import runner from './runner';
import side from './side';

export const EN: Record<string, string> = { ...app, ...chat, ...side, ...plan, ...main, ...runner };
