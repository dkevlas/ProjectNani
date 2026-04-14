const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcode = require("qrcode");
const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
require("dotenv").config();

const app = express();
const api_key = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(api_key);
const wait = 10;

const FRIEND_NUMBER = process.env.FRIEND_NUMBER || "51922912558";
const DEBOUNCE_MS = wait * 1000;

const MODEL_TEXT = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const MODEL_AUDIO_TRANSCRIBE = process.env.GEMINI_TRANSCRIBE_MODEL || MODEL_TEXT;
const AUTH_DIR = process.env.BAILEYS_AUTH_DIR || "/tmp/baileys_auth";
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL;
const KEEP_ALIVE_INTERVAL_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS || 10 * 60 * 1000);

let sock = null;
let qrImageBase64 = null;
let isReady = false;
let botActive = true;
let lastInitError = null;
let initAttempts = 0;
let startingSocket = false;

let pending = { texts: [], audioFiles: [], timer: null };
const TEMP_AUDIO_DIR = process.env.TEMP_AUDIO_DIR || "/tmp/baileys_audio";

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || "silent" });

async function startSocket(trigger) {
  if (startingSocket) return;
  startingSocket = true;
  initAttempts += 1;
  const attempt = initAttempts;
  console.log(`🔄 Inicializando WhatsApp (intento ${attempt}) — trigger: ${trigger}`);

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ["DennisBot", "Chrome", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          qrImageBase64 = await qrcode.toDataURL(qr);
          console.log("QR generado — abre la URL en el navegador para escanearlo");
        } catch (e) {
          console.error("Error generando imagen QR:", e.message);
        }
      }

      if (connection === "open") {
        isReady = true;
        qrImageBase64 = null;
        lastInitError = null;
        initAttempts = 0;
        console.log("✅ WhatsApp conectado y listo");
      }

      if (connection === "close") {
        isReady = false;
        qrImageBase64 = null;
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : undefined;
        const reasonText = `${statusCode ?? ""} ${lastDisconnect?.error?.message ?? ""}`.trim();
        lastInitError = `disconnected: ${reasonText}`;
        console.log("❌ Conexión cerrada:", reasonText);

        startingSocket = false;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (loggedOut) {
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch {}
        }
        scheduleReconnect("close");
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        try {
          await handleIncomingMessage(msg);
        } catch (e) {
          console.error("Error en handleIncomingMessage:", e?.message || e);
        }
      }
    });

    lastInitError = null;
  } catch (e) {
    lastInitError = `startSocket failed: ${String(e?.message || e || "")}`;
    console.error("❌ startSocket falló:", e?.stack || e?.message || e);
    scheduleReconnect("start-error");
  } finally {
    startingSocket = false;
  }
}

function scheduleReconnect(trigger) {
  const delay = Math.min(60_000, Math.max(2_000, initAttempts * 3_000));
  setTimeout(() => startSocket(trigger), delay);
}

async function handleIncomingMessage(msg) {
  if (!msg.message) return;
  if (msg.key.fromMe) return;
  if (!botActive) return;

  const from = msg.key.remoteJid;
  if (!from || from.endsWith("@g.us") || from.endsWith("@broadcast")) return;

  const senderNumber = normalizeJid(from);
  const type = detectMessageType(msg.message);
  const body = extractText(msg.message);

  console.log("MENSAJE ENTRANTE:", from, type, body || "");
  console.log("Número limpio:", senderNumber);
  console.log("FRIEND_NUMBER:", FRIEND_NUMBER);
  // if (senderNumber !== String(FRIEND_NUMBER)) return;

  console.log(`📨 Mensaje recibido — tipo: ${type}`);

  if (type === "text" && body) {
    pending.texts.push(body);
  }

  if (type === "audio") {
    await tryAccumulateAudio(msg);
  }

  resetDebounceTimer(msg);
}

function normalizeJid(jid) {
  return String(jid).replace(/@s\.whatsapp\.net|@c\.us|@lid/g, "").split(":")[0];
}

