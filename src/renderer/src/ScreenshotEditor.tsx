// 截圖編輯：截完在這裡畫筆、框框、箭頭、打字、選顏色、復原，完成後附到輸入框。
// 畫的東西用圖片原本的像素座標記下來，完成時畫在原尺寸的圖上（不會因為縮小顯示而變糊）。
import { useEffect, useRef, useState } from 'react';

type Tool = 'pen' | 'rect' | 'arrow' | 'text';
type Point = { x: number; y: number };
type Shape =
  | { kind: 'pen'; color: string; width: number; points: Point[] }
  | { kind: 'rect' | 'arrow'; color: string; width: number; from: Point; to: Point }
  | { kind: 'text'; color: string; size: number; at: Point; text: string };

const COLORS = ['#ff3b30', '#ffcc00', '#007aff', '#34c759', '#ffffff', '#000000'];
const TOOLS: [Tool, string][] = [['pen', '畫筆'], ['rect', '框框'], ['arrow', '箭頭'], ['text', '文字']];

function draw(ctx: CanvasRenderingContext2D, shape: Shape, scale: number) {
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (shape.kind === 'text') {
    ctx.font = `600 ${shape.size * scale}px -apple-system, 'PingFang TC', sans-serif`;
    ctx.textBaseline = 'top';
    // 文字加一圈深色描邊，放在什麼背景上都看得清楚
    ctx.lineWidth = Math.max(2, shape.size * scale * 0.15);
    ctx.strokeStyle = shape.color === '#000000' ? '#ffffff' : 'rgba(0,0,0,0.75)';
    shape.text.split('\n').forEach((line, i) => {
      const y = shape.at.y * scale + i * shape.size * scale * 1.25;
      ctx.strokeText(line, shape.at.x * scale, y);
      ctx.fillText(line, shape.at.x * scale, y);
    });
    return;
  }
  ctx.lineWidth = shape.width * scale;
  if (shape.kind === 'pen') {
    ctx.beginPath();
    shape.points.forEach((p, i) => (i ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale)));
    ctx.stroke();
    return;
  }
  const { from, to } = shape;
  if (shape.kind === 'rect') {
    ctx.strokeRect(from.x * scale, from.y * scale, (to.x - from.x) * scale, (to.y - from.y) * scale);
    return;
  }
  // 箭頭：線＋實心三角形的頭
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = Math.max(12, shape.width * 4) * scale;
  ctx.beginPath();
  ctx.moveTo(from.x * scale, from.y * scale);
  ctx.lineTo(to.x * scale - Math.cos(angle) * head * 0.6, to.y * scale - Math.sin(angle) * head * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x * scale, to.y * scale);
  ctx.lineTo(to.x * scale - head * Math.cos(angle - Math.PI / 7), to.y * scale - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(to.x * scale - head * Math.cos(angle + Math.PI / 7), to.y * scale - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

export function ScreenshotEditor({ src, onDone, onCancel }: { src: string; onDone(png: Blob): void; onCancel(): void }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(4);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [undone, setUndone] = useState<Shape[]>([]);
  const [drawing, setDrawing] = useState<Shape | null>(null);
  const [typing, setTyping] = useState<{ at: Point; text: string } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: 0, h: 0, scale: 1 });

  // 讀圖，縮到能放進視窗的大小顯示（Retina 截圖是兩倍像素，顯示時再除以 2，看起來跟原本一樣大）
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      setImage(img);
      const box = area.current!.getBoundingClientRect();
      const scale = Math.min(1 / window.devicePixelRatio, box.width / img.naturalWidth, box.height / img.naturalHeight);
      setView({ w: Math.round(img.naturalWidth * scale), h: Math.round(img.naturalHeight * scale), scale });
    };
    img.src = src;
  }, [src]);

  // 線條、文字的大小用「顯示的大小」設定，換算回原圖像素
  const px = (n: number) => n / view.scale;

  useEffect(() => {
    const c = canvas.current;
    if (!c || !image) return;
    const ratio = window.devicePixelRatio;
    c.width = view.w * ratio;
    c.height = view.h * ratio;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.drawImage(image, 0, 0, view.w, view.h);
    for (const s of [...shapes, ...(drawing ? [drawing] : [])]) draw(ctx, s, view.scale);
  }, [image, view, shapes, drawing]);

  const undo = () => {
    if (!shapes.length) return;
    setUndone((u) => [...u, shapes[shapes.length - 1]]);
    setShapes((s) => s.slice(0, -1));
  };
  const redo = () => {
    if (!undone.length) return;
    setShapes((s) => [...s, undone[undone.length - 1]]);
    setUndone((u) => u.slice(0, -1));
  };
  const add = (shape: Shape) => {
    setShapes((s) => [...s, shape]);
    setUndone([]);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (typing) return; // 打字時的按鍵交給輸入框
      if (e.key === 'Escape') onCancel();
      if (e.metaKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const pointOf = (e: React.PointerEvent): Point => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / view.scale, y: (e.clientY - r.top) / view.scale };
  };

  function commitText() {
    if (typing?.text.trim()) add({ kind: 'text', color, size: px(18), at: typing.at, text: typing.text });
    setTyping(null);
  }

  function down(e: React.PointerEvent) {
    const p = pointOf(e);
    if (tool === 'text') {
      if (typing) commitText();
      setTyping({ at: p, text: '' });
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrawing(tool === 'pen' ? { kind: 'pen', color, width: px(width), points: [p] } : { kind: tool, color, width: px(width), from: p, to: p });
  }
  function move(e: React.PointerEvent) {
    if (!drawing) return;
    const p = pointOf(e);
    setDrawing(drawing.kind === 'pen' ? { ...drawing, points: [...drawing.points, p] } : drawing.kind === 'text' ? drawing : { ...drawing, to: p });
  }
  function up() {
    if (!drawing) return;
    const tiny = drawing.kind !== 'pen' && drawing.kind !== 'text' && Math.hypot(drawing.to.x - drawing.from.x, drawing.to.y - drawing.from.y) < px(4);
    if (!tiny) add(drawing);
    setDrawing(null);
  }

  /** 完成：畫在原尺寸的圖上 */
  function finish() {
    if (!image) return;
    if (typing) commitText();
    const out = document.createElement('canvas');
    out.width = image.naturalWidth;
    out.height = image.naturalHeight;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const all = typing?.text.trim() ? [...shapes, { kind: 'text' as const, color, size: px(18), at: typing.at, text: typing.text }] : shapes;
    for (const s of all) draw(ctx, s, 1);
    out.toBlob((blob) => blob && onDone(blob), 'image/png');
  }

  return (
    <div className="shot-overlay">
      <div className="shot-editor">
        <div className="shot-toolbar">
          {TOOLS.map(([t, label]) => (
            <button key={t} className={tool === t ? 'on' : ''} onClick={() => { if (typing) commitText(); setTool(t); }}>{label}</button>
          ))}
          <span className="shot-sep" />
          {COLORS.map((c) => (
            <button key={c} className={`shot-color ${color === c ? 'on' : ''}`} style={{ background: c }} title={c} onClick={() => setColor(c)} />
          ))}
          <span className="shot-sep" />
          <label className="shot-width" title="線條粗細">
            粗細
            <input type="range" min={2} max={12} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          </label>
          <span className="shot-sep" />
          <button disabled={!shapes.length} onClick={undo} title="⌘Z">復原</button>
          <button disabled={!undone.length} onClick={redo} title="⌘⇧Z">重做</button>
          <span className="push-right" />
          <button onClick={onCancel}>取消</button>
          <button className="primary" disabled={!image} onClick={finish}>完成，附上</button>
        </div>
        <div className="shot-area" ref={area}>
          <div className="shot-stage" style={{ width: view.w, height: view.h }}>
            <canvas
              ref={canvas}
              style={{ width: view.w, height: view.h, cursor: tool === 'text' ? 'text' : 'crosshair' }}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
            />
            {typing && (
              <textarea
                className="shot-text"
                autoFocus
                rows={1}
                value={typing.text}
                placeholder="打字，Enter 完成（Shift＋Enter 換行）"
                style={{ left: typing.at.x * view.scale, top: typing.at.y * view.scale, color, fontSize: 18 }}
                onChange={(e) => setTyping({ ...typing, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    commitText();
                  }
                  if (e.key === 'Escape') setTyping(null);
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
