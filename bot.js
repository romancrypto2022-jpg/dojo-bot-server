// ═══════════════════════════════════════════════
// DOJO Leadership OS — Bot Server
// Хостинг: Railway.app (бесплатно)
// Функции:
//   1. Отвечает на /start REF_CODE
//   2. Генерирует токен для авто-входа на сайт
//   3. Отправляет ежедневные уведомления (cron)
// ═══════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');
const cron        = require('node-cron');
const express     = require('express');
const crypto      = require('crypto');

// ── НАСТРОЙКИ ──────────────────────────────────
const BOT_TOKEN        = process.env.BOT_TOKEN;
const FIREBASE_PROJECT = 'dojo-leadership';
const DOJO_URL         = 'https://romansmolkov.com/dojo/app';

// ── FIREBASE REST ───────────────────────────────
async function fsGet(path) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`);
  return r.ok ? await r.json() : null;
}

async function fsSet(path, fields) {
  const body = { fields: {} };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'number') body.fields[k] = { integerValue: v };
    else body.fields[k] = { stringValue: String(v ?? '') };
  }
  await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
}

async function fsDelete(path) {
  await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`,
    { method: 'DELETE' }
  );
}

async function getAllUsers() {
  const data = await fsGet('users');
  if (!data?.documents) return [];
  return data.documents.map(doc => {
    const f = doc.fields || {};
    return {
      uid:      f.uid?.stringValue,
      name:     f.name?.stringValue || 'Партнёр',
      chatId:   f.chatId?.stringValue,
      streak:   parseInt(f.currentStreak?.integerValue || 0),
      lastDate: f.lastActiveDate?.stringValue || '',
      invitedBy: f.invitedBy?.stringValue || null,
      goal: {
        income:   f.goal?.mapValue?.fields?.income?.stringValue   || null,
        maingoal: f.goal?.mapValue?.fields?.maingoal?.stringValue || null,
        dream:    f.goal?.mapValue?.fields?.dream?.stringValue    || null,
        forwhom:  f.goal?.mapValue?.fields?.forwhom?.stringValue  || null,
        reason:   f.goal?.mapValue?.fields?.reason?.stringValue   || null,
      }
    };
  }).filter(u => u.chatId);
}

// ── КОНТЕНТ ─────────────────────────────────────
const THOUGHTS = [
  "Каждый день без действий работает против твоей цели.",
  "Среди твоих контактов уже есть будущий лидер твоей команды.",
  "Твоя жизнь через год определяется тем, что ты делаешь сегодня.",
  "Дисциплина — это форма уважения к своим целям.",
  "Маленькое действие каждый день сильнее одного большого усилия раз в месяц.",
  "Рост — это не событие. Это ежедневная практика.",
  "Первый шаг не должен быть идеальным. Он должен быть сделан.",
  "Настоящий лидер не ждёт мотивации. Он создаёт её действием.",
  "Страх — это компас. Он показывает где находится твой рост.",
  "Лидерство — это решение которое принимается каждый день.",
  "Команда отражает лидера. Хочешь другую — стань другим лидером.",
  "Приглашение — это не продажа. Это подарок возможности.",
  "Самая дорогая цена — это сожаление о несделанном.",
  "Стабильность побеждает интенсивность.",
  "Твой следующий лидер уже в твоём телефоне. Просто напиши.",
  "Результаты — это сумма ежедневных решений.",
  "Свобода строится не за один день. Но строится если делать каждый день.",
  "Доход определяется ценностью которую ты создаёшь для других.",
  "Люди которые изменили мир тоже когда-то не знали с чего начать.",
  "Возможности не исчезают. Их забирают те кто действует."
];

const QUESTIONS = [
  "Что ты сделаешь сегодня для своей цели?",
  "Что тебя сейчас тормозит — и что ты можешь с этим сделать?",
  "Если бы успех был гарантирован — сколько людей ты бы пригласил сегодня?",
  "Кто из твоих знакомых сейчас ищет перемен?",
  "Какое одно действие сегодня даст максимальный результат?",
  "Ты строишь команду или ждёшь когда появятся нужные люди?",
  "Что ты сделал вчера что приблизило тебя к цели?",
  "Как ты можешь помочь кому-то в своей команде сегодня?",
  "Что изменится когда ты закроешь следующий ранг?",
  "Какой навык ты развиваешь прямо сейчас?"
];

