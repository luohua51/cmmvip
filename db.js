// ============================================================
//  db.js - 橙猫猫会员系统数据库操作
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
  
  // 1. 优先查 member_profiles 的 nickname
  const nickname = await getMemberNickname(userId);
  if (nickname) return nickname;
  
  // 2. 查 auth.users 的 email
  const email = await getUserEmail(userId);
  if (email) return email;
  
  // 3. 回退：显示 ID 前8位
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
      balance: 0,
      must_change_password: true
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
//  强制修改密码
// ============================================================

async function checkMustChangePassword(userId) {
  const { data, error } = await supabase
    .from('member_profiles')
    .select('must_change_password')
    .eq('user_id', userId)
    .single();
  if (error) return false;
  return data?.must_change_password || false;
}

async function setMustChangePassword(userId, value) {
  const { error } = await supabase
    .from('member_profiles')
    .update({ must_change_password: value })
    .eq('user_id', userId);
  if (error) {
    console.error('设置强制修改密码失败:', error);
    return { error };
  }
  return { success: true };
}

async function resetPasswordToDefault(userId) {
  const { data: user, error: userError } = await supabase
    .from('auth.users')
    .select('email')
    .eq('id', userId)
    .single();

  if (userError) {
    return { error: { message: '用户不存在' } };
  }

  const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
    password: '123456'
  });

  if (updateError) {
    console.error('重置密码失败:', updateError);
    return { error: updateError };
  }

  await setMustChangePassword(userId, true);

  return { success: true };
}

async function changeMemberPassword(userId, oldPassword, newPassword) {
  const { data: user, error: userError } = await supabase
    .from('auth.users')
    .select('email')
    .eq('id', userId)
    .single();

  if (userError) {
    return { error: { message: '用户不存在' } };
  }

  const { error: signError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: oldPassword
  });

  if (signError) {
    return { error: { message: '原密码错误' } };
  }

  const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
    password: newPassword
  });

  if (updateError) {
    return { error: updateError };
  }

  await setMustChangePassword(userId, false);

  return { success: true };
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
  checkMustChangePassword,
  setMustChangePassword,
  resetPasswordToDefault,
  changeMemberPassword,
  getMemberTransactions,
  getAllTransactions,
  createRecharge,
  createConsume,
  getUserIdByProfileId
};