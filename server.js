// ============================================================
//  server.js - 橙猫猫会员系统后端 API
//  兼容 Vercel Serverless 部署
// ============================================================

require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const db = require('./db');
const { supabase } = db;

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================
//  中间件
// ============================================================

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    name: 'member.sid',
    secret: process.env.SESSION_SECRET || 'member-system-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24
    }
  })
);

// 静态文件托管（HTML、图片等）
app.use(express.static(path.join(__dirname), { index: 'index.html' }));

// ============================================================
//  鉴权辅助
// ============================================================

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ ok: false, error: '请先登录' });
  }
  next();
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.session.userId) {
      return res.status(401).json({ ok: false, error: '请先登录' });
    }
    if (!roles.includes(req.session.role)) {
      return res.status(403).json({ ok: false, error: '权限不足' });
    }
    next();
  };
}

function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ============================================================
//  Auth 路由
// ============================================================

/**
 * 登录
 * POST /api/login
 * Body: { username, password }
 */
app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: '请输入账号和密码' });
  }

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: username,
    password: password
  });

  if (authError) {
    return res.status(401).json({ ok: false, error: '账号或密码错误' });
  }

  const member = await db.getMemberByUserId(authData.user.id);

  if (!member) {
    return res.status(401).json({ ok: false, error: '账号未关联会员资料' });
  }

  req.session.userId = authData.user.id;
  req.session.role = member.role || 'member';
  req.session.email = authData.user.email;
  req.session.profileId = member.id;

  let redirect = '/member.html';
  if (member.role === 'admin' || member.role === 'operator') {
    redirect = '/admin.html';
  }

  res.json({
    ok: true,
    redirect: redirect,
    user: {
      id: authData.user.id,
      email: authData.user.email,
      role: member.role,
      nickname: member.nickname
    }
  });
}));

/**
 * 登出
 * POST /api/logout
 */
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('member.sid');
    res.json({ ok: true });
  });
});

/**
 * 获取当前用户信息
 * GET /api/session
 */
app.get('/api/session', wrap(async (req, res) => {
  if (!req.session.userId) {
    return res.json({ ok: false });
  }

  const member = await db.getMemberByUserId(req.session.userId);
  if (!member) {
    req.session.destroy(() => {});
    return res.json({ ok: false });
  }

  res.json({
    ok: true,
    user: {
      id: req.session.userId,
      email: req.session.email,
      role: req.session.role,
      profileId: req.session.profileId,
      nickname: member.nickname,
      phone: member.phone,
      balance: member.balance
    }
  });
}));

// ============================================================
//  会员资料 API
// ============================================================

/**
 * 获取当前会员资料
 * GET /api/member/profile
 */
app.get('/api/member/profile', requireAuth, wrap(async (req, res) => {
  const member = await db.getMemberByUserId(req.session.userId);
  if (!member) {
    return res.status(404).json({ ok: false, error: '会员资料不存在' });
  }
  res.json({ ok: true, profile: member });
}));

/**
 * 更新会员资料（昵称、电话）
 * PUT /api/member/profile
 */
app.put('/api/member/profile', requireAuth, wrap(async (req, res) => {
  const { nickname, phone } = req.body;
  const { data, error } = await db.updateMemberProfile(req.session.userId, {
    nickname: nickname || undefined,
    phone: phone || undefined
  });
  if (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
  res.json({ ok: true, profile: data });
}));

// ============================================================
//  会员余额 & 流水 API
// ============================================================

/**
 * 获取会员余额
 * GET /api/member/balance
 */
app.get('/api/member/balance', requireAuth, wrap(async (req, res) => {
  const { balance, error } = await db.getMemberBalance(req.session.userId);
  if (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
  res.json({ ok: true, balance });
}));

/**
 * 获取会员流水（当前用户）
 * GET /api/member/transactions
 */
app.get('/api/member/transactions', requireAuth, wrap(async (req, res) => {
  const transactions = await db.getMemberTransactions(req.session.userId);
  res.json({ ok: true, transactions });
}));

// ============================================================
//  管理员 / 客服 API
// ============================================================

/**
 * 获取所有会员（管理员/客服）
 * GET /api/admin/members
 */
app.get('/api/admin/members', requireRole(['admin', 'operator']), wrap(async (req, res) => {
  const members = await db.getAllMembers();
  res.json({ ok: true, members });
}));

/**
 * 获取所有流水（管理员/客服）
 * GET /api/admin/transactions
 */
app.get('/api/admin/transactions', requireRole(['admin', 'operator']), wrap(async (req, res) => {
  const transactions = await db.getAllTransactions();
  res.json({ ok: true, transactions });
}));

/**
 * 充值（管理员/客服）
 * POST /api/admin/recharge
 * Body: { userId, amount, description }
 */
app.post('/api/admin/recharge', requireRole(['admin', 'operator']), wrap(async (req, res) => {
  const { userId, amount, description } = req.body;

  if (!userId) {
    return res.status(400).json({ ok: false, error: '请选择会员' });
  }
  if (!amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ ok: false, error: '请输入有效的充值金额' });
  }

  const result = await db.createRecharge(
    userId,
    parseFloat(amount),
    description || '人工充值',
    req.session.userId
  );

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error.message });
  }

  res.json({
    ok: true,
    message: '充值成功',
    newBalance: result.newBalance,
    transaction: result.data
  });
}));

