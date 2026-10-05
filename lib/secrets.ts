import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const account = 'ZhaopinAssistant';
const service = 'ZhaopinAssistantAI';

export async function saveApiKey(apiKey: string) {
  if (process.env.ZHAOPIN_DISABLE_KEYCHAIN === '1')
    throw new Error('测试环境已禁用钥匙串写入');
  if (process.platform !== 'darwin') throw new Error('当前仅支持 macOS 钥匙串');
  await execFileAsync(
    'security',
    ['add-generic-password', '-a', account, '-s', service, '-w', apiKey, '-U'],
    { timeout: 15000, maxBuffer: 8192 },
  );
}

export async function readApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (process.env.ZHAOPIN_DISABLE_KEYCHAIN === '1') return '';
  if (process.platform !== 'darwin') return '';
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-a',
      account,
      '-s',
      service,
      '-w',
    ]);
    return stdout.trim();
  } catch {
    return '';
  }
}
