// 外觀：「盟軍」或「蘇聯」（紅色警戒 2 風格，全部自己畫，不用遊戲的圖、字型、音效）。
// 另外可以開音效（自己合成的提示音）、指揮官語音（系統語音念自己寫的台詞）、指揮官用語（狀態、階段換成作戰用語）。
import { useEffect, useState } from 'react';
import type { WorkItem, WorkStatus } from '../../shared/types';

export interface SkinSettings {
  theme: 'allied' | 'soviet';
  sound: boolean;
  voice: boolean;
  lingo: boolean;
}

const KEY = 'flowpilot.skin';
const DEFAULTS: SkinSettings = { theme: 'allied', sound: true, voice: true, lingo: true };

function load(): SkinSettings {
  try {
    const saved = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    // 以前的「標準」外觀拿掉了，改成盟軍
    if (saved.theme !== 'allied' && saved.theme !== 'soviet') saved.theme = 'allied';
    return saved;
  } catch {
    return DEFAULTS;
  }
}

/** 目前的設定（給不在 React 裡的地方讀，例如狀態文字） */
let current = load();
export const skin = () => current;

function apply(next: SkinSettings) {
  current = next;
  document.documentElement.dataset.skin = next.theme;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
}
apply(current);

/** 在最上層用：設定改變時整個畫面跟著重畫（狀態文字、用語都會換） */
export function useSkin(): [SkinSettings, (patch: Partial<SkinSettings>) => void] {
  const [settings, setSettings] = useState(current);
  return [
    settings,
    (patch) => {
      const next = { ...settings, ...patch };
      apply(next);
      setSettings(next);
      const switched = !!patch.theme && patch.theme !== settings.theme;
      if (next.sound && (switched || patch.sound)) play('ready');
      // 切換陣營：用新陣營的聲音念一段開場白（台詞自己寫的）
      if (switched || patch.voice) say('selected');
    },
  ];
}

// ---- 用語 ----

const STATUS: Record<WorkStatus, [string, string]> = {
  queued: ['排隊中', '待建造'],
  preparing: ['準備中', '部署中'],
  running: ['執行中', '建造中'],
  waiting: ['等你回答', '等候指令'],
  review: ['等你測試', '建造完成'],
  blocked: ['卡住了', '受阻'],
  failed: ['失敗', '任務失敗'],
  stopped: ['已停止', '已取消'],
  removed: ['已移除', '已拆除'],
  parked: ['待補測', '待補測'],
  committed: ['已完成', '任務完成'],
};

/** 狀態文字：開了指揮官用語就換成作戰用語 */
export const statusLabel = (status: WorkStatus) => STATUS[status][current.lingo ? 1 : 0];

/** 一般文字 → 指揮官用語（沒開就原樣） */
const LINGO: Record<string, string> = {
  工作台: '作戰室',
  單列表: '任務簡報',
  進行中: '作戰中',
  排隊: '生產佇列',
  已完成: '已完成任務',
  審閱: '偵察',
  開發: '建造',
  自動測試: '實戰演練',
  等你測試: '指揮官驗收',
  交付: '部署',
};
export const term = (text: string) => (current.lingo ? LINGO[text] ?? text : text);

// ---- 音效（Web Audio 自己合成）----

type Cue = 'ready' | 'attention' | 'fail' | 'start' | 'done' | 'click' | 'doors';
let audio: AudioContext | null = null;

