/*
 * Discord Çoklu Hesap + Selfbot Kontrol Botu
 * Eğitim amaçlıdır. Selfbot (user token) kullanımı Discord ToS’a aykırıdır.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { Client as SelfClient } from 'discord.js-selfbot-v13';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==== Config ====
const CONTROL_BOT_TOKEN = process.env.CONTROL_BOT_TOKEN?.trim();
const ALLOWED_IDS = (process.env.CONTROL_ALLOWED_USER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.json');
const PREFIXES = ['!', '/'];

if (!CONTROL_BOT_TOKEN) {
  console.error('HATA: CONTROL_BOT_TOKEN .env dosyasında tanımlı değil.');
  process.exit(1);
}

// ==== Basit JSON DB ====
function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const init = { tokens: [], tasks: [], searches: [] };
      fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
      return init;
    }
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    const data = JSON.parse(raw);

    if (!data.tokens) data.tokens = [];
    if (!data.tasks) data.tasks = [];
    if (!data.searches) data.searches = [];

    return data;
  } catch (e) {
    console.error('DB okuma hatası:', e);
    return { tokens: [], tasks: [], searches: [] };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let DB = loadDB();

// ==== Worker (Hesap) Bot Yöneticisi ====
class WorkerManager {
  constructor() {
    this.clients = new Map();
  }

  async ensureClient(token) {
    if (this.clients.has(token)) return this.clients.get(token);

    let client;
    if (token.split('.').length === 3) {
      client = new SelfClient(); // selfbot
    } else {
      client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
        partials: [Partials.Channel],
      });
    }

    client.on('ready', () => {
      client.startTime = Date.now();
      console.log(`[WORKER READY] ${client.user?.tag}`);

      // DB'deki token için userId güncelle
      const idx = DB.tokens.findIndex(t => t.token === token);
      if (idx !== -1) {
        DB.tokens[idx].userId = client.user?.id;
        saveDB(DB);
      }
    });

    const seenMessages = new Set();

    client.on('messageCreate', async (message) => {
      if (!DB.searches || DB.searches.length === 0) return;
      if (message.createdTimestamp < (client.startTime || 0)) return;
      if (message.author.id === client.user?.id) return; // kendi mesajı
      if (message.author.bot) return; // bot mesajı
      if (seenMessages.has(message.id)) return;
      seenMessages.add(message.id);

      // Eğer mesajı atan başka bir worker ise atla
      if (DB.tokens.some(t => t.userId === message.author.id)) return;

      for (const search of DB.searches) {
        if (message.content.includes(search.word)) {
          // Worker notify atmaz, kontrol botuna rapor eder
          control.emit("arananBulundu", {
            search,
            message: {
              id: message.id,
              content: message.content,
              author: { id: message.author.id, tag: message.author.tag },
              channelId: message.channel.id
            }
          });
          break;
        }
      }
    });

    try {
      await client.login(token);
      this.clients.set(token, client);
      return client;
    } catch (err) {
      console.error('Worker bot login hatası:', err.message);
      return null;
    }
  }

  getActiveTokens() {
    return DB.tokens.map(t => t.token);
  }

  removeClient(token) {
    const c = this.clients.get(token);
    if (c) {
      c.destroy();
      this.clients.delete(token);
    }
  }
}

const workers = new WorkerManager();

// ==== Görev Zamanlayıcı ====
const RUNNING = new Map();

async function startTask(task) {
  if (RUNNING.has(task.id)) return;

  const available = workers.getActiveTokens();
  if (available.length === 0) return;

  const selected = available.slice(0, Math.max(1, Math.min(task.accountCount, available.length)));
  if (selected.length === 0) return;

  let idx = 0;

  const handle = setInterval(async () => {
    try {
      const token = selected[idx % selected.length];
      idx++;
      const client = await workers.ensureClient(token);
      if (!client) return;

      const channel = await client.channels.fetch(task.channelId);
      if (!channel) return;

      try {
        await channel.send(task.message);
      } catch (e) {
        console.error(`[TASK ${task.id}] Mesaj gönderilemedi:`, e.message);
      }
    } catch (err) {
      console.error(`[TASK ${task.id}] gönderim hatası:`, err.message);
    }
  }, Math.max(5000, task.intervalSec * 1000));

  RUNNING.set(task.id, handle);
  console.log(`[TASK STARTED] ${task.id} -> #${task.channelId}`);
}

function stopTask(taskId) {
  const h = RUNNING.get(taskId);
  if (h) {
    clearInterval(h);
    RUNNING.delete(taskId);
  }
}

function reloadAllTasks() {
  for (const [id, h] of RUNNING) {
    clearInterval(h);
    RUNNING.delete(id);
  }
  for (const t of DB.tasks) {
    startTask(t);
  }
}

// ==== Kontrol Botu ====
const control = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

control.once(Events.ClientReady, () => {
  console.log(`[CONTROL READY] ${control.user.tag}`);
  reloadAllTasks();
});

// Worker’dan gelen aranan mesaj raporunu dinle
control.on("arananBulundu", async ({ search, message }) => {
  try {
    const notifyCh = await control.channels.fetch(search.notifyChannel);
    if (notifyCh) {
      await notifyCh.send(
        `@everyone Aranan bulundu: **${search.word}**\n` +
        `Gönderen: ${message.author.tag} (<@${message.author.id}>)\n` +
        `Kanal: <#${message.channelId}>\n\n` +
        `**Mesaj:**\n${message.content}`
      );
    }
  } catch (e) {
    console.error('Aranan bildirim hatası:', e.message);
  }
});

function isAllowed(userId) {
  return ALLOWED_IDS.length === 0 || ALLOWED_IDS.includes(String(userId));
}

function parseCommand(msgContent) {
  const prefix = PREFIXES.find((p) => msgContent.startsWith(p));
  if (!prefix) return null;
  const raw = msgContent.slice(prefix.length).trim();
  const [cmd, ...rest] = raw.split(/\s+/);
  return { cmd: cmd?.toLowerCase(), args: rest, full: raw };
}

function reply(msg, text) {
  return msg.reply({ content: String(text).slice(0, 1900) });
}

// ==== Kontrol Komutları ====
control.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;
    const parsed = parseCommand(msg.content);
    if (!parsed) return;

    if (!isAllowed(msg.author.id)) {
      return reply(msg, 'Bu komutları kullanma yetkin yok.');
    }

    const { cmd, args } = parsed;

    if (cmd === 'yardim' || cmd === 'help') {
      return reply(msg,
        '**Komutlar**\n' +
        '!token-ekle <isim> <token>\n' +
        '!token-sil <index|isim|tokenParcasi>\n' +
        '!token-liste\n' +
        '!kanal-ekle <kanalId> <sureSn> <hesapSayisi> <mesaj...>\n' +
        '!kanal-sil <gorevId>\n' +
        '!gorev-liste\n' +
        '!aranan <kelime...> <kanalId>\n' +
        '!aranan-liste\n' +
        '!aranan-sil <index>');
    }

    // --- token ekleme ---
    if (cmd === 'token-ekle') {
      if (args.length < 2) return reply(msg, 'Kullanım: !token-ekle <isim> <token>');
      const name = args[0];
      const token = args[1];
      if (DB.tokens.find(t => t.token === token)) return reply(msg, 'Bu token zaten kayıtlı.');
      DB.tokens.push({ name, token });
      saveDB(DB);
      await workers.ensureClient(token);
      reloadAllTasks();
      return reply(msg, `Token eklendi: ${name}. Toplam: ${DB.tokens.length}`);
    }

    if (cmd === 'token-sil') {
      if (args.length === 0) return reply(msg, 'Kullanım: !token-sil <index|isim|tokenParcasi>');
      const q = args[0];
      let removed = null;
      if (/^\d+$/.test(q)) {
        const i = parseInt(q, 10);
        if (i >= 0 && i < DB.tokens.length) {
          removed = DB.tokens.splice(i, 1)[0];
        }
      } else {
        const i = DB.tokens.findIndex(t => t.name === q || t.token.includes(q));
        if (i !== -1) removed = DB.tokens.splice(i, 1)[0];
      }
      if (!removed) return reply(msg, 'Eşleşen token bulunamadı.');
      workers.removeClient(removed.token);
      saveDB(DB);
      reloadAllTasks();
      return reply(msg, `Token silindi: ${removed.name}`);
    }

    if (cmd === 'token-liste') {
      if (DB.tokens.length === 0) return reply(msg, 'Kayıtlı token yok.');
      const list = DB.tokens.map((t, i) => `${i}: ${t.name} | ${t.token.slice(0, 10)}...${t.token.slice(-6)} | userId: ${t.userId || "?"}`);
      return reply(msg, 'Tokenler:\n' + list.join('\n'));
    }

    // --- kanal ekle ---
    if (cmd === 'kanal-ekle') {
      if (args.length < 4) {
        return reply(msg, 'Kullanım: !kanal-ekle <kanalId> <sureSn> <hesapSayisi> <mesaj...>');
      }
      const channelId = args[0];
      const intervalSec = Math.max(5, parseInt(args[1], 10) || 0);
      const accountCount = Math.max(1, parseInt(args[2], 10) || 1);

      let message = args.slice(3).join(' ');
      message = message.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');

      const task = { id: uuidv4(), channelId, intervalSec, accountCount, message };
      DB.tasks.push(task);
      saveDB(DB);
      await startTask(task);
      return reply(msg, `Görev oluşturuldu: ${task.id}`);
    }

    if (cmd === 'kanal-sil') {
      const id = args[0];
      if (!id) return reply(msg, 'Kullanım: !kanal-sil <gorevId>');
      const idx = DB.tasks.findIndex(t => t.id === id);
      if (idx === -1) return reply(msg, 'Görev bulunamadı.');
      stopTask(id);
      DB.tasks.splice(idx, 1);
      saveDB(DB);
      return reply(msg, 'Görev silindi.');
    }

    if (cmd === 'gorev-liste') {
      if (DB.tasks.length === 0) return reply(msg, 'Görev yok.');
      const rows = DB.tasks.map(t =>
        `• ${t.id} | kanal: ${t.channelId} | ${t.intervalSec}s | hesap:${t.accountCount} | mesaj:"${t.message.slice(0,40)}${t.message.length>40?'...':''}"`
      );
      return reply(msg, rows.join('\n'));
    }

    // --- aranan komutları ---
    if (cmd === 'aranan') {
      if (args.length < 2) return reply(msg, 'Kullanım: !aranan <kelime...> <kanalId>');
      const notifyChannel = args[args.length - 1];
      const word = args.slice(0, -1).join(' ');
      DB.searches.push({ word, notifyChannel });
      saveDB(DB);
      return reply(msg, `Aranan eklendi: "${word}" → <#${notifyChannel}>`);
    }

    if (cmd === 'aranan-liste') {
      if (!DB.searches || DB.searches.length === 0) return reply(msg, 'Hiç aranan yok.');
      const list = DB.searches.map((s, i) => `${i}: "${s.word}" → <#${s.notifyChannel}>`);
      return reply(msg, 'Arananlar:\n' + list.join('\n'));
    }

    if (cmd === 'aranan-sil') {
      if (args.length === 0) return reply(msg, 'Kullanım: !aranan-sil <index>');
      const idx = parseInt(args[0], 10);
      if (isNaN(idx) || idx < 0 || idx >= DB.searches.length) return reply(msg, 'Geçersiz index.');
      const removed = DB.searches.splice(idx, 1)[0];
      saveDB(DB);
      return reply(msg, `Aranan silindi: "${removed.word}"`);
    }

  } catch (e) {
    console.error('Komut işleme hatası:', e);
  }
});

// ==== Botu Başlat ====
control.login(CONTROL_BOT_TOKEN).catch((err) => {
  console.error('Kontrol botu login hatası:', err);
  process.exit(1);
});