/**
 * 消费（管理员/客服）
 * POST /api/admin/consume
 * Body: { userId, amount, orderType, gameName, playerName, duration, unitPrice, remark }
 */
app.post('/api/admin/consume', requireRole(['admin', 'operator']), wrap(async (req, res) => {
  const {
    userId,
    amount,
    orderType,
    gameName,
    playerName,
    duration,
    unitPrice,
    remark
  } = req.body;

  if (!userId) {
    return res.status(400).json({ ok: false, error: '请选择会员' });
  }
  if (!amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ ok: false, error: '请输入有效的消费金额' });
  }

  const result = await db.createConsume(
    userId,
    parseFloat(amount),
    {
      orderType: orderType || '陪玩下单',
      gameName: gameName || '',
      playerName: playerName || '',
      duration: duration || '',
      unitPrice: unitPrice ? parseFloat(unitPrice) : 0,
      remark: remark || ''
    },
    remark || '消费',
    req.session.userId
  );

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error.message });
  }

  res.json({
    ok: true,
    message: '消费成功',
    newBalance: result.newBalance,
    transaction: result.data,
    consumption: result.consume
  });
}));

/**
 * 管理员添加会员
 * POST /api/admin/member/create
 * Body: { email, password, nickname, phone, role }
 * 仅管理员可操作
 */
app.post('/api/admin/member/create', requireRole(['admin']), wrap(async (req, res) => {
  const { email, password, nickname, phone, role } = req.body;

  if (!email) {
    return res.status(400).json({ ok: false, error: '请输入邮箱' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ ok: false, error: '密码至少6位' });
  }

  // 1. 检查邮箱是否已注册
  const { data: existing } = await supabase
    .from('auth.users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (existing) {
    return res.status(400).json({ ok: false, error: '该邮箱已注册' });
  }

  // 2. 创建用户
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { nickname: nickname || email.split('@')[0] }
  });

  if (authError) {
    console.error('创建用户失败:', authError);
    return res.status(400).json({ ok: false, error: authError.message });
  }

  // 3. 创建会员资料
  const { data: profile, error: profileError } = await supabase
    .from('member_profiles')
    .insert({
      user_id: authData.user.id,
      nickname: nickname || email.split('@')[0],
      phone: phone || '',
      role: role || 'member',
      balance: 0
    })
    .select()
    .single();

  if (profileError) {
    // 回滚：删除已创建的用户
    await supabase.auth.admin.deleteUser(authData.user.id);
    console.error('创建会员资料失败:', profileError);
    return res.status(400).json({ ok: false, error: profileError.message });
  }

  res.json({
    ok: true,
    message: '会员创建成功',
    member: profile,
    password: password
  });
}));

// ============================================================
//  全局错误处理
// ============================================================

app.use((err, req, res, next) => {
  console.error('[服务器错误]', err);
  res.status(500).json({ ok: false, error: err.message || '服务器内部错误' });
});

// ============================================================
//  导出 app 供 Vercel Serverless 使用（重要！）
// ============================================================
module.exports = app;

// ============================================================
//  本地开发启动（仅在直接运行 node server.js 时执行）
// ============================================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║   🐱 橙猫猫会员系统已启动                         ║
  ║   http://localhost:${PORT}                        ║
  ║                                                   ║
  ║   登录: http://localhost:${PORT}/                  ║
  ║   会员中心: http://localhost:${PORT}/member.html   ║
  ║   管理员: http://localhost:${PORT}/admin.html      ║
  ╚═══════════════════════════════════════════════════╝
    `);
  });
}