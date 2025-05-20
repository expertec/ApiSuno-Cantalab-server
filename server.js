// server.js

import axios from 'axios';

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cron from 'node-cron';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { admin, db } from './firebaseAdmin.js';

import { sendTextMessage, sendAudioMessage } from './whatsappService.js';
import {
  processSequences,
  generateLetras,
  sendLetras,
  generarLetraParaMusica,
  generarPromptParaMusica,
  generarMusicaConSuno,
  enviarMusicaPorWhatsApp
} from './scheduler.js';



dotenv.config();
ffmpeg.setFfmpegPath(ffmpegInstaller.path);


const bucket = admin.storage().bucket();

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONEID = process.env.PHONE_NUMBER_ID;
const GRAPH_PHONE_URL = `https://graph.facebook.com/v15.0/${PHONEID}`;

const app = express();
const port = process.env.PORT || 3001;
const upload = multer({ dest: path.resolve('./uploads') });
const FieldValue = admin.firestore.FieldValue;

// Middlewares
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));
app.use(cors());
app.use(bodyParser.json());

/**  
 * Endpoint para enviar mensaje de texto  
 */
app.post('/api/whatsapp/send-message', async (req, res) => {
  console.log('[DEBUG] POST /api/whatsapp/send-message', req.body);
  const { leadId, phone, message } = req.body;
  if (!message || (!leadId && !phone)) {
    return res.status(400).json({ error: 'Faltan message y leadId o phone' });
  }

  try {
    let numero = phone;
    if (leadId) {
      const leadSnap = await db.collection('leads').doc(leadId).get();
      if (!leadSnap.exists) {
        return res.status(404).json({ error: 'Lead no encontrado' });
      }
      numero = leadSnap.data().telefono;
    }

    await sendTextMessage(numero, message);
    return res.json({ success: true });
  } catch (err) {
    console.error('Error enviando texto:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**  
 * Endpoint para enviar nota de voz  
 */
app.post(
  '/api/whatsapp/send-audio',
  upload.single('audio'),
  async (req, res) => {
    console.log('[DEBUG] POST /api/whatsapp/send-audio', req.body);
    const { phone } = req.body;
    const uploadPath = req.file.path;
    const m4aPath = `${uploadPath}.m4a`;

    try {
      // 1) Transcodifica a M4A (AAC)
      await new Promise((resolve, reject) => {
        ffmpeg(uploadPath)
          .outputOptions(['-c:a aac', '-vn'])
          .toFormat('mp4')
          .save(m4aPath)
          .on('end', resolve)
          .on('error', reject);
      });

      // 2) Envía la nota de voz
      await sendAudioMessage(phone, m4aPath);

      // 3) Limpia archivos
      fs.unlinkSync(uploadPath);
      fs.unlinkSync(m4aPath);

      return res.json({ success: true });
    } catch (err) {
      console.error('Error enviando audio:', err);
      try { fs.unlinkSync(uploadPath); } catch {}
      try { fs.unlinkSync(m4aPath); } catch {}
      return res.status(500).json({ error: err.message });
    }
  }
);

// server.js

app.post(
  '/api/suno/callback',
  express.json(),
  async (req, res) => {
    console.log('🔔 Callback de Suno raw:', JSON.stringify(req.body, null, 2));
    const body = req.body;

    // Suno te manda taskId y status (y distintos campos de URL)
    const taskId = body.taskId || body.data?.taskId;
    const status = body.status || body.data?.status;
    // la URL real viene como 'source_audio_url'
    const audioUrl = body.source_audio_url 
                   || body.data?.source_audio_url 
                   || body.data?.url;
    const errorMsg = body.error || body.errorMsg || body.data?.error;

    // Busca el doc en Firestore que tenga este taskId
    const snap = await db.collection('musica')
      .where('taskId', '==', taskId)
      .limit(1)
      .get();

    if (snap.empty) {
      console.warn('Callback Suno sin task encontrado:', taskId);
      return res.sendStatus(404);
    }
    const docRef = snap.docs[0].ref;

    if (audioUrl) {
      // recibimos la URL final de audio, marcamos listo para enviar
      await docRef.update({ audioUrl, status: 'Enviar música' });
      console.log(`✅ Música lista para enviar (doc ${docRef.id})`);
    } else if (body.error || errorMsg) {
      // si llegó un error explícito
      await docRef.update({ status: 'Error música', errorMsg: errorMsg || body.error });
      console.warn(`❌ Falló generación música (doc ${docRef.id}):`, errorMsg || body.error);
    } else {
      // callbacks intermedios que no traen audioUrl ni error
      console.log(`ℹ️ Callback intermedio para task ${taskId}, sin audioUrl ni error.`);
    }
    

    res.sendStatus(200);
  }
);




// NUEVA ruta para los audios del chat
app.post(
  '/api/whatsapp/send-chat-audio',
  upload.single('audio'),
  async (req, res) => {
    try {
      const { phone }   = req.body;
      const uploadPath  = req.file.path;
      const m4aPath     = `${uploadPath}.m4a`;

      // 1) Transcodifica a M4A
      await new Promise((resolve, reject) => {
        ffmpeg(uploadPath)
          .outputOptions(['-c:a aac', '-vn'])
          .toFormat('mp4')
          .save(m4aPath)
          .on('end', resolve)
          .on('error', reject);
      });

      // 2) Súbelo a Firebase Storage
      const dest = `chat-audios/${path.basename(m4aPath)}`;
      await bucket.upload(m4aPath, {
        destination: dest,
        metadata: { contentType: 'audio/mp4' }
      });
      const [url] = await bucket
        .file(dest)
        .getSignedUrl({ action: 'read', expires: Date.now() + 86400000 });

      // 3) Envía al usuario con link
      await sendAudioMessage(phone, url);

      // 4) Limpia archivos temporales
      fs.unlinkSync(uploadPath);
      fs.unlinkSync(m4aPath);

      return res.json({ success: true });
    } catch (err) {
      console.error('Error en send-chat-audio:', err);
      // limpia temporales aunque falle
      try { fs.unlinkSync(req.file.path) } catch {}
      try { fs.unlinkSync(m4aPath) } catch {}
      return res.status(500).json({ error: err.message });
    }
  }
);

/**  
 * Webhook de WhatsApp: Verificación  
 */
app.get('/webhook', (req, res) => {
  console.log('[DEBUG] GET /webhook verify');
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.send(challenge);
  }
  return res.sendStatus(403);
});



/**
 * Estado de conexión (simple)
 */
app.get('/api/whatsapp/status', async (req, res) => {
  console.log('[DEBUG] GET /api/whatsapp/status');
  try {
    // Hacemos un request simple para validar token y número
    const resp = await axios.get(GRAPH_PHONE_URL, {
      params: {
        access_token: TOKEN,
        fields: 'display_phone_number'
      }
    });
    // Si llegamos aquí, todo está OK
    return res.json({
      status: 'Conectado',
      phone: resp.data.display_phone_number
    });
  } catch (err) {
    console.error('[ERROR] status check failed:', err.response?.data || err.message);
    // 401, 400, 404, etc.
    const code = err.response?.status || 500;
    return res.status(code).json({
      status: 'Desconectado',
      error: err.response?.data?.error?.message || err.message
    });
  }
});


/**
 * Número activo
 */
app.get('/api/whatsapp/number', async (req, res) => {
  console.log('[DEBUG] GET /api/whatsapp/number');
  try {
    const resp = await axios.get(GRAPH_PHONE_URL, {
      params: { access_token: TOKEN, fields: 'display_phone_number' }
    });
    return res.json({ phone: resp.data.display_phone_number });
  } catch (err) {
    console.error('[ERROR] number fetch failed:', err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

/**  
 * Webhook de WhatsApp: Mensajes entrantes  
 */

app.post('/webhook', async (req, res) => {
  console.log('[DEBUG] POST /webhook payload:', JSON.stringify(req.body).slice(0,200));
  try {
    const entryChanges = req.body.entry?.flatMap(e => e.changes) || [];
    for (const change of entryChanges) {
      const messages = change.value?.messages || [];
      for (const msg of messages) {
        const from = msg.from;                  // e.g. "521234567890"
        const text = msg.text?.body || '';

        // ——— BLOQUE UNIFICADO: baja de WhatsApp → sube a Storage → mediaUrl final ———
let mediaType = null;
let mediaUrl  = null;

if (msg.image || msg.document || msg.audio) {
  // 1) Tipo de media
  if (msg.image)       mediaType = 'image';
  else if (msg.document) mediaType = 'pdf';
  else if (msg.audio)    mediaType = 'audio';

  const mediaId = msg.image?.id || msg.document?.id || msg.audio?.id;
  if (mediaId) {
    // 2) Pido URL temporal de Graph
    const { data: { url: whatsappUrl } } = await axios.get(
      `https://graph.facebook.com/v15.0/${mediaId}`,
      { params: { access_token: TOKEN, fields: 'url' } }
    );

    // 3) Descargo el binario
    const ext = mediaType === 'image' ? 'jpg'
              : mediaType === 'pdf'   ? 'pdf'
              : 'mp4';
    const tmpPath = path.resolve('./uploads', `${mediaId}.${ext}`);
    const writer = fs.createWriteStream(tmpPath);
    const response = await axios.get(whatsappUrl, {
      responseType: 'stream',
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    await new Promise((res, rej) => {
      response.data.pipe(writer);
      writer.on('finish', res);
      writer.on('error', rej);
    });

    // 4) Subo a Firebase Storage
    const dest = `chat-media/${mediaId}.${ext}`;
    await bucket.upload(tmpPath, {
      destination: dest,
      metadata: { contentType: response.headers['content-type'] }
    });
    // limpio tmp
    fs.unlinkSync(tmpPath);

    // 5) Genero signed URL
    const [signedUrl] = await bucket
      .file(dest)
      .getSignedUrl({ action: 'read', expires: Date.now() + 24*60*60*1000 });

    mediaUrl = signedUrl;
  }
} else {
  mediaType = text ? 'text' : null;
}
// ——————————————————————————————————————————————————————————

        // ——————————————————————————————————————————————————————————

        // 1) Upsert de lead
        const q = await db.collection('leads')
                          .where('telefono','==', from)
                          .limit(1)
                          .get();
        let leadId;
        if (q.empty) {
          const now     = new Date();
          const cfgSnap = await db.collection('config').doc('appConfig').get();
          const cfg     = cfgSnap.exists ? cfgSnap.data() : {};
          const trigger = cfg.defaultTrigger || 'NuevoLead';

          const newLead = await db.collection('leads').add({
            telefono: from,
            nombre:  msg.pushName || '',
            source:  'WhatsApp',
            fecha_creacion: now,
            estado:  'nuevo',
            etiquetas: [trigger],
            secuenciasActivas: [{ trigger, startTime: now.toISOString(), index: 0 }],
            unreadCount: 1,
            lastMessageAt: now
          });
          leadId = newLead.id;
        } else {
          leadId = q.docs[0].id;
          await db.collection('leads').doc(leadId).update({
            unreadCount: FieldValue.increment(1),
            lastMessageAt: new Date()
          });
        }

        // 2) Guardar mensaje en subcolección
        const msgData = {
          content:   text,
          mediaType,
          mediaUrl,
          sender:    'lead',
          timestamp: new Date()
        };
        await db.collection('leads')
                .doc(leadId)
                .collection('messages')
                .add(msgData);
      }
    }

    // Siempre responder 200 lo antes posible
    return res.sendStatus(200);
  } catch (err) {
    console.error('[ERROR] en webhook:', err);
    return res.sendStatus(500);
  }
});

/**
 * Proxy para media: descarga desde WhatsApp o Firebase y reenvía al cliente
 */
app.get('/api/media', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    // baja el stream original (incluye token en url si viene)
    const response = await axios.get(url, {
      responseType: 'stream',
      // si tu URL requiere Authorization en header en lugar de query:
      // headers: { Authorization: `Bearer ${TOKEN}` }
    });

    // reenvía content-type al cliente
    res.setHeader('Content-Type', response.headers['content-type']);
    response.data.pipe(res);
  } catch (err) {
    console.error('Error proxy /api/media:', err.message);
    res.sendStatus(500);
  }
});


// Scheduler: tus procesos periódicos
cron.schedule('* * * * *', () => {
  processSequences().catch(err => console.error('Error en processSequences:', err));
});
cron.schedule('* * * * *', () => {
  generateLetras().catch(err => console.error('Error en generateLetras:', err));
});
cron.schedule('* * * * *', () => {
  sendLetras().catch(err => console.error('Error en sendLetras:', err));
});

// NUEVOS cron jobs para música
cron.schedule('* * * * *', () => {
  generarLetraParaMusica().catch(err => console.error('Error en generarLetraParaMusica:', err));
});
cron.schedule('* * * * *', () => {
  generarPromptParaMusica().catch(err => console.error('Error en generarPromptParaMusica:', err));
});

cron.schedule('* * * * *', () => {
  generarMusicaConSuno().catch(console.error);
});

cron.schedule('* * * * *', () => {
  enviarMusicaPorWhatsApp().catch(err => console.error('Error en enviarMusicaPorWhatsApp:', err));
});

// Debe ir antes de app.listen(...)
app.get('/api/media', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).send('url missing');
  }
  try {
    // hacemos fetch del stream
    const resp = await axios.get(url, {
      responseType: 'stream',
      // si haces WA attachments, necesitas token:
      params: resp => resp.url.includes('lookaside.fbsbx.com')
        ? { access_token: TOKEN }
        : {},
    });
    // cabeceras CORS y de tipo
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', resp.headers['content-type']);
    // redirigimos el stream al cliente
    resp.data.pipe(res);
  } catch (err) {
    console.error('Media proxy error:', err.message);
    res.sendStatus(500);
  }
});

// Arranca el servidor
app.listen(port, () => {
  console.log(`Servidor corriendo en puerto ${port}`);
});