#!/usr/bin/env node

/**
 * Send a task summary to the user's Feishu via lark-cli IM.
 * Usage: node scripts/send-feishu-notification.mjs <summary_text>
 *
 * The summary text can be a multi-line markdown string.
 * Uses a temp file to avoid shell escaping issues with multi-line content.
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const USER_OPEN_ID = 'ou_ca10907ce155f6407edd93ffed22d923';

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/send-feishu-notification.mjs <summary_text>');
    process.exit(1);
  }

  const summary = args.join(' ');

  // Build the markdown message
  const markdown = [
    '## Trae 任务完成',
    '',
    summary,
    '',
    '---',
    `*发送时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' })}*`,
  ].join('\n');

  // Write to temp file, pass via stdin redirection
  // Using Get-Content to read the temp file and pipe to --markdown
  const tmpDir = mkdtempSync(join(tmpdir(), 'feishu-notif-'));
  const tmpFile = join(tmpDir, 'msg.md');
  writeFileSync(tmpFile, markdown, 'utf-8');

  try {
    // PowerShell: read file into a variable, pass to lark-cli
    const cmd = `$md = Get-Content -Raw -Encoding utf8 '${tmpFile.replace(/'/g, "''")}'; lark-cli im +messages-send --user-id ${USER_OPEN_ID} --markdown $md --as bot`;
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 30000, shell: 'powershell.exe' });
    const parsed = JSON.parse(result);
    if (parsed.ok === true) {
      console.log(`Message sent: ${parsed.data.message_id}`);
    } else {
      console.error('Failed to send message:', JSON.stringify(parsed.error));
      process.exit(1);
    }
  } catch (err) {
    console.error('Error sending Feishu notification:', err.message);
    process.exit(1);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    try { unlinkSync(tmpDir); } catch { /* ignore */ }
  }
}

main();