function tone(ctx: AudioContext, at: number, freq: number, length: number, type: OscillatorType = 'square', gain = 0.06, slideTo?: number) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 3200;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + length);
  amp.gain.setValueAtTime(0, at);
  amp.gain.linearRampToValueAtTime(gain, at + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(filter).connect(amp).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

/** 播提示音：做完（上揚三連音）、要你處理（兩聲急促）、失敗（下滑低音）、開工、任務完成、按鈕 */
export function play(cue: Cue) {
  if (!current.sound) return;
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    const now = ctx.currentTime + 0.02;
    switch (cue) {
      case 'ready':
        [880, 1175, 1568].forEach((f, i) => tone(ctx, now + i * 0.09, f, 0.12, 'square', 0.05));
        tone(ctx, now + 0.27, 2093, 0.35, 'sine', 0.05);
        break;
      case 'attention':
        for (let i = 0; i < 2; i++) tone(ctx, now + i * 0.18, 1320, 0.1, 'square', 0.06);
        break;
      case 'fail':
        tone(ctx, now, 330, 0.5, 'sawtooth', 0.06, 110);
        break;
      case 'start':
        tone(ctx, now, 440, 0.08, 'square', 0.04);
        tone(ctx, now + 0.08, 660, 0.12, 'square', 0.04);
        break;
      case 'done':
        [523, 659, 784, 1047].forEach((f, i) => tone(ctx, now + i * 0.11, f, 0.25, 'triangle', 0.07));
        break;
      case 'doors': {
        // 防爆門：氣壓滑動的嘶聲（濾波過的雜訊）＋合上時的低沉撞擊＋打開時再一次嘶聲
        const hiss = (at: number, length: number, from: number, to: number, gain: number) => {
          const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          const filter = ctx.createBiquadFilter();
          filter.type = 'bandpass';
          filter.Q.value = 1.2;
          filter.frequency.setValueAtTime(from, at);
          filter.frequency.exponentialRampToValueAtTime(to, at + length);
          const amp = ctx.createGain();
          amp.gain.setValueAtTime(0, at);
          amp.gain.linearRampToValueAtTime(gain, at + 0.05);
          amp.gain.exponentialRampToValueAtTime(0.0001, at + length);
          src.connect(filter).connect(amp).connect(ctx.destination);
          src.start(at);
        };
        hiss(now, 0.4, 2400, 500, 0.12);
        tone(ctx, now + 0.4, 90, 0.25, 'sine', 0.22, 45);
        tone(ctx, now + 0.4, 180, 0.08, 'square', 0.05, 90);
        hiss(now + 0.62, 0.45, 600, 2600, 0.08);
        break;
      }
      case 'click':
        tone(ctx, now, 2400, 0.03, 'square', 0.025, 1800);
        break;
    }
  } catch {}
}

// ---- 指揮官語音（系統內建的語音合成，念自己寫的台詞）----

/**
 * 指揮官語音：預先錄好的音檔（scripts/make-voices.mjs 用 macOS 的 say 錄的，放在 public/voice）。
 * 盟軍是女聲（Allied forces selected.）、蘇聯是低沉的男聲（Soviet empire selected.）。
 * 不用瀏覽器的語音合成：每台電腦拿到的聲音不一定一樣，男聲壓低音調也容易失真。
 */
export type VoiceLine = 'selected' | 'building' | 'complete' | 'authorize' | 'orders' | 'unable' | 'canceled' | 'accomplished' | 'options';

let speaking: HTMLAudioElement | null = null;
export function say(line: VoiceLine) {
  if (!current.voice) return;
  try {
    speaking?.pause(); // 新的一句蓋過上一句
    speaking = new Audio(`./voice/${current.theme}-${line}.m4a`);
    speaking.volume = 0.9;
    void speaking.play().catch(() => {});
  } catch {}
}

// ---- 工作台變化 → 音效與語音 ----

/** 狀態變成什麼時要播什麼（台詞自己寫，只取那個味道） */
function cueFor(item: WorkItem, before: WorkStatus | undefined): [Cue, VoiceLine] | null {
  if (before === item.status) return null;
  switch (item.status) {
    case 'running':
      return before === 'queued' || before === 'preparing' ? ['start', 'building'] : null;
    case 'review':
      return ['ready', 'complete'];
    case 'waiting':
      return ['attention', item.pending?.kind === 'approval' ? 'authorize' : 'orders'];
    case 'failed':
    case 'blocked':
      return ['fail', 'unable'];
    case 'stopped':
      return ['click', 'canceled'];
    case 'committed':
      return ['done', 'accomplished'];
    default:
      return null;
  }
}

/** 看工作台每張單的狀態變化，播對應的音效與語音（同時好幾張變化時只播最重要的一個） */
export function useBoardCues(items: WorkItem[] | null) {
  const [seen, setSeen] = useState<Map<number, WorkStatus> | null>(null);
  useEffect(() => {
    if (!items) return;
    const next = new Map(items.map((i) => [i.id, i.status]));
    if (seen) {
      const rank: Cue[] = ['fail', 'attention', 'done', 'ready', 'start', 'click'];
      const cues = items.map((i) => cueFor(i, seen.get(i.id))).filter((c): c is [Cue, VoiceLine] => !!c);
      const added = items.some((i) => !seen.has(i.id));
      if (added && !cues.length) cues.push(['start', 'options']);
      cues.sort((a, b) => rank.indexOf(a[0]) - rank.indexOf(b[0]));
      if (cues[0]) {
        play(cues[0][0]);
        say(cues[0][1]);
      }
    }
    setSeen(next);
  }, [items]);
}
