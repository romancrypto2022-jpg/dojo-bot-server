// ═══════════════════════════════════════════════
// DOJO Leadership OS — Bot Server
// Хостинг: Railway.app
// Функции:
//   1. /start REF_CODE → токен для авто-входа
//   2. Ежедневные уведомления (cron)
//   3. /notify — принимает POST от браузера
// ═══════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');
const cron        = require('node-cron');
const express     = require('express');
const crypto      = require('crypto');

const BOT_TOKEN        = process.env.BOT_TOKEN;
const NOTIFY_SECRET    = process.env.NOTIFY_SECRET;
const FIREBASE_PROJECT = 'dojo-leadership';
const DOJO_URL         = 'https://romansmolkov.com/dojo/app';

// ── FIREBASE REST ────────────────────────────────
async function fsGet(path) {
  try {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}`);
    return r.ok ? await r.json() : null;
  } catch(e) { console.error('fsGet error:', e.message); return null; }
}

async function fsSet(path, fields) {
  const body = { fields: {} };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'number') body.fields[k] = { integerValue: v };
    else if (typeof v === 'boolean') body.fields[k] = { booleanValue: v };
    else body.fields[k] = { stringValue: String(v ?? '') };
  }
  // updateMask обязателен для частичного обновления — без него Firestore REST API
  // заменяет ВЕСЬ документ только переданными полями, стирая всё остальное.
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  try {
    await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/${path}?${mask}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
  } catch(e) { console.error('fsSet error:', e.message); }
}

async function getAllUsers() {
  const data = await fsGet('users');
  if (!data?.documents) return [];
  return data.documents.map(doc => {
    const f = doc.fields || {};
    const gf = f.goal?.mapValue?.fields || {};
    return {
      uid:       f.uid?.stringValue,
      name:      f.name?.stringValue || 'Партнёр',
      chatId:    f.chatId?.stringValue,
      streak:    parseInt(f.currentStreak?.integerValue || 0),
      lastDate:  f.lastActiveDate?.stringValue || '',
      invitedBy: f.invitedBy?.stringValue || null,
      botBlocked:   f.botBlocked?.booleanValue || false,
      botBlockedAt: f.botBlockedAt?.stringValue || null,
      goal: {
        income:   gf.income?.stringValue   || null,
        maingoal: gf.maingoal?.stringValue || null,
        dream:    gf.dream?.stringValue    || null,
        forwhom:  gf.forwhom?.stringValue  || null,
        reason:   gf.reason?.stringValue   || null,
      }
    };
  }).filter(u => u.chatId);
}

// ── Недельная статистика презентаций/подключений (для сверки "7 касаний") ──
function getMondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d;
}
async function getWeeklyPresentAndLaunched(uid) {
  const monday = getMondayOf(new Date());
  let totalPresent = 0, totalLaunched = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const doc = await fsGet(`dailyLogs/${uid}_${dateStr}`);
    if (!doc?.fields) continue;
    const actions = doc.fields.actions?.mapValue?.fields || {};
    const qty     = doc.fields.qty?.mapValue?.fields || {};
    if (actions.present?.booleanValue)  totalPresent  += parseInt(qty.present?.integerValue  || 1);
    if (actions.launched?.booleanValue) totalLaunched += parseInt(qty.launched?.integerValue || 1);
  }
  return { totalPresent, totalLaunched };
}

// ── ОТСЛЕЖИВАНИЕ ЗАБЛОКИРОВАВШИХ / УДАЛИВШИХ АККАУНТ ──
// Telegram при отправке возвращает конкретную ошибку в этих случаях — ловим её и
// сохраняем факт в Firestore, чтобы это было видно прямо в базе, а не терялось в логах Railway.
function isBlockedError(e) {
  const msg = (e?.response?.body?.description || e?.message || '').toLowerCase();
  return msg.includes('bot was blocked') ||
         msg.includes('user is deactivated') ||
         msg.includes('chat not found') ||
         msg.includes('user not found');
}

async function markBotStatus(uid, blocked) {
  if (!uid) return;
  try {
    await fsSet(`users/${uid}`, {
      botBlocked: blocked,
      botBlockedAt: blocked ? new Date().toISOString() : ''
    });
  } catch(e) { console.error('markBotStatus error:', e.message); }
}

// ── КОНТЕНТ ──────────────────────────────────────
const THOUGHTS = [
  "Каждый день без действий работает против твоей цели.",
  "Первый шаг не должен быть идеальным. Он должен быть сделан.",
  "Маленькое действие каждый день сильнее одного большого усилия раз в месяц.",
  "Действие создаёт ясность. Ожидание — сомнения.",
  "Ты не найдёшь идеальный момент. Ты его создашь.",
  "Промедление — это тоже решение. Просто плохое.",
  "Сделай сегодня то, за что завтра скажешь себе спасибо.",
  "Разница между теми кто хочет и теми кто имеет — в ежедневных действиях.",
  "Не жди вдохновения. Начни — и оно придёт.",
  "Один звонок. Одно сообщение. Один шаг. Каждый день.",
  "Настоящий лидер не ждёт мотивации. Он создаёт её действием.",
  "Лидерство — это не должность. Это решение, которое принимается каждый день.",
  "Команда отражает лидера. Хочешь другую команду — стань другим лидером.",
  "Лидер не тот кто идёт впереди. А тот за кем идут добровольно.",
  "Твой уровень дохода определяется твоим уровнем лидерства.",
  "Лидер решает проблемы. Остальные их обсуждают.",
  "Люди приходят ради продукта. Остаются ради лидера.",
  "Лучшее что ты можешь сделать для команды — расти сам.",
  "Настоящий лидер делает других лучше просто своим присутствием.",
  "Авторитет не дают. Его зарабатывают каждый день.",
  "Среди твоих контактов уже есть будущий лидер твоей команды.",
  "Твой следующий лидер уже в твоём телефоне. Ты просто ещё не написал.",
  "Приглашение — это не продажа. Это подарок возможности.",
  "Каждый кому ты не написал — это чья-то команда.",
  "Людей не нужно убеждать хотеть лучшей жизни. Им нужно показать путь.",
  "Не ищи идеальных людей. Ищи тех кто готов расти.",
  "Один человек из десяти скажет да. Напиши десяти.",
  "Страх отказа стоит тебе дороже, чем сам отказ.",
  "Ты не навязываешься. Ты предлагаешь то, что изменило твою жизнь.",
  "Лучший рекрутинг — это твой образ жизни.",
  "Рост — это не событие. Это ежедневная практика.",
  "Твоя жизнь через год определяется тем, что ты делаешь сегодня.",
  "Люди которые изменили мир тоже когда-то не знали с чего начать.",
  "Дискомфорт — это GPS роста. Если неудобно — ты на правильном пути.",
  "Читай. Слушай. Общайся с теми кто впереди. Повторяй.",
  "Твой доход вырастет ровно настолько, насколько вырастешь ты.",
  "Навыки которые ты не развиваешь сегодня — потолок которого ты достигнешь завтра.",
  "Каждая ошибка — урок оплаченный авансом.",
  "Самые быстрорастущие люди — те кто учится быстрее всех.",
  "Не сравнивай себя со вчерашним собой. Просто стань лучше.",
  "Дисциплина — это форма уважения к своим целям.",
  "Страх — это компас. Он показывает, где находится твой рост.",
  "Самая дорогая цена — это сожаление о несделанном.",
  "Твои мысли сегодня — это твоя реальность завтра.",
  "Успех — это не везение. Это предсказуемый результат правильных действий.",
  "Стабильность побеждает интенсивность. Всегда.",
  "Жалобы ничего не строят. Действия — строят.",
  "Ограничения живут в голове. Проверь, настоящие ли они.",
  "Не спрашивай почему это происходит с тобой. Спрашивай — для чего.",
  "Уверенность не приходит до действия. Она приходит через действие.",
  "Свобода строится не за один день. Но она строится — если делать каждый день.",
  "Результаты — это сумма ежедневных решений.",
  "Настоящая свобода — это когда место проживания становится выбором, а не необходимостью.",
  "Большинство людей живут от пятницы до пятницы. Ты строишь другое.",
  "Ты не работаешь на бизнес. Ты строишь актив который работает на тебя.",
  "Пассивный доход — это не цель. Это результат активного периода.",
  "Хочешь путешествовать — построй систему которая тебя кормит пока ты в пути.",
  "Свобода выбора появляется только тогда, когда есть финансовая гибкость.",
  "Через 5 лет ты окажешься там, куда ведут тебя сегодняшние решения.",
  "Твоя семья заслуживает лучшего. Это достаточная причина.",
  "Путешествия — это не статья расходов. Это инвестиция в опыт который невозможно отнять.",
  "Люди не покупают туры. Они покупают воспоминания на всю жизнь.",
  "Тот кто умеет зарабатывать в путешествии — никогда не вернётся к офису.",
  "Рынок путешествий растёт быстрее чем кто-либо успевает это использовать.",
  "Люди тратят на впечатления больше, чем на вещи. Это и есть твой рынок.",
  "Одно путешествие меняет человека сильнее, чем год в офисе.",
  "Билеты дорожают. Закрытые клубные цены — нет.",
  "Путешествовать регулярно — это образ жизни который можно построить системно.",
  "Твой продукт — не туры. Это образ жизни который люди уже хотят.",
  "Люди покупают у тех кому доверяют. Доверие строится через последовательность.",
  "Нетворкинг — это не коллекционирование контактов. Это создание ценности для людей.",
  "Один тёплый контакт стоит ста холодных.",
  "Твоя репутация строится каждым словом и каждым действием.",
  "Люди не запомнят что ты говорил. Они запомнят как ты их заставил себя чувствовать.",
  "Помоги человеку — и он расскажет о тебе троим.",
  "Лучшие партнёры приходят через рекомендации, а не через рекламу.",
  "Сначала дай ценность. Потом жди результата.",
  "Доверие — самая дорогая валюта в бизнесе.",
  "Строй отношения до того как они тебе понадобятся.",
  "Твой доход определяется ценностью которую ты создаёшь для других людей.",
  "Деньги идут туда, где есть ценность. Создавай ценность.",
  "Один активный партнёр стоит десяти пассивных.",
  "Система без людей не работает. Люди без системы — выгорают.",
  "Бизнес который зависит только от тебя — не бизнес. Это работа.",
  "Реферальная система — самый дешёвый и самый мощный маркетинг.",
  "Масштаб приходит через дублирование, а не через личные усилия.",
  "Не продавай продукт. Продавай трансформацию.",
  "Твоя структура растёт в глубину, а не в ширину.",
  "Обучи одного человека — и он обучит десятерых.",
  "Система важнее мотивации. Мотивация приходит и уходит. Система остаётся.",
  "DOJO — это не приложение. Это зеркало твоей ежедневной дисциплины.",
  "То что измеряется — то улучшается.",
  "Серия — это не статистика. Это характер в цифрах.",
  "Привычка формируется за 66 дней. Ты уже начал.",
  "Ежедневный чеклист — это не контроль. Это свобода от случайности.",
  "Momentum не строится за один день. Но теряется быстро.",
  "Каждое отмеченное действие — кирпич в фундаменте твоего будущего.",
  "Системный человек обгоняет талантливого. Всегда.",
  "Свобода — это не отсутствие системы. Свобода — это правильная система."
];

const QUESTIONS = [
  "Что ты сделаешь сегодня для своей цели?",
  "Какое одно действие сегодня даст максимальный результат?",
  "Если бы ты мог сделать только одно дело сегодня — что бы это было?",
  "Что приближает тебя к цели прямо сейчас — и делаешь ли ты это?",
  "Как выглядит твоя идеальная жизнь через 3 года? Что ты делаешь сегодня чтобы к ней прийти?",
  "Твои действия сегодня — это инвестиция или откладывание на потом?",
  "Что важнее всего прямо сейчас — и ты этим занимаешься?",
  "Если бы успех был гарантирован — сколько людей ты бы пригласил сегодня?",
  "За что через год ты скажешь себе спасибо?",
  "Что ты откладываешь — и почему именно сегодня стоит это сделать?",
  "Кто из твоих знакомых сейчас ищет перемен?",
  "Ты строишь команду или ждёшь когда появятся нужные люди?",
  "Сколько человек узнали о возможности от тебя на этой неделе?",
  "Кому ты сегодня можешь написать первым?",
  "Что мешает тебе написать тем людям которых ты уже давно держишь в голове?",
  "Есть ли человек в твоём окружении, которому ты ещё не предложил присоединиться?",
  "Как ты можешь помочь кому-то в своей команде сегодня?",
  "Кто из твоей команды давно не давал о себе знать?",
  "Что ты можешь сделать чтобы твоя команда стала активнее?",
  "Кого ты видишь будущим лидером — и что ты делаешь для его роста?",
  "Что ты узнал на этой неделе что можно применить уже сегодня?",
  "Какой навык ты развиваешь прямо сейчас?",
  "Что ты сделал вчера что приблизило тебя к цели?",
  "Чему тебя научила последняя неудача?",
  "Что бы ты сделал по-другому если бы начинал сегодня?",
  "Ты растёшь как лидер или стоишь на месте?",
  "Что ты читаешь или слушаешь прямо сейчас для своего роста?",
  "Есть ли у тебя наставник — и когда ты последний раз с ним говорил?",
  "Что изменится в твоей жизни когда ты закроешь следующий ранг?",
  "Кем ты должен стать чтобы получить то чего хочешь?",
  "Что тебя сейчас тормозит — и что ты можешь с этим сделать?",
  "Это реальное препятствие или история которую ты себе рассказываешь?",
  "Что самое страшное может произойти если ты сделаешь следующий шаг?",
  "Если бы страха не было — что бы ты сделал прямо сейчас?",
  "Что ты контролируешь прямо сейчас — и фокусируешься ли ты на этом?",
  "Какую проблему ты решаешь откладыванием?",
  "Что ты можешь делегировать чтобы освободить время для главного?",
  "Есть ли что-то что ты делаешь из привычки но не из необходимости?",
  "Какой разговор ты откладываешь — и что будет если ты его проведёшь?",
  "Что нужно убрать из твоей жизни чтобы в ней появилось место для роста?",
  "Для кого ты строишь этот бизнес — и помнишь ли ты об этом каждый день?",
  "Что изменится в жизни твоей семьи когда ты достигнешь своей цели?",
  "Ты помнишь почему начал? Это всё ещё твоя причина?",
  "Что будет через 5 лет если ты продолжишь делать то что делаешь сейчас?",
  "Что будет через 5 лет если ты ничего не изменишь?",
  "Что для тебя значит настоящая свобода — и на каком ты пути к ней?",
  "Есть ли что-то важное что ты откладываешь ради срочного?",
  "Твои действия сегодня отражают твои приоритеты?",
  "Что ты хочешь чтобы твои дети видели в тебе?",
  "Если бы ты знал что не провалишься — что бы ты попробовал прямо сейчас?"
];

function getDayIndex() {
  return Math.floor(Date.now() / 86400000) % THOUGHTS.length;
}

function getDaysAbsent(lastDate) {
  if (!lastDate) return 999;
  return Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000);
}

// ── BOT (polling: false — используем только sendMessage) ─
// polling=false чтобы не было 409 конфликта если есть другие экземпляры
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId    = String(msg.chat.id);
  const uid       = String(msg.from.id);
  const firstName = msg.from.first_name || 'Партнёр';
  const lastName  = msg.from.last_name  || '';
  const username  = msg.from.username   || '';
  const refCode   = (match[1] || '').trim();

  markBotStatus(uid, false); // не ждём — не критично, если случайно опоздает на пару секунд

  const token   = crypto.randomBytes(20).toString('hex');
  const expires = Date.now() + 10 * 60 * 1000;

  await fsSet(`loginTokens/${token}`, {
    uid, chatId,
    name: (firstName + (lastName ? ' ' + lastName : '')).trim(),
    username,
    refCode,
    expires: String(expires)
  });

  const loginUrl = `${DOJO_URL}?token=${token}${refCode ? '&ref=' + refCode : ''}`;

  try {
    await bot.sendMessage(chatId,
      `👋 *Привет, ${firstName}!*\n\n` +
      `Нажми кнопку ниже чтобы войти в DOJO.\n` +
      `Это займёт 3 минуты — и система начнёт работать на тебя.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Войти в DOJO', url: loginUrl }],
            [{ text: '💬 Чат клана Самурай', url: 'https://t.me/+SlFxmMLiASI5NmMy' }]
          ]
        }
      }
    );
  } catch(e) { console.error('Start error:', e.message); }
});

