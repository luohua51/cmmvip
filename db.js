// ============================================================
//  db.js - 橙猫猫会员系统数据库操作（无头像功能）
// ============================================================

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ 缺少 Supabase 环境变量，请在 .env 中配置');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false }
});

// ============================================================
//  工具函数
// ============================================================

async function getUserEmail(userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('auth.users')
    .select('email')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return data.email;
}

async function getMemberNickname(userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('member_profiles')
    .select('nickname')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return data.nickname || null;
}

async function getOperatorDisplay(userId) {
  if (!userId) return '系统';
  const nickname = await getMemberNickname(userId);
  if (nickname) return nickname;
  const email = await getUserEmail(userId);
  if (email) return email;
  return userId.substring(0, 8) + '...';
}

// ============================================================
//  会员操作
// ============================================================

async function getMemberByUserId(userId) {
  const { data, error } = await supabase
    .from('member_profiles')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error) return null;
  return data;
}

async function getAllMembers() {
  const { data: profiles, error: profileError } = await supabase
    .from('member_profiles')
    .select('*')
    .order('created_at', { ascending: false });

  if (profileError) {
    console.error('获取会员资料失败:', profileError);
    return [];
  }

  if (!profiles || profiles.length === 0) {
    return [];
  }

  const membersWithEmail = await Promise.all(
    profiles.map(async (profile) => {
      const email = await getUserEmail(profile.user_id);
      return {
        ...profile,
        email: email || ''
      };
    })
  );

  return membersWithEmail;
}

async function createMemberProfile(userId, nickname, phone) {
  const { data, error } = await supabase
    .from('member_profiles')
    .insert({
      user_id: userId,
      nickname: nickname || '新会员',
      phone: phone || '',
      role: 'member',
      balance: 0
    })
    .select()
    .single();
  if (error) return { error };
  return { data };
}

async function updateMemberProfile(userId, updates) {
  const { data, error } = await supabase
    .from('member_profiles')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId)
    .select()
    .single();
  if (error) return { error };
  return { data };
}

async function getMemberBalance(userId) {
  const { data, error } = await supabase
    .from('member_profiles')
    .select('balance')
    .eq('user_id', userId)
    .single();
  if (error) return { error };
  return { balance: data.balance };
}

// ============================================================
//  交易流水
// ============================================================

async function getMemberTransactions(userId) {
  const { data, error } = await supabase
    .from('member_transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('获取流水失败:', error);
    return [];
  }

  const withOperators = await Promise.all(
    data.map(async (tx) => {
      const operatorDisplay = await getOperatorDisplay(tx.operator_id);
      return {
        ...tx,
        operator: {
          id: tx.operator_id,
          email: operatorDisplay
        }
      };
    })
  );

  return withOperators;
}

async function getAllTransactions() {
  const { data, error } = await supabase
    .from('member_transactions')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('获取所有流水失败:', error);
    return [];
  }

  const withDetails = await Promise.all(
    data.map(async (tx) => {
      const operatorDisplay = await getOperatorDisplay(tx.operator_id);

      let memberDisplay = '--';
      if (tx.user_id) {
        const nickname = await getMemberNickname(tx.user_id);
        if (nickname) {
          memberDisplay = nickname;
        } else {
          const email = await getUserEmail(tx.user_id);
          if (email) {
            memberDisplay = email;
          }
        }
      }

      return {
        ...tx,
        member: {
          id: tx.user_id,
          nickname: memberDisplay
        },
        operator: {
          id: tx.operator_id,
          email: operatorDisplay
        }
      };
    })
  );

  return withDetails;
}

// ============================================================
//  充值 & 消费
// ============================================================

async function createRecharge(userId, amount, description, operatorId) {
  const { data: profile, error: getError } = await supabase
    .from('member_profiles')
    .select('balance')
    .eq('user_id', userId)
    .single();
  if (getError) return { error: getError };

  const newBalance = parseFloat(profile.balance) + parseFloat(amount);

  const { error: updateError } = await supabase
    .from('member_profiles')
    .update({ balance: newBalance, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (updateError) return { error: updateError };

  const { data: tx, error: txError } = await supabase
    .from('member_transactions')
    .insert({
      user_id: userId,
      type: 'recharge',
      amount: amount,
      balance_after: newBalance,
      description: description || '充值',
      operator_id: operatorId
    })
    .select()
    .single();
  if (txError) {
    await supabase
      .from('member_profiles')
      .update({ balance: profile.balance })
      .eq('user_id', userId);
    return { error: txError };
  }

  return { data: tx, newBalance };
}

async function createConsume(userId, amount, orderData, description, operatorId) {
  const { data: profile, error: getError } = await supabase
    .from('member_profiles')
    .select('balance')
    .eq('user_id', userId)
    .single();
  if (getError) return { error: getError };

  if (parseFloat(profile.balance) < parseFloat(amount)) {
    return { error: { message: '余额不足' } };
  }

  const newBalance = parseFloat(profile.balance) - parseFloat(amount);

  const { error: updateError } = await supabase
    .from('member_profiles')
    .update({ balance: newBalance, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (updateError) return { error: updateError };

  const { data: tx, error: txError } = await supabase
    .from('member_transactions')
    .insert({
      user_id: userId,
      type: 'consume',
      amount: amount,
      balance_after: newBalance,
      description: description || '消费',
      operator_id: operatorId
    })
    .select()
    .single();
  if (txError) {
    await supabase
      .from('member_profiles')
      .update({ balance: profile.balance })
      .eq('user_id', userId);
    return { error: txError };
  }

  const { data: consume, error: consumeError } = await supabase
    .from('member_consumptions')
    .insert({
      transaction_id: tx.id,
      user_id: userId,
      order_type: orderData.orderType || '陪玩下单',
      game_name: orderData.gameName || '',
      player_name: orderData.playerName || '',
      duration: orderData.duration || '',
      unit_price: orderData.unitPrice || 0,
      total_price: amount,
      remark: orderData.remark || ''
    })
    .select()
    .single();

  if (consumeError) {
    console.error('插入消费明细失败:', consumeError);
  }

  return { data: tx, consume: consume || null, newBalance };
}

// ============================================================
//  辅助
// ============================================================

async function getUserIdByProfileId(profileId) {
  const { data, error } = await supabase
    .from('member_profiles')
    .select('user_id')
    .eq('id', profileId)
    .single();
  if (error) return null;
  return data.user_id;
}

// ============================================================
//  导出
// ============================================================

module.exports = {
  supabase,
  getUserEmail,
  getMemberNickname,
  getOperatorDisplay,
  getMemberByUserId,
  getAllMembers,
  createMemberProfile,
  updateMemberProfile,
  getMemberBalance,
  getMemberTransactions,
  getAllTransactions,
  createRecharge,
  createConsume,
  getUserIdByProfileId
};