'use strict';
// 管理员密码统一从这里取 —— 测试和截图脚本里**不要**再硬编码。
//
// 为什么单独抽一个文件：以前 'asd2026' 被抄在 5 个脚本里，改密码就得改 5 处，
// 漏一处就得到一个「登录失败但看起来像功能坏了」的假故障。现在只有这一个入口。
//
// 取值顺序和 server.js 的首次运行约定保持一致：
//   1. data/admin.json 里的 password（正常情况，服务端启动时会写这个文件）
//   2. 环境变量 HR_ADMIN_PW（还没跑过服务端 / 全新克隆时）
// 两个都没有就返回空串，登录会明确失败，不会静默用错密码。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADMIN_FILE = path.join(ROOT, 'data', 'admin.json');

function adminPassword() {
  try {
    const j = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    if (j && j.password) return String(j.password);
  } catch (e) { /* 文件不存在 → 看环境变量 */ }
  return process.env.HR_ADMIN_PW || '';
}

module.exports = { adminPassword, ADMIN_FILE, ROOT };