// ── ВОССТАНОВЛЕНИЕ РАЗМЕТКИ ──────────────────────
// Когда ссылку/жирный/курсив вставляют через встроенный инструмент форматирования Telegram
// (а не набирают вручную звёздочками/скобками), Telegram отдаёт боту "голый" текст +
// отдельно диапазоны символов с типом форматирования (entities). Без этой функции такие
// ссылки/акценты молча терялись бы при пересылке всем — текст оставался бы плоским.
function entitiesToMarkdown(text, entities) {
  if (!text || !entities || entities.length === 0) return text || '';
  // Вставляем разметку с конца строки к началу — чтобы уже вставленные символы
  // не сдвигали offset'ы ещё не обработанных entity.
  const sorted = [...entities].sort((a, b) => (b.offset - a.offset) || (b.length - a.length));
  let result = text;
  for (const e of sorted) {
    const start = e.offset;
    const end = e.offset + e.length;
    const chunk = result.slice(start, end);
    let wrapped;
    if (e.type === 'text_link' && e.url) wrapped = `[${chunk}](${e.url})`;
    else if (e.type === 'bold') wrapped = `*${chunk}*`;
    else if (e.type === 'italic') wrapped = `_${chunk}_`;
    else if (e.type === 'code') wrapped = `\`${chunk}\``;
    else continue; // обычный "url"-тип Telegram и так сам подсвечивает как ссылку — не трогаем
    result = result.slice(0, start) + wrapped + result.slice(end);
  }
  return result;
}