function detectMessageType(message) {
  if (message.conversation || message.extendedTextMessage) return "text";
  if (message.audioMessage) return "audio";
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  return "other";
}

function extractText(message) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  );
}

async function tryAccumulateAudio(msg) {
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const mimetype = msg.message.audioMessage?.mimetype || "audio/ogg";
    const entry = persistAudioToDisk(buffer, mimetype);
    if (entry) {
      pending.audioFiles.push(entry);
      console.log("🎤 Audio acumulado (disk)");
    } else {
      console.log("🎤 Audio recibido pero se omitió (no se pudo guardar)");
    }
  } catch (e) {
    console.error("Error descargando audio:", e.message);
  }
}

function persistAudioToDisk(buffer, mimetype) {
  try {
    fs.mkdirSync(TEMP_AUDIO_DIR, { recursive: true });
    const ext = guessAudioExtension(mimetype);
    const filePath = path.join(
      TEMP_AUDIO_DIR,
      `audio_${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`,
    );
    fs.writeFileSync(filePath, buffer);
    return { filePath, mimetype };
  } catch (e) {
    console.error("Error guardando audio en disco:", e?.message || e);
    return null;
  }
}

function guessAudioExtension(mimetype) {
  const m = String(mimetype || "").toLowerCase();
  if (m.includes("ogg")) return "ogg";
  if (m.includes("opus")) return "opus";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  return "bin";
}

function resetDebounceTimer(lastMsg) {
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(async () => {
    await processAndReply(lastMsg);
  }, DEBOUNCE_MS);
}

async function processAndReply(lastMsg) {
  const texts = [...pending.texts];
  const audios = [...pending.audioFiles];
  pending = { texts: [], audioFiles: [], timer: null };

  const parts = [];

  for (const audio of audios) {
    try {
      const base64Data = fs.readFileSync(audio.filePath, { encoding: "base64" });
      const transcription = await transcribeAudio(base64Data, audio.mimetype);
      if (transcription) {
        parts.push(`[Audio transcrito]: ${transcription}`);
        console.log(`🎤 Transcripción: ${transcription}`);
      }
    } catch (e) {
      console.error("Error transcribiendo:", e.message);
      parts.push("[Audio recibido — no se pudo transcribir]");
    } finally {
      try {
        fs.unlinkSync(audio.filePath);
      } catch {}
    }
  }

  for (const t of texts) parts.push(t);

  if (parts.length === 0) return;

  const combined = parts.join("\n");
  console.log(`📝 Procesando ${texts.length} texto(s) y ${audios.length} audio(s)`);

  try {
    const reply = await generateReply(combined);
    await sock.sendMessage(lastMsg.key.remoteJid, { text: reply }, { quoted: lastMsg });
    console.log(`✉️  Respondido: ${reply}`);
  } catch (e) {
    console.error("Error generando respuesta:", e.message);
  }
}

async function transcribeAudio(base64Data, mimetype) {
  const model = genAI.getGenerativeModel({ model: MODEL_AUDIO_TRANSCRIBE });

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: mimetype || "audio/ogg",
        data: base64Data,
      },
    },
    "Transcribe exactamente lo que dice este audio en español. Devuelve solo el texto transcrito, sin explicaciones.",
  ]);

  return result.response.text().trim();
}

