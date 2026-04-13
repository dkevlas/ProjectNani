const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
require('dotenv').config()

const app = express();
const api_key = process.env.GEMINI_API_KEY
const genAI = new GoogleGenerativeAI(api_key);
const wait = 5

// ── Configura aquí el número de tu amiga ─────────────────────────────────
// Formato: código de país + número, sin +, sin espacios. Ej: "5491123456789"
const FRIEND_NUMBER = process.env.FRIEND_NUMBER || 51922912558;
const DEBOUNCE_MS = wait * 1000; // 20 segundos de silencio antes de responder
// ─────────────────────────────────────────────────────────────────────────

const MODEL_TEXT = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const MODEL_AUDIO_TRANSCRIBE = process.env.GEMINI_TRANSCRIBE_MODEL || MODEL_TEXT;
const WWEBJS_AUTH_PATH = process.env.WWEBJS_AUTH_PATH || "/tmp/wwebjs_auth";
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL;
const KEEP_ALIVE_INTERVAL_MS = Number(process.env.KEEP_ALIVE_INTERVAL_MS || 10 * 60 * 1000);
const CHROME_EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_BIN ||
  process.env.CHROME_PATH ||
  resolveChromeExecutablePath();

let qrImageBase64 = null;
let isReady = false;
let botActive = true;

// Buffer de mensajes pendientes: { texts: [], audioBase64s: [], timer }
let pending = { texts: [], audioBase64s: [], timer: null };

// ── WhatsApp client ───────────────────────────────────────────────────────
const client = createWhatsAppClient();
registerWhatsAppHandlers(client);

function createWhatsAppClient() {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: WWEBJS_AUTH_PATH }),
    puppeteer: {
      headless: true,
      ...(CHROME_EXECUTABLE_PATH ? { executablePath: CHROME_EXECUTABLE_PATH } : {}),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
      ],
    },
  });
}

function resolveChromeExecutablePath() {
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }

  return undefined;
}

function registerWhatsAppHandlers(client) {
  client.on("qr", async (qr) => {
    console.log("QR generado — abre la URL en el navegador para escanearlo");
    qrImageBase64 = await qrcode.toDataURL(qr);
  });

  client.on("ready", () => {
    isReady = true;
    qrImageBase64 = null;
    console.log("✅ WhatsApp conectado y listo");
  });

  client.on("auth_failure", (message) => {
    isReady = false;
    qrImageBase64 = null;
    console.log("❌ Auth failure:", message);
  });

  client.on("disconnected", (reason) => {
    isReady = false;
    qrImageBase64 = null;
    console.log("❌ Desconectado:", reason);
  });

  client.on("message", handleIncomingMessage);
}

async function handleIncomingMessage(msg) {
  console.log("MENSAJE ENTRANTE:", msg.from, msg.type, msg.body);
  if (!botActive || msg.fromMe) return;

  const senderNumber = normalizeWhatsAppSender(msg.from);
  console.log("Número limpio:", senderNumber);
  console.log("FRIEND_NUMBER:", FRIEND_NUMBER);
  // if (senderNumber !== FRIEND_NUMBER) return;

  console.log(`📨 Mensaje recibido — tipo: ${msg.type}`);

  if (msg.type === "chat" && msg.body) {
    pending.texts.push(msg.body);
  }

  if (msg.type === "ptt" || msg.type === "audio") {
    await tryAccumulateAudio(msg);
  }

  resetDebounceTimer(msg);
}

function normalizeWhatsAppSender(from) {
  return from.replace(/@c\.us|@lid/g, "");
}

async function tryAccumulateAudio(msg) {
  try {
    const media = await msg.downloadMedia();
    if (media) {
      pending.audioBase64s.push({ data: media.data, mimetype: media.mimetype });
      console.log("🎤 Audio acumulado");
    }
  } catch (e) {
    console.error("Error descargando audio:", e.message);
  }
}

function resetDebounceTimer(lastMsg) {
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(async () => {
    await processAndReply(lastMsg);
  }, DEBOUNCE_MS);
}

// ── Procesar y responder ──────────────────────────────────────────────────
async function processAndReply(lastMsg) {
  const texts = [...pending.texts];
  const audios = [...pending.audioBase64s];
  pending = { texts: [], audioBase64s: [], timer: null };

  const parts = [];

  // Transcribir audios con Gemini
  for (const audio of audios) {
    try {
      const transcription = await transcribeAudio(audio.data, audio.mimetype);
      if (transcription) {
        parts.push(`[Audio transcrito]: ${transcription}`);
        console.log(`🎤 Transcripción: ${transcription}`);
      }
    } catch (e) {
      console.error("Error transcribiendo:", e.message);
      parts.push("[Audio recibido — no se pudo transcribir]");
    }
  }

  // Añadir textos
  for (const t of texts) parts.push(t);

  if (parts.length === 0) return;

  const combined = parts.join("\n");
  console.log(`📝 Procesando ${texts.length} texto(s) y ${audios.length} audio(s)`);

  try {
    const reply = await generateReply(combined);
    await lastMsg.reply(reply);
    console.log(`✉️  Respondido: ${reply}`);
  } catch (e) {
    console.error("Error generando respuesta:", e.message);
  }
}

// ── Transcribir audio con Gemini ──────────────────────────────────────────
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

// ── Generar respuesta empática con Gemini ─────────────────────────────────
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

// ── Web server ────────────────────────────────────────────────────────────
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
client.initialize();
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