// ── ДИАГНОСТИКА: проверить что бот жив на новом коде и видит твою роль ──
bot.onText(/^\/whoami/i, async (msg) => {
  const uid = String(msg.from.id);
  const chatId = String(msg.chat.id);
  const check = await checkAdmin(uid);
  await bot.sendMessage(chatId,
    `🔍 *Диагностика*\n\nTelegram ID: \`${uid}\`\nАдмин: ${check.ok ? '✅ да' : '❌ нет'}\n${check.reason ? check.reason : ''}`,
    { parse_mode: 'Markdown' }
  );
});

// Список тех, кто заблокировал бота или удалил аккаунт — статус пишется автоматически
// при каждой неудачной отправке (ежедневные уведомления, рассылки).
bot.onText(/^\/(заблокировали|blocked)/i, async (msg) => {
  const uid = String(msg.from.id);
  const chatId = String(msg.chat.id);
  const check = await checkAdmin(uid);
  if (!check.ok) {
    await bot.sendMessage(chatId, `⛔ ${check.reason}`);
    return;
  }
  const users = await getAllUsers();
  const blocked = users.filter(u => u.botBlocked);
  if (blocked.length === 0) {
    await bot.sendMessage(chatId, '✅ Пока никто не заблокировал бота (по данным, накопленным при рассылках).');
    return;
  }
  const list = blocked.map(u => {
    const since = u.botBlockedAt ? new Date(u.botBlockedAt).toLocaleDateString('ru') : '?';
    return `• ${u.name} — с ${since}`;
  }).join('\n');
  await bot.sendMessage(chatId,
    `🚫 *Заблокировали бота / удалили аккаунт: ${blocked.length}*\n\n${list}\n\n` +
    `_Статус обновляется автоматически при каждой рассылке и ежедневных уведомлениях — новых блокировок пока не видно, если человек не получал сообщений после блокировки._`,
    { parse_mode: 'Markdown' }
  );
});