async function generateReply(combinedMessages) {
  const model = genAI.getGenerativeModel({ model: MODEL_TEXT });

  const prompt = `Eres Dennis, redacta una respuesta de WhatsApp que suene completamente humana y natural, como si fuera escrita rápidamente por una persona real. La única persona que te va a escribir se llama Suemi.

Instrucciones:
- Tono neutral, algo distante, pero educado
- Que no suene robótico ni formal
- No uses frases típicas de IA (como "entiendo cómo te sientes")
- No hagas preguntas ni invites a seguir conversando
- No muestres demasiado interés ni emoción
- Puede tener ligeras imperfecciones humanas (frases simples, directas)
- Máximo 1-2 líneas
- Primera persona
- Idioma: español
- Responde al conjunto de mensajes como uno solo

Pero en el fondo eres amiga de Suemi y quieres ayudarle pero tu personalidad neutral te limita un poco.

Mensajes recibidos:
"${combinedMessages}"

Responde SOLO con el texto del mensaje, sin explicaciones ni comillas.`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

app.get("/", (req, res) => {
  if (!isReady && !qrImageBase64) {
    return res.send(pageHTML("⏳ Iniciando...", "<p>Espera unos segundos y recarga.</p>", false));
  }
  if (!isReady && qrImageBase64) {
    return res.send(pageHTML(
      "Escanea el QR",
      `<p style="color:#888;margin-bottom:24px">WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
       <img src="${qrImageBase64}" style="width:260px;height:260px;border-radius:12px"/>
       <p style="color:#555;font-size:13px;margin-top:16px">Se recarga automáticamente cada 5s</p>
       <script>setTimeout(()=>location.reload(),5000)</script>`,
      false
    ));
  }
  return res.send(pageHTML(
    "✅ Bot activo",
    `<p style="color:#6abf6a;margin-bottom:8px">WhatsApp conectado</p>
     <p style="color:#888;font-size:14px">Respondiendo a: <code style="color:#c9a96e">+${FRIEND_NUMBER}</code></p>
     <p style="color:#555;font-size:13px;margin-top:8px">Modo: texto + audios transcritos · Debounce: 20s</p>
     <div style="margin-top:28px">
       <a href="/pause" style="padding:10px 20px;background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#888;text-decoration:none;font-size:13px">
         ${botActive ? "⏸ Pausar bot" : "▶ Reanudar bot"}
       </a>
     </div>`,
    true
  ));
});

app.get("/pause", (req, res) => {
  botActive = !botActive;
  console.log(`Bot ${botActive ? "reanudado" : "pausado"}`);
  res.redirect("/");
});

app.get("/ping", (req, res) => res.send("pong"));
app.get("/status", (req, res) => {
  const payload = {
    ready: isReady,
    botActive,
    hasQr: Boolean(qrImageBase64),
    initAttempts,
    lastInitError,
  };
  res.status(isReady ? 200 : 503).json(payload);
});

function pageHTML(title, content, ready) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WhatsApp Bot</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0d0d0f;color:#f0ebe3;font-family:Georgia,serif;
         display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{background:#111;border:1px solid #1e1e1e;border-radius:16px;
          padding:40px;max-width:440px;width:100%;text-align:center}
    h1{font-size:22px;font-weight:400;margin-bottom:20px}
    code{background:#1a1a1a;padding:2px 8px;border-radius:4px;font-size:13px}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;
         background:${ready ? "#6abf6a" : "#c9a96e"};margin-right:8px}
  </style>
</head>
<body>
  <div class="card">
    <h1><span class="dot"></span>${title}</h1>
    ${content}
  </div>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Servidor en puerto ${PORT}`));

process.on("unhandledRejection", (reason) => {
  lastInitError = `unhandledRejection: ${String(reason || "")}`;
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  lastInitError = `uncaughtException: ${String(err?.message || err || "")}`;
  console.error("uncaughtException:", err);
});

startSocket("boot");
startKeepAlive();

function startKeepAlive() {
  if (!KEEP_ALIVE_URL) return;
  if (!Number.isFinite(KEEP_ALIVE_INTERVAL_MS) || KEEP_ALIVE_INTERVAL_MS <= 0) return;

  const tick = async () => {
    try {
      const status = await simpleGetStatus(KEEP_ALIVE_URL);
      console.log(`keep-alive: ${status} ${KEEP_ALIVE_URL}`);
    } catch (e) {
      console.error(`keep-alive error: ${e.message}`);
    }
  };

  tick();
  const timer = setInterval(tick, KEEP_ALIVE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

function simpleGetStatus(urlString) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { "User-Agent": "keep-alive" },
        timeout: 15000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err) => reject(err));
    req.end();
  });
}
