#!/usr/bin/env node

/**
 * Fetch the latest user reply from the Feishu bot P2P chat.
 * Usage: node scripts/fetch-feishu-reply.mjs [--count N]
 *
 * Fetches the N (default 3) latest messages sent by the user (not the bot)
 * in the bot-user P2P chat, so you can see what the user replied on Feishu.
 */

import { execSync } from 'child_process';

const BOT_CHAT_ID = 'oc_a6613df5bd5abb7ea8fe2d24657ce308';

function main() {
  const count = parseInt(process.argv[2]?.replace('--count=', ''), 10) || 3;

  try {
    const cmd = `lark-cli im +chat-messages-list --chat-id ${BOT_CHAT_ID} --page-size ${Math.min(count * 3, 50)} --as bot`;
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 30000, shell: 'powershell.exe' });
    const parsed = JSON.parse(result);

    if (parsed.ok !== true) {
      console.error('Failed to fetch messages:', JSON.stringify(parsed.error));
      process.exit(1);
    }

    const allMessages = parsed.data?.items || [];
    // Filter to only user-sent messages
    const userMessages = allMessages
      .filter(msg => msg.sender?.sender_type === 'user')
      .slice(0, count);

    if (userMessages.length === 0) {
      console.log('暂无用户的飞书回复。');
      process.exit(0);
    }

    console.log(`用户的最新 ${userMessages.length} 条飞书回复：`);
    console.log('---');
    for (const msg of userMessages) {
      const time = msg.create_time || '';
      const body = msg.body?.content || msg.content || '(无文本内容)';
      console.log(`[${time}] ${body}`);
      console.log('---');
    }
  } catch (err) {
    console.error('Error fetching Feishu reply:', err.message);
    process.exit(1);
  }
}

main();