// ── РАССЫЛКА ВСЕМ УЧАСТНИКАМ ──────────────────────
// /рассылка <текст> — можно отправить как текстом, так и подписью к фото.
// Перед отправкой всем — обязательное подтверждение /подтвердить (защита от опечатки/случайного нажатия).
const BROADCAST_CMD_RE = /^\/(рассылка|broadcast)\s+([\s\S]+)/i;
const pendingBroadcasts = new Map(); // chatId -> { text, photoFileId, expires }
const recentPhotos = new Map(); // chatId -> { fileId, expires } — для случая "фото отдельно, текст отдельно" (подпись >1024 символов)

async function checkAdmin(uid) {
  try {
    const doc = await fsGet(`users/${uid}`);
    if (!doc) return { ok: false, reason: 'Документ пользователя не найден в Firestore (fsGet вернул пусто).' };
    const role = doc?.fields?.role?.stringValue;
    if (role !== 'admin') return { ok: false, reason: `Роль сейчас: "${role || '(пусто)'}" — нужно ровно "admin".` };
    return { ok: true };
  } catch(e) {
    console.error('checkAdmin error:', e.message);
    return { ok: false, reason: `Ошибка при проверке роли: ${e.message}` };
  }
}

const CAPTION_LIMIT = 1000; // с запасом от жёсткого лимита Telegram в 1024 символа

