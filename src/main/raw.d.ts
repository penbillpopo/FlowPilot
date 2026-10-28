// Vite 的 ?raw：把檔案內容當成字串匯入（EGM 審查角色的原文）
declare module '*.md?raw' {
  const text: string;
  export default text;
}
