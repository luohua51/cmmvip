// ============================================================
//  server.js - 橙猫猫会员系统后端 API（无头像功能）
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

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('member.sid');
    res.json({ ok: true });
  });
});

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

app.get('/api/member/profile', requireAuth, wrap(async (req, res) => {
  const member = await db.getMemberByUserId(req.session.userId);
  if (!member) {
    return res.status(404).json({ ok: false, error: '会员资料不存在' });
  }
  res.json({ ok: true, profile: member });
}));

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

app.get('/api/member/balance', requireAuth, wrap(async (req, res) => {
  const { balance, error } = await db.getMemberBalance(req.session.userId);
  if (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
  res.json({ ok: true, balance });
}));

app.get('/api/member/transactions', requireAuth, wrap(async (req, res) => {
  const transactions = await db.getMemberTransactions(req.session.userId);
  res.json({ ok: true, transactions });
}));

// ============================================================
//  管理员 / 客服 API
// ============================================================

app.get('/api/admin/members', requireRole(['admin', 'operator']), wrap(async (req, res) => {
  const members = await db.getAllMembers();
  res.json({ ok: true, members });
}));

app.get('/api/admin/transactions', requireRole(['admin', 'operator']), wrap(async (req, res) => {
  const transactions = await db.getAllTransactions();
  res.json({ ok: true, transactions });
}));

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

app.post('/api/admin/consume', requireRole(['admin', 'operator']), wrap(async (req, res) => {
  const { userId, amount, orderType, gameName, playerName, duration, unitPrice, remark } = req.body;
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

// ============================================================
//  管理员添加会员
// ============================================================

app.post('/api/admin/member/create', requireRole(['admin']), wrap(async (req, res) => {
  const { email, password, nickname, phone, role } = req.body;

  if (!email) {
    return res.status(400).json({ ok: false, error: '请输入邮箱' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ ok: false, error: '密码至少6位' });
  }

  const { data: existing } = await supabase
    .from('auth.users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (existing) {
    return res.status(400).json({ ok: false, error: '该邮箱已注册' });
  }

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
//  启动服务器
// ============================================================

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