// Единая точка отправки — используется и в реальной рассылке, и в предпросмотре,
// чтобы предпросмотр честно показывал, как объявление реально придёт людям.
async function sendAnnouncement(chatId, text, photoFileId, extraNote = '') {
  const fullText = extraNote ? `${extraNote}\n\n${text}` : text;
  if (photoFileId) {
    if (fullText.length <= CAPTION_LIMIT) {
      await bot.sendPhoto(chatId, photoFileId, { caption: fullText, parse_mode: 'Markdown' });
    } else {
      // Текст не влезает в подпись к фото — фото без подписи, текст отдельным сообщением следом.
      await bot.sendPhoto(chatId, photoFileId);
      await bot.sendMessage(chatId, fullText, { parse_mode: 'Markdown' });
    }
  } else {
    await bot.sendMessage(chatId, fullText, { parse_mode: 'Markdown' });
  }
}

async function broadcastToAll(text, photoFileId) {
  const users = await getAllUsers();
  let sent = 0, failed = 0, blocked = 0;
  for (const u of users) {
    try {
      await sendAnnouncement(u.chatId, text, photoFileId);
      sent++;
      if (u.botBlocked) await markBotStatus(u.uid, false); // раз доставилось — точно не заблокирован
    } catch(e) {
      failed++;
      console.error(`Broadcast error ${u.chatId}:`, e.message);
      if (isBlockedError(e)) { blocked++; await markBotStatus(u.uid, true); }
    }
    await new Promise(r => setTimeout(r, 120)); // не упираемся в лимиты Telegram
  }
  return { sent, failed, blocked, total: users.length };
}

// Текстовая рассылка: /рассылка Текст объявления...
bot.onText(BROADCAST_CMD_RE, async (msg, match) => {
  const uid = String(msg.from.id);
  const chatId = String(msg.chat.id);
  const check = await checkAdmin(uid);
  if (!check.ok) {
    await bot.sendMessage(chatId, `⛔ Рассылка недоступна.\n${check.reason}\n\nТвой Telegram ID: ${uid}`);
    return;
  }

  const mdText = entitiesToMarkdown(msg.text, msg.entities);
  const mdMatch = mdText.match(BROADCAST_CMD_RE);
  const text = (mdMatch ? mdMatch[2] : match[2]).trim();

  // Если недавно (последние 10 минут) присылал фото — прикрепляем автоматически.
  // Так текст остаётся без ограничения в 1024 символа (лимит только у подписи к фото).
  const recent = recentPhotos.get(chatId);
  const photoFileId = (recent && Date.now() < recent.expires) ? recent.fileId : null;
  if (photoFileId) recentPhotos.delete(chatId);

  pendingBroadcasts.set(chatId, { text, photoFileId, expires: Date.now() + 2 * 60 * 1000 });

  const previewNote = photoFileId
    ? '📢 Предпросмотр рассылки (с прикреплённым недавним фото). Так это увидят участники:'
    : '📢 Предпросмотр рассылки. Так это увидят участники:';
  await sendAnnouncement(chatId, text, photoFileId, previewNote);
  await bot.sendMessage(chatId, 'Это уйдёт *всем участникам* DOJO. Отправь /подтвердить в течение 2 минут, чтобы разослать, или /отмена чтобы отменить.', { parse_mode: 'Markdown' });
});

