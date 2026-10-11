// 用固定的自簽憑證簽 FlowPilot.app（只給這台電腦用）。
// 為什麼：臨時簽章每次打包都不同，macOS 會把每一版當成新的應用程式，一直重新詢問「取用桌面檔案夾」的權限。
// 固定憑證簽出來的每一版，macOS 都認得是同一個應用程式。
// 憑證與專用鑰匙圈放在 ~/.flowpilot-signing（不在專案裡、不提交），不動你的登入鑰匙圈，所以不用輸入密碼。
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const app = process.argv[2];
if (!app || !existsSync(app)) throw new Error(`找不到要簽名的應用程式：${app}`);

const NAME = 'FlowPilot Local Signing';
const dir = join(homedir(), '.flowpilot-signing');
const keychain = join(dir, 'flowpilot.keychain-db');
const passwordFile = join(dir, 'keychain-password');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString();

if (!existsSync(keychain)) {
  console.log('第一次使用：建立 FlowPilot 專用的簽名憑證與鑰匙圈');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString('hex');
  writeFileSync(passwordFile, password, { mode: 0o600 });
  const work = join(dir, 'tmp');
  mkdirSync(work, { recursive: true });
  try {
    writeFileSync(join(work, 'cert.cnf'), [
      '[req]', 'distinguished_name = dn', 'x509_extensions = ext', 'prompt = no',
      '[dn]', `CN = ${NAME}`,
      '[ext]', 'basicConstraints = critical,CA:false', 'keyUsage = critical,digitalSignature', 'extendedKeyUsage = critical,codeSigning',
    ].join('\n'));
    // 系統內建的 openssl（LibreSSL）產生的 p12，macOS 的 security 才匯入得了
    run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-config', join(work, 'cert.cnf'), '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem')]);
    run('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', join(work, 'key.pem'), '-in', join(work, 'cert.pem'), '-name', NAME, '-out', join(work, 'cert.p12'), '-passout', `pass:${password}`]);
    run('security', ['create-keychain', '-p', password, keychain]);
    run('security', ['set-keychain-settings', keychain]); // 不自動上鎖
    run('security', ['import', join(work, 'cert.p12'), '-k', keychain, '-P', password, '-T', '/usr/bin/codesign']);
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const password = readFileSync(passwordFile, 'utf8').trim();
run('security', ['unlock-keychain', '-p', password, keychain]);
// 自簽憑證不受系統信任，用名稱找不到，改用憑證指紋指定
const hash = run('security', ['find-identity', '-p', 'codesigning', keychain]).match(/\b([0-9A-F]{40})\b "FlowPilot Local Signing"/)?.[1];
if (!hash) throw new Error('專用鑰匙圈裡找不到 FlowPilot 的簽名憑證');
// codesign 只在鑰匙圈搜尋清單裡找身分：簽名時暫時加進去，簽完改回原本的清單
const original = run('security', ['list-keychains', '-d', 'user']).split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
run('security', ['list-keychains', '-d', 'user', '-s', ...original.filter((k) => k !== keychain), keychain]);
try {
  run('codesign', ['--force', '--deep', '--sign', hash, '--keychain', keychain, app]);
} finally {
  run('security', ['list-keychains', '-d', 'user', '-s', ...original]);
}
run('codesign', ['--verify', '--deep', app]);
console.log(`已用「${NAME}」簽名：${run('codesign', ['-d', '-r-', app], { stdio: ['ignore', 'pipe', 'pipe'] }).trim() || '（見 codesign -d -r-）'}`);