function getDayIndex() {
  return Math.floor(Date.now() / 86400000) % THOUGHTS.length;
}

function getDaysAbsent(lastDate) {
  if (!lastDate) return 999;
  return Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000);
}

// ── BOT ─────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// /start REF_CODE — основная команда регистрации
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId    = String(msg.chat.id);
  const uid       = String(msg.from.id);
  const firstName = msg.from.first_name || 'Партнёр';
  const lastName  = msg.from.last_name  || '';
  const username  = msg.from.username   || '';
  const refCode   = (match[1] || '').trim();

  // Генерируем одноразовый токен
  const token = crypto.randomBytes(20).toString('hex');
  const expires = Date.now() + 10 * 60 * 1000; // 10 минут

  // Сохраняем токен в Firestore
  await fsSet(`loginTokens/${token}`, {
    uid, chatId,
    name: (firstName + (lastName ? ' ' + lastName : '')).trim(),
    username,
    refCode,
    expires: String(expires)
  });

  // Ссылка для авто-входа
  const loginUrl = `${DOJO_URL}?token=${token}${refCode ? '&ref=' + refCode : ''}`;

  await bot.sendMessage(chatId,
    `👋 *Привет, ${firstName}!*\n\n` +
    `Нажми кнопку ниже чтобы войти в DOJO.\n` +
    `Это займёт 3 минуты — и система начнёт работать на тебя.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🚀 Войти в DOJO', url: loginUrl }]]
      }
    }
  );
});

// ── ОТПРАВИТЬ СООБЩЕНИЕ ──────────────────────────
async function sendMsg(chatId, text, btnText = '✓ Открыть DOJO') {
  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: btnText, url: DOJO_URL }]] }
    });
    await new Promise(r => setTimeout(r, 150));
    return true;
  } catch(e) {
    console.error(`Send error ${chatId}:`, e.message);
    return false;
  }
}

// ── CRON: 9:00 МСК (кроме среды) ────────────────
cron.schedule('0 6 * * 0,1,2,4,5,6', async () => {
  console.log('[CRON] Morning...');
  const users  = await getAllUsers();
  const idx    = getDayIndex();
  let sent = 0;
  for (const u of users) {
    const name = u.name.split(' ')[0];
    const streak = u.streak > 1 ? `\n🔥 Серия: *${u.streak} дней* — держи ритм!\n` : '';
    const text =
      `☀️ *Доброе утро, ${name}!*\n\n` +
      `💡 *Мысль дня:*\n_${THOUGHTS[idx]}_\n\n` +
      `❓ *Вопрос на сегодня:*\n${QUESTIONS[idx % QUESTIONS.length]}${streak}`;
    // Утром — только вдохновение, без ссылки на чеклист
    try {
      await bot.sendMessage(u.chatId, text, { parse_mode: 'Markdown' });
      await new Promise(r => setTimeout(r, 150));
      sent++;
    } catch(e) { console.error(`Morning error ${u.chatId}:`, e.message); }
  }
  console.log(`[CRON] Morning: ${sent}/${users.length}`);
}, { timezone: 'UTC' });

// ── CRON: 9:00 МСК среда — цели ─────────────────
cron.schedule('0 6 * * 3', async () => {
  console.log('[CRON] Wednesday goals...');
  const users = await getAllUsers();
  let sent = 0;
  for (const u of users) {
    const g = u.goal || {};
    if (!g.maingoal && !g.dream) continue;
    const name = u.name.split(' ')[0];
    let goalLines = '';
    if (g.income)   goalLines += `💰 *Цель по доходу:* ${g.income}\n`;
    if (g.maingoal) goalLines += `🎯 *Главная цель:* ${g.maingoal}\n`;
    if (g.dream)    goalLines += `✨ *Мечта:* ${g.dream}\n`;
    if (g.forwhom)  goalLines += `❤️ *Для кого:* ${g.forwhom}\n`;
    const text =
      `🔄 *${name}, помни зачем ты здесь*\n\n` +
      `Ты написал это сам — в первый день:\n\n` +
      goalLines + `\nКаждое действие сегодня приближает тебя к этому 👇`;
    if (await sendMsg(u.chatId, text, '✓ Открыть DOJO')) sent++;
  }
  console.log(`[CRON] Goals: ${sent}/${users.length}`);
}, { timezone: 'UTC' });

// ── CRON: 20:00 МСК — умные уведомления ─────────
cron.schedule('0 17 * * *', async () => {
  console.log('[CRON] Evening...');
  const users = await getAllUsers();
  let sent = 0;
  for (const u of users) {
    const name   = u.name.split(' ')[0];
    const absent = getDaysAbsent(u.lastDate);
    let text = null;

    if (absent === 0) {
      // Активен сегодня — напоминаем заполнить чеклист
      text = `📋 *${name}, как прошёл день?*\n\nЗайди и отметь что сделал сегодня — займёт 2 минуты.\nСерия продолжается 👇`;
    }
    else if (absent === 1) text = `🎯 *${name}, ещё не поздно*\n\nОтметь хотя бы одно действие — и день засчитан.\n2 минуты. Серия продолжается 👇`;
    else if (absent <= 3)  text = `⚡ *${name}, ты пропал на ${absent} дня*\n\nЧто произошло? Серия прервалась, но Momentum ещё можно восстановить 👇`;
    else if (absent <= 6)  text = `🔴 *${name}, уже ${absent} дней без DOJO*\n\nПотерял фокус? Это бывает.\nОдин шаг — и ты снова в системе 👇`;
    else if (absent === 7) {
      text = `❗ *${name}, прошла целая неделя*\n\n7 дней — это уже не пауза. Это выбор.\nВернись прямо сейчас 👇`;
      // Уведомить лидера
      if (u.invitedBy) {
        const leader = (await getAllUsers()).find(l => l.uid === u.invitedBy);
        if (leader?.chatId) await sendMsg(leader.chatId, `⚠️ *Партнёр пропал*\n\n👤 *${u.name}* не заходил в DOJO уже *7 дней*.\nВозможно стоит написать лично.`, '📊 Кабинет лидера');
      }
    }
    else if (absent <= 13) text = `😶 *${name}, тебя нет уже ${absent} дней*\n\nВсё в порядке? Мы здесь 👇`;
    else if (absent === 14) {
      text = `🤝 *${name}, 2 недели*\n\nНужна помощь? Напиши своему лидеру.\nИли просто открой DOJO — иногда достаточно одного шага 👇`;
      if (u.invitedBy) {
        const leader = (await getAllUsers()).find(l => l.uid === u.invitedBy);
        if (leader?.chatId) await sendMsg(leader.chatId, `⚠️ *${u.name}* не заходил уже *14 дней*.\nНужна твоя помощь.`, '📊 Кабинет лидера');
      }
    }
    else {
      if (new Date().getDay() !== 1) continue;
      text = `👋 *${name}*\n\nDOJO всё ещё здесь. Возвращайся 👇`;
    }

    if (text && await sendMsg(u.chatId, text, '✓ Заполнить чеклист')) sent++;
  }
  console.log(`[CRON] Evening: ${sent}/${users.length}`);
}, { timezone: 'UTC' });

// ── CRON: 17:00 МСК воскресенье — аудит ─────────
cron.schedule('0 14 * * 0', async () => {
  console.log('[CRON] Sunday audit...');
  const users = await getAllUsers();
  let sent = 0;
  for (const u of users) {
    const name = u.name.split(' ')[0];
    const text =
      `📋 *${name}, время подвести итоги недели!*\n\n` +
      `6 вопросов · 3 минуты · раз в неделю.\n\n` +
      `Аудит помогает видеть рост и не повторять ошибки 👇`;
    if (await sendMsg(u.chatId, text, '📋 Пройти аудит')) sent++;
  }
  console.log(`[CRON] Audit: ${sent}/${users.length}`);
}, { timezone: 'UTC' });

// ── EXPRESS (keep alive) ─────────────────────────
const app = express();
app.get('/', (req, res) => res.send('🥋 DOJO Bot · ' + new Date().toISOString()));
app.listen(process.env.PORT || 3000, () => console.log('🥋 DOJO Bot started'));