// Рассылка с фото: отправь боту фото, подпись начинается с /рассылка
bot.on('photo', async (msg) => {
  const caption = msg.caption || '';
  const match = caption.match(BROADCAST_CMD_RE);
  const uid = String(msg.from.id);
  const chatId = String(msg.chat.id);

  if (!match) {
    // Диагностика — только для админа и только если похоже, что он пытался разослать
    // (не спамим обычных партнёров, если они просто прислали фото без команды).
    const check = await checkAdmin(uid);
    if (check.ok) {
      const photoFileId = msg.photo[msg.photo.length - 1].file_id;
      recentPhotos.set(chatId, { fileId: photoFileId, expires: Date.now() + 10 * 60 * 1000 });

      if (!msg.caption) {
        await bot.sendMessage(chatId,
          `📸 Фото получил и запомнил на 10 минут.\n\n` +
          `Если хотел прикрепить его к рассылке с длинным текстом — просто пришли теперь /рассылка Текст объявления обычным сообщением (без фото), и я приклею это фото автоматически.\n\n` +
          `Если у фото была подпись длиннее *1024 символов* — Telegram мог её отрезать, поэтому я не увидел команду в подписи.`,
          { parse_mode: 'Markdown' }
        );
      } else if (/рассылка|broadcast/i.test(caption)) {
        await bot.sendMessage(chatId,
          `📸 Фото запомнил. Подпись есть (${caption.length} симв.), но команда в ней не распозналась — подпись должна начинаться ровно с "/рассылка ".\n\n` +
          `Можешь просто прислать /рассылка Текст отдельным сообщением — фото прикреплю автоматически.`,
          { parse_mode: 'Markdown' }
        );
      }
    }
    return;
  }

  const check = await checkAdmin(uid);
  if (!check.ok) {
    await bot.sendMessage(chatId, `⛔ Рассылка недоступна.\n${check.reason}\n\nТвой Telegram ID: ${uid}`);
    return;
  }

  const mdCaption = entitiesToMarkdown(msg.caption, msg.caption_entities);
  const mdMatch = mdCaption.match(BROADCAST_CMD_RE);
  const text = (mdMatch ? mdMatch[2] : match[2]).trim();
  const photoFileId = msg.photo[msg.photo.length - 1].file_id; // самое высокое разрешение
  pendingBroadcasts.set(chatId, { text, photoFileId, expires: Date.now() + 2 * 60 * 1000 });

  await sendAnnouncement(chatId, text, photoFileId, '📢 Предпросмотр рассылки. Так это увидят участники:');
  await bot.sendMessage(chatId, 'Это уйдёт *всем участникам* DOJO. Отправь /подтвердить в течение 2 минут, чтобы разослать, или /отмена чтобы отменить.', { parse_mode: 'Markdown' });
});

