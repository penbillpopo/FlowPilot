// 附圖：「附圖」按鈕選檔、拖曳進來（有沒有按 Shift 都可以）、直接貼上。存到本機後給 AI 看，輸入框上方顯示縮圖、可以拿掉。
import { useRef, useState } from 'react';

const api = window.flowpilot;

export interface ImageAttach {
  images: string[];
  clear(): void;
  /** 掛在輸入框（或包住輸入框的區塊）上：貼上、拖曳 */
  bind: {
    onPaste(e: React.ClipboardEvent): void;
    onDragOver(e: React.DragEvent): void;
    onDragLeave(): void;
    onDrop(e: React.DragEvent): void;
  };
  dragging: boolean;
  /** 縮圖列＋「附圖」按鈕 */
  view: React.ReactNode;
  pickButton: React.ReactNode;
}

export function useImageAttach(): ImageAttach {
  const [images, setImages] = useState<{ path: string; preview: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  async function add(files: File[]) {
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      const path = await api.saveImage(await file.arrayBuffer(), file.type.split('/')[1] ?? 'png');
      setImages((prev) => [...prev, { path, preview: URL.createObjectURL(file) }]);
    }
  }

  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');

  return {
    images: images.map((i) => i.path),
    clear: () => setImages([]),
    dragging,
    bind: {
      onPaste(e) {
        const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return;
        e.preventDefault();
        void add(files);
      },
      onDragOver(e) {
        if (!hasFiles(e)) return;
        e.preventDefault(); // 允許放下（否則 Electron 會把圖片當網頁打開）
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      },
      onDragLeave() {
        setDragging(false);
      },
      onDrop(e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        void add([...e.dataTransfer.files]);
      },
    },
    pickButton: (
      <>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <button type="button" className="attach-button" title="附上圖片（也可以拖曳進輸入框或直接貼上）" onClick={() => picker.current?.click()}>
          附圖
        </button>
      </>
    ),
    view: images.length > 0 && (
      <div className="attach-thumbs">
        {images.map((img, i) => (
          <span key={img.path} className="attach-thumb" title={img.path}>
            <img src={img.preview} alt={`圖片 ${i + 1}`} />
            <button className="link" title="拿掉" onClick={() => setImages((prev) => prev.filter((p) => p.path !== img.path))}>×</button>
          </span>
        ))}
      </div>
    ),
  };
}
