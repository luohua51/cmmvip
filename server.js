// ============================================================
//  server.js - 橙猫猫会员系统后端 API
//  兼容 Vercel Serverless 部署
// ============================================================

require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const { createClient } = require('@supabase/supabase-js');

const db = require('./db');
const { supabase } = db;
const { getOperatorDisplay, getMemberNickname } = db;

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================
//  跨项目客户端：陪玩系统（用于读取陪玩列表）
// ============================================================

const PLAYERS_SUPABASE_URL = 'https://xqtepnlmgtbvlhbvraga.supabase.co';
const PLAYERS_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxdGVwbmxtZ3RidmxoYnZyYWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5MzUwMDAsImV4cCI6MjEwNDUxMTAwMH0.7aIcOi0f2kWQaz9uF24iomkpgZyvU-V9HG9lx1weYaM';

const playersSupabase = createClient(PLAYERS_SUPABASE_URL, PLAYERS_SUPABASE_ANON_KEY);

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
      nickname: member.nickname,
      mustChangePassword: member.must_change_password || false
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
      balance: member.balance,
      mustChangePassword: member.must_change_password || false
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
//  修改密码
// ============================================================

app.get('/api/member/check-password', requireAuth, wrap(async (req, res) => {
  const mustChange = await db.checkMustChangePassword(req.session.userId);
  res.json({ ok: true, mustChange });
}));

app.post('/api/member/change-password', requireAuth, wrap(async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ ok: false, error: '请填写完整信息' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: '新密码至少6位' });
  }

  const result = await db.changeMemberPassword(
    req.session.userId,
    oldPassword,
    newPassword
  );

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error.message });
  }

  req.session.mustChangePassword = false;

  res.json({ ok: true, message: '密码修改成功' });
}));

// ============================================================
//  管理员 / 客服 API
// ============================================================

app.get('/api/admin/members', requireRole(['admin', 'operator']), wrap(async (req, res) => {
  const members = await db.getAllMembers();
  res.json({ ok: true, members });
}));

app.get('/api/admin/transactions', requireRole(['admin', 'operator']), wrap(async (req, res) => {
  const { data: txData, error: txError } = await supabase
    .from('member_transactions')
    .select('*')
    .order('created_at', { ascending: false });

  if (txError) {
    console.error('获取会员流水失败:', txError);
    return res.status(500).json({ ok: false, error: txError.message });
  }

  const { data: guestData, error: guestError } = await supabase
    .from('member_consumptions')
    .select('*')
    .is('user_id', null)
    .order('created_at', { ascending: false });

  if (guestError) {
    console.error('获取散客消费失败:', guestError);
    return res.status(500).json({ ok: false, error: guestError.message });
  }

  // ★★★ 格式化会员流水（已包含 player_name）★★★
  const memberTransactions = await Promise.all(
    (txData || []).map(async (tx) => {
      const operatorDisplay = await getOperatorDisplay(tx.operator_id);
      
      let memberName = '--';
      if (tx.user_id) {
        const nickname = await getMemberNickname(tx.user_id);
        if (nickname) {
          memberName = nickname;
        } else {
          const { data: user } = await supabase
            .from('auth.users')
            .select('email')
            .eq('id', tx.user_id)
            .maybeSingle();
          if (user?.email) memberName = user.email;
        }
      }

      // ★★★ 查询陪玩名字 ★★★
      let playerName = null;
      if (tx.type === 'consume' && tx.id) {
        const { data: consume } = await supabase
          .from('member_consumptions')
          .select('player_name')
          .eq('transaction_id', tx.id)
          .maybeSingle();
        if (consume) playerName = consume.player_name;
      }

      return {
        ...tx,
        type_label: tx.type === 'recharge' ? '充值' : tx.type === 'consume' ? '消费' : tx.type,
        is_guest: false,
        member: { nickname: memberName },
        operator: { email: operatorDisplay },
        player_name: playerName || null  // ★★★ 新增 ★★★
      };
    })
  );

  // 散客消费格式化（已有 player_name）
  const guestTransactions = await Promise.all(
    (guestData || []).map(async (g) => {
      let operatorDisplay = '系统';
      if (g.operator_id) {
        operatorDisplay = await getOperatorDisplay(g.operator_id);
      }
      return {
        ...g,
        type: 'consume',
        type_label: '散客消费',
        amount: g.total_price || 0,
        balance_after: null,
        description: g.remark || '散客消费',
        created_at: g.created_at,
        is_guest: true,
        member: { nickname: '🧾 散客' },
        operator: { email: operatorDisplay },
        player_name: g.player_name || null,
        game_name: g.game_name,
        duration: g.duration,
        order_type: g.order_type,
        remark: g.remark
      };
    })
  );

  const allTransactions = [...memberTransactions, ...guestTransactions];
  allTransactions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({ ok: true, transactions: allTransactions });
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
      balance: 0,
      must_change_password: true
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

app.post('/api/admin/reset-password', requireRole(['admin', 'operator']), wrap(async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ ok: false, error: '请选择会员' });
  }

  const member = await db.getMemberByUserId(userId);
  if (!member) {
    return res.status(404).json({ ok: false, error: '会员不存在' });
  }

  const result = await db.resetPasswordToDefault(userId);

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error.message });
  }

  res.json({ ok: true, message: '密码已重置为 123456' });
}));

// ============================================================
//  散客消费登记（含操作人记录）
// ============================================================

app.post('/api/admin/guest/consume', requireRole(['admin', 'operator']), wrap(async (req, res) => {
  const { gameName, orderType, playerName, amount, duration, unitPrice, remark } = req.body;

  if (!playerName) {
    return res.status(400).json({ ok: false, error: '请选择陪玩' });
  }
  if (!amount || parseFloat(amount) <= 0) {
    return res.status(400).json({ ok: false, error: '请输入有效金额' });
  }

  const { data, error } = await supabase
    .from('member_consumptions')
    .insert({
      user_id: null,
      transaction_id: null,
      order_type: orderType || '陪玩下单',
      game_name: gameName || '',
      player_name: playerName,
      duration: duration || '',
      unit_price: unitPrice || 0,
      total_price: parseFloat(amount),
      remark: remark || '散客消费',
      operator_id: req.session.userId
    })
    .select()
    .single();

  if (error) {
    console.error('散客消费登记失败:', error);
    return res.status(400).json({ ok: false, error: error.message });
  }

  res.json({ ok: true, message: '散客消费已登记', consumption: data });
}));

// ============================================================
//  获取陪玩列表（跨项目读取陪玩系统的 players 表）
// ============================================================

app.get('/api/players/names', requireRole(['admin', 'operator']), wrap(async (req, res) => {
  try {
    const { data, error } = await playersSupabase
      .from('players')
      .select('id, name')
      .order('name', { ascending: true });

    if (error) {
      console.error('获取陪玩列表失败:', error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    res.json({ ok: true, players: data || [] });
  } catch (err) {
    console.error('跨项目请求失败:', err);
    res.status(500).json({ ok: false, error: err.message || '请求失败' });
  }
}));

// ============================================================
//  全局错误处理
// ============================================================

app.use((err, req, res, next) => {
  console.error('[服务器错误]', err);
  res.status(500).json({ ok: false, error: err.message || '服务器内部错误' });
});

// ============================================================
//  导出 app 供 Vercel Serverless 使用
// ============================================================
module.exports = app;

// ============================================================
//  本地开发启动
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