bot.onText(/^\/подтвердить/i, async (msg) => {
  const uid = String(msg.from.id);
  const chatId = String(msg.chat.id);
  const check = await checkAdmin(uid);
  if (!check.ok) {
    await bot.sendMessage(chatId, `⛔ ${check.reason}`);
    return;
  }

  const pending = pendingBroadcasts.get(chatId);
  if (!pending || Date.now() > pending.expires) {
    await bot.sendMessage(chatId, '⏱ Нет активной рассылки для подтверждения (или истекли 2 минуты). Отправь /рассылка заново.');
    pendingBroadcasts.delete(chatId);
    return;
  }
  pendingBroadcasts.delete(chatId);

  await bot.sendMessage(chatId, '📤 Рассылаю...');
  const { sent, failed, blocked, total } = await broadcastToAll(pending.text, pending.photoFileId);
  await bot.sendMessage(chatId,
    `✅ *Готово.*\n\nДоставлено: *${sent}* из *${total}*\nОшибок: *${failed}*${blocked ? `\nИз них заблокировали/удалили бота: *${blocked}*` : ''}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/отмена/i, async (msg) => {
  const chatId = String(msg.chat.id);
  if (pendingBroadcasts.has(chatId)) {
    pendingBroadcasts.delete(chatId);
    await bot.sendMessage(chatId, '❌ Рассылка отменена.');
  }
});

// ── ОТПРАВИТЬ СООБЩЕНИЕ ──────────────────────────
async function sendMsg(chatId, text, btnText = '✓ Открыть DOJO', btnUrl = DOJO_URL) {
  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: btnText, url: btnUrl }]]
      }
    });
    await new Promise(r => setTimeout(r, 150));
    return true;
  } catch(e) {
    console.error(`Send error ${chatId}:`, e.message);
    if (isBlockedError(e)) await markBotStatus(chatId, true);
    return false;
  }
}

// ── УВЕДОМИТЬ ЛИДЕРА ─────────────────────────────
async function notifyLeader(users, absentUser, daysAbsent) {
  if (!absentUser.invitedBy) return;
  const leader = users.find(l => l.uid === absentUser.invitedBy);
  if (!leader?.chatId) return;
  await sendMsg(
    leader.chatId,
    `⚠️ *Партнёр пропал*\n\n` +
    `👤 *${absentUser.name}* не заходил в DOJO уже *${daysAbsent} дней*.\n\n` +
    `Возможно стоит написать лично.`,
    '📊 Кабинет лидера'
  );
}

// ── CRON: 8:00 МСК — утро (кроме среды) ─────────
cron.schedule('0 5 * * 0,1,2,4,5,6', async () => {
  console.log('[CRON] Morning...');
  const users = await getAllUsers();
  const idx   = getDayIndex();
  let sent = 0;
  for (const u of users) {
    const name   = u.name.split(' ')[0];
    const streak = u.streak > 1 ? `\n🔥 Серия: *${u.streak} дней* — держи ритм!\n` : '';
    const text =
      `☀️ *Доброе утро, ${name}!*\n\n` +
      `💡 *Мысль дня:*\n_${THOUGHTS[idx]}_\n\n` +
      `❓ *Вопрос на сегодня:*\n${QUESTIONS[idx % QUESTIONS.length]}${streak}`;
    if (await sendMsg(u.chatId, text)) sent++;
  }
  console.log(`[CRON] Morning: ${sent}/${users.length}`);
}, { timezone: 'UTC' });

// ── CRON: 8:00 МСК среда — цели ─────────────────
cron.schedule('0 5 * * 3', async () => {
  console.log('[CRON] Wednesday goals...');
  const users = await getAllUsers();
  let sent = 0;
  for (const u of users) {
    const name = u.name.split(' ')[0];
    const g = u.goal || {};

    // Цели не заполнены — напоминаем заполнить
    if (!g.maingoal && !g.dream) {
      await sendMsg(
        u.chatId,
        `📝 *${name}, ты ещё не записал свои цели*\n\n` +
        `Каждую среду партнёры получают напоминание о своих целях и мечтах.\n\n` +
        `Ты пропускаешь это — потому что цели ещё не заполнены.\n\n` +
        `Зайди в DOJO и запиши — займёт 5 минут.\n` +
        `Это то что будет держать тебя в движении когда захочется остановиться 👇`,
        '✓ Заполнить цели'
      );
      sent++;
      continue;
    }

    // Цели заполнены — напоминаем о них
    let goalLines = '';
    if (g.income)   goalLines += `💰 *Цель по доходу:* ${g.income}\n`;
    if (g.maingoal) goalLines += `🎯 *Главная цель:* ${g.maingoal}\n`;
    if (g.dream)    goalLines += `✨ *Мечта:* ${g.dream}\n`;
    if (g.forwhom)  goalLines += `❤️ *Для кого:* ${g.forwhom}\n`;
    const text =
      `🔄 *${name}, помни зачем ты здесь*\n\n` +
      `Ты написал это сам — в первый день:\n\n` +
      goalLines +
      `\nКаждое действие сегодня приближает тебя к этому 👇`;
    if (await sendMsg(u.chatId, text)) sent++;
  }
  console.log(`[CRON] Goals: ${sent}/${users.length}`);
}, { timezone: 'UTC' });

// ── CRON: 19:00 МСК — умные вечерние уведомления ─
cron.schedule('0 16 * * *', async () => {
  console.log('[CRON] Evening...');
  const users = await getAllUsers();
  let sent = 0;

  for (const u of users) {
    const name   = u.name.split(' ')[0];
    const absent = getDaysAbsent(u.lastDate);
    let text     = null;

    // Milestone уведомления серии
    if (u.streak === 7) {
      await sendMsg(u.chatId,
        `🔥 *${name}, 7 дней подряд!*\n\n` +
        `Ты прошёл первый барьер.\n` +
        `Большинство людей не доходят даже до этого момента.\n\n` +
        `Это уже не случайность — это характер.`
      );
      sent++; continue;
    }
    if (u.streak === 14) {
      await sendMsg(u.chatId,
        `⚡ *${name}, 14 дней без пропусков!*\n\n` +
        `Две недели последовательных действий.\n` +
        `Половина пути к настоящей привычке пройдена.`
      );
      sent++; continue;
    }
    if (u.streak === 21) {
      await sendMsg(u.chatId,
        `🏆 *${name}, 21 день — точка невозврата!*\n\n` +
        `Ты прошёл минимальный порог формирования привычки.\n` +
        `Теперь это часть тебя. Продолжай.`
      );
      sent++; continue;
    }
    if (u.streak === 30) {
      await sendMsg(u.chatId,
        `🥋 *${name}, 30 дней. Это уже образ жизни.*\n\n` +
        `Месяц ежедневной работы над собой.\n` +
        `Ты входишь в 1% людей которые следуют системе каждый день.\n\n` +
        `Твоя команда видит это. Продолжай.`
      );
      // Уведомляем лидера о milestone партнёра
      if (u.invitedBy) {
        const leader = users.find(l => l.uid === u.invitedBy);
        if (leader?.chatId) {
          await sendMsg(leader.chatId,
            `🏆 *Твой партнёр достиг 30 дней!*\n\n` +
            `👤 *${u.name}* закрыл серию в 30 дней в DOJO.\n` +
            `Напиши ему — такие моменты важно отмечать лично.`,
            '📊 Кабинет лидера'
          );
        }
      }
      sent++; continue;
    }

    // Умные уведомления по дням отсутствия
    if (absent === 0) {
      text = `📋 *${name}, как прошёл день?*\n\nЗайди и отметь что сделал сегодня — займёт 2 минуты.\nСерия продолжается 👇`;
    } else if (absent === 1) {
      text = `🎯 *${name}, ещё не поздно*\n\nОтметь хотя бы одно действие — и день засчитан.\n2 минуты. Серия продолжается 👇`;
    } else if (absent <= 3) {
      text = `⚡ *${name}, ты пропал на ${absent} дня*\n\nЧто произошло? Серия прервалась, но Momentum ещё можно восстановить 👇`;
    } else if (absent <= 6) {
      text = `🔴 *${name}, уже ${absent} дней без DOJO*\n\nПотерял фокус? Это бывает.\nОдин шаг — и ты снова в системе 👇`;
    } else if (absent === 7) {
      text = `❗ *${name}, прошла целая неделя*\n\n7 дней — это уже не пауза. Это выбор.\nВернись прямо сейчас 👇`;
      await notifyLeader(users, u, absent);
    } else if (absent <= 13) {
      text = `😶 *${name}, тебя нет уже ${absent} дней*\n\nВсё в порядке? Мы здесь 👇`;
    } else if (absent === 14) {
      text = `🤝 *${name}, 2 недели*\n\nНужна помощь? Напиши своему лидеру.\nИли просто открой DOJO — иногда достаточно одного шага 👇`;
      await notifyLeader(users, u, absent);
    } else {
      // Больше 14 дней — только по понедельникам
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

// ── CRON: 18:00 МСК воскресенье — сверка "7 касаний" для наставников ──
// 10+ презентаций за неделю без подключений — не ошибка, часто это нормальная часть
// пути кандидата (2-5 встреч перед регистрацией). Наставник получает отдельное
// уведомление, независимое от аудита, чтобы предложить сверку на консультации.
const PRESENTATION_GAP_THRESHOLD = 10;
cron.schedule('0 15 * * 0', async () => {
  console.log('[CRON] Weekly 7-touches check...');
  const users = await getAllUsers();
  let sent = 0;
  for (const u of users) {
    if (!u.invitedBy) continue;
    const mentor = users.find(m => m.uid === u.invitedBy);
    if (!mentor?.chatId) continue;

    const { totalPresent, totalLaunched } = await getWeeklyPresentAndLaunched(u.uid);
    if (totalPresent >= PRESENTATION_GAP_THRESHOLD && totalLaunched === 0) {
      const text =
        `📊 *Ситуация по ${u.name}*\n\n` +
        `За эту неделю: *${totalPresent}* презентаций, *0* подключений.\n\n` +
        `Скорее всего, это нормально — по принципу «7 касаний» между презентацией и регистрацией обычно проходит несколько встреч. Но стоит свериться на консультации, чтобы синхронизироваться.`;
      if (await sendMsg(mentor.chatId, text, '📊 Кабинет лидера')) sent++;
    }
  }
  console.log(`[CRON] 7-touches check: ${sent} notifications sent`);
}, { timezone: 'UTC' });

// ── EXPRESS ──────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Keep-alive
app.get('/', (req, res) => res.send('🥋 DOJO Bot · ' + new Date().toISOString()));

// /notify — принимает запросы от браузера
app.post('/notify', async (req, res) => {
  const { secret, chatId, text, buttonText, buttonUrl } = req.body;

  if (!secret || secret !== NOTIFY_SECRET) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  if (!chatId || !text) {
    return res.status(400).json({ ok: false, error: 'Missing chatId or text' });
  }

  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      ...(buttonText && buttonUrl ? {
        reply_markup: { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] }
      } : {})
    });
    console.log(`/notify sent to ${chatId}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('/notify error:', e.message);
    // Retry через 3 секунды
    setTimeout(async () => {
      try {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        console.log(`/notify retry success for ${chatId}`);
      } catch(e2) {
        console.error('/notify retry failed:', e2.message);
      }
    }, 3000);
    res.json({ ok: false, error: e.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('🥋 DOJO Bot started'));
