// src/server/scheduler.js
import { db } from './firebaseAdmin.js';
import { sendTextMessage, sendAudioMessage, sendVideoMessage, sendTemplateMessage, sendDocumentMessage } from './whatsappService.js';

import admin from 'firebase-admin';
import { Configuration, OpenAIApi } from 'openai';
import fetch from 'node-fetch';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';


const bucket = admin.storage().bucket();

// Sanitize helper correctamente nombrado
function sanitizeParam(text) {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

async function downloadStream(url, destPath) {
  const res = await axios.get(url, { responseType: 'stream' });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    res.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

/**
 * Detecta y resetea tareas atascadas en 'Procesando música' por más de {thresholdMin} minutos
 */
async function retryStuckMusic(thresholdMin = 10) {
  const cutoff = Date.now() - thresholdMin * 60_000;
  const snap = await db.collection('musica')
    .where('status', '==', 'Procesando música')
    .where('generatedAt', '<=', new Date(cutoff))
    .get();
  if (snap.empty) return;

  console.log(`🔄 retryStuckMusic: reenviando ${snap.size} tareas atascadas`);
  for (const docSnap of snap.docs) {
    try {
      await docSnap.ref.update({
        status:    'Sin música',
        taskId:    admin.firestore.FieldValue.delete(),
        errorMsg:  admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`  ✅ ${docSnap.id} → status 'Sin música'`);
    } catch (err) {
      console.error(`  ❌ no pude resetear ${docSnap.id}:`, err);
    }
  }
}



/**
 * Trunca un texto para que su longitud, contando saltos de línea,
 * nunca supere `maxLen - safetyMargin`. 
 */
function truncateToLimit(text, maxLen = 1024, safetyMargin = 5) {
  // Si está dentro de los límites, devolvemos tal cual
  if (text.length <= maxLen - safetyMargin) {
    return text;
  }
  // Si excede, lo recortamos
  return text.slice(0, maxLen - safetyMargin);
}





const { FieldValue } = admin.firestore;

// Asegúrate de que la API key esté definida
if (!process.env.OPENAI_API_KEY) {
  throw new Error("Falta la variable de entorno OPENAI_API_KEY");
}
// Configuración de OpenAI
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

/**
 * Reemplaza placeholders en plantillas de texto.
 * {{campo}} se sustituye por leadData.campo si existe.
 */
// Placeholder replacer
function replacePlaceholders(template, leadData) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, field) => {
    if (field === 'nombre') {
      return (leadData.nombre || '').split(' ')[0];
    }
    if (field === 'letra') {
      return leadData.letra || '';
    }
    return leadData[field] || '';
  });
}




/**
 * Envía un mensaje de WhatsApp según su tipo usando la Cloud API.
 */
export async function enviarMensaje(lead, mensaje) {
  try {
    const phone = (lead.telefono || '').replace(/\D/g, '');

    // Si vamos a usar {{letra}}, asegúrate de tenerla en lead.letra
    if (mensaje.type === 'template'
     && mensaje.parameters?.some(p => p.value.includes('{{letra}}'))
     && Array.isArray(lead.letraIds) && lead.letraIds.length
    ) {
      const letraDoc = await db
        .collection('letras')
        .doc(lead.letraIds[0])
        .get();
      lead.letra = letraDoc.exists ? letraDoc.data().letra : '';
    }

    switch (mensaje.type) {
      case 'texto': {
        const content = replacePlaceholders(mensaje.contenido || '', lead).trim();
        if (content) await sendTextMessage(phone, content);
        break;
      }
      case 'formulario': {
        const raw = mensaje.contenido || '';
        const nameVal = encodeURIComponent(lead.nombre || '');
        const txt = raw
          .replace('{{telefono}}', phone)
          .replace('{{nombre}}', nameVal)
          .replace(/\r?\n/g, ' ')
          .trim();
        if (txt) await sendTextMessage(phone, txt);
        break;
      }
      case 'audio': {
        const url = replacePlaceholders(mensaje.contenido || '', lead);
        await sendAudioMessage(phone, url);
        break;
      }
      case 'imagen': {
        const url = replacePlaceholders(mensaje.contenido || '', lead);
        await sendTextMessage(phone, url);
        break;
      }
      case 'video': {
        const url = replacePlaceholders(mensaje.contenido || '', lead);
        await sendVideoMessage(phone, url);
        break;
      }
      case 'document': {
  // Reemplaza placeholders en la URL o contenido
  const url = replacePlaceholders(mensaje.contenido || '', lead);

  try {
    // Envía el documento/PDF usando tu servicio de WhatsApp
    await sendDocumentMessage(lead.telefono, url);
    console.log(`Documento enviado a ${lead.telefono}: ${url}`);
  } catch (err) {
    console.error(`Error enviando documento a ${lead.telefono}:`, err);
  }
  break;
}


      case 'template': {
        const params = (mensaje.parameters || []).map(p => {
          // 1) sustituir placeholders
          let txt = replacePlaceholders(p.value, lead);
          // 2) limpiar espacios y saltos de línea sobrantes
          txt = sanitizeParam(txt);
          // 3) truncar a 5 caracteres menos del límite
          txt = truncateToLimit(txt, 1024, 5);
      
          return { type: 'text', text: txt };
        });
      
        const components = params.length
          ? [{ type: 'body', parameters: params }]
          : [];
      
        await sendTemplateMessage({
          to:           phone,
          templateName: mensaje.templateName,
          language:     mensaje.language || 'es_MX',
          components
        });
        // Registrar en Firestore
        await db.collection('leads')
          .doc(lead.id)
          .collection('messages')
          .add({
            content:   `Plantilla ${mensaje.templateName} enviada`,
            template:  mensaje.templateName,
            variables: (mensaje.parameters || []).reduce((o,p) => {
                         o[p.key] = replacePlaceholders(p.value, lead);
                         return o;
                       }, {}),
            sender:    'business',
            timestamp: new Date()
          });
        break;
      }
      default:
        console.warn(`Tipo desconocido: ${mensaje.type}`);
    }
  } catch (err) {
    console.error("Error al enviar mensaje:", err);
  }
}



/**
 * Procesa las secuencias activas de cada lead.
 */
async function processSequences() {
  try {
    const leadsSnap = await db
      .collection('leads')
      .where('secuenciasActivas', '!=', null)
      .get();

    for (const doc of leadsSnap.docs) {
          // 1) Cargar los datos básicos del lead
          const lead = { id: doc.id, ...doc.data() };
      
       
      if (!Array.isArray(lead.secuenciasActivas) || !lead.secuenciasActivas.length) continue;

      let dirty = false;
      for (const seq of lead.secuenciasActivas) {
        const { trigger, startTime, index } = seq;
        const seqSnap = await db
          .collection('secuencias')
          .where('trigger', '==', trigger)
          .get();
        if (seqSnap.empty) continue;

        const msgs = seqSnap.docs[0].data().messages;
        if (index >= msgs.length) {
          seq.completed = true;
          dirty = true;
          continue;
        }

        const msg = msgs[index];
        const sendAt = new Date(startTime).getTime() + msg.delay * 60000;
        if (Date.now() < sendAt) continue;

        // Enviar y luego registrar en Firestore
        await enviarMensaje(lead, msg);
        await db
          .collection('leads')
          .doc(lead.id)
          .collection('messages')
          .add({
            content: `Se envió el ${msg.type} de la secuencia ${trigger}`,
            sender: 'system',
            timestamp: new Date()
          });

        seq.index++;
        dirty = true;
      }

      if (dirty) {
        const rem = lead.secuenciasActivas.filter(s => !s.completed);
        await db.collection('leads').doc(lead.id).update({ secuenciasActivas: rem });
      }
    }
  } catch (err) {
    console.error("Error en processSequences:", err);
  }
}

/**
 * Genera letras para los registros en 'letras' con status 'Sin letra',
 * guarda la letra, marca status → 'enviarLetra' y añade marca de tiempo.
 */
async function generateLetras() {
  console.log("▶️ generateLetras: inicio");
  try {
    const snap = await db.collection('letras')
      .where('status', '==', 'Sin letra')
      .get();
    console.log(`✔️ generateLetras: encontrados ${snap.size} registros con status 'Sin letra'`);
    
    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      const leadId = data.leadId;
      const MAX = 750;
const prompt = `
Escribe una letra de canción con lenguaje simple, siguiendo esta estructura:
verso 1, verso 2, coro, verso 3, verso 4 y coro. Agrega el título en negritas.
**La letra no debe exceder ${MAX} caracteres.** No incluyas texto adicional ni explicaciones.
Propósito: ${data.purpose}.
Nombre: ${data.includeName}.
Anécdotas o frases: ${data.anecdotes}.
`.trim();
      console.log(`📝 prompt para ${docSnap.id}:\n${prompt}`);

      const response = await openai.createChatCompletion({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Eres un compositor creativo.' },
          { role: 'user', content: prompt }
        ]
      });

      const letra = response.data.choices?.[0]?.message?.content?.trim();
      if (!letra) continue;

      console.log(`✅ letra generada para ${docSnap.id}`);
      // 1) Actualiza el doc en 'letras'
      await docSnap.ref.update({
        letra,
        status: 'enviarLetra',
        letraGeneratedAt: FieldValue.serverTimestamp()
      });

      // 2) Guarda la letra en el lead:
      //    - actualiza un campo `letra` con el texto
      //    - añade el ID de esta letra en un array `letraIds`
      const leadRef = db.collection('leads').doc(leadId);
      await leadRef.update({
        letra,                                          // campo rápido para el acceso
        letraIds: FieldValue.arrayUnion(docSnap.id)     // histórico de IDs
      });
    }

    console.log("▶️ generateLetras: finalizado");
  } catch (err) {
    console.error("❌ Error generateLetras:", err);
  }
}


/**
 * Envía por WhatsApp las letras generadas (status 'enviarLetra'),
 * añade trigger 'LetraEnviada' al lead y marca status → 'enviada'.
 * Solo envía si han pasado al menos 15 minutos desde 'letraGeneratedAt'.
 */
async function sendLetras() {
  try {
    const now = Date.now();
    const snap = await db.collection('letras').where('status', '==', 'enviarLetra').get();
    const VIDEO_URL = 'https://cantalab.com/wp-content/uploads/2025/04/WhatsApp-Video-2025-04-23-at-8.01.51-PM.mp4';
    const AUDIO_URL = 'https://cantalab.com/wp-content/uploads/2024/11/JTKlhy_inbox.oga';

    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      const { leadId, letra, requesterName, letraGeneratedAt } = data;

      // 1) Validaciones básicas
      if (!leadId || !letra || !letraGeneratedAt) continue;
      const genTime = letraGeneratedAt.toDate().getTime();
      if (now - genTime < 15 * 60 * 1000) continue;

      // 2) Hacer lookup del lead para obtener su número
      const leadRef = db.collection('leads').doc(leadId);
      const leadSnap = await leadRef.get();
      if (!leadSnap.exists) {
        console.warn(`Lead no encontrado: ${leadId}`);
        continue;
      }
      const telefono = leadSnap.data().telefono || '';
      const phoneClean = telefono.replace(/\D/g, '');
      if (!/^\d{10,15}$/.test(phoneClean)) {
        console.error(`Número inválido para lead ${leadId}: "${telefono}"`);
        continue;
      }

      const firstName = (requesterName || '').trim().split(' ')[0] || '';

      // 3) Mensaje de cierre
      const greeting = `Listo ${firstName}, ya terminé la letra para tu canción. *Léela y dime si te gusta.*`;
      await sendTextMessage(phoneClean, greeting);
      await db
        .collection('leads').doc(leadId).collection('messages')
        .add({ content: greeting, sender: 'business', timestamp: new Date() });

      // 4) Enviar la letra
      await sendTextMessage(phoneClean, letra);
      await db
        .collection('leads').doc(leadId).collection('messages')
        .add({ content: letra, sender: 'business', timestamp: new Date() });

      // 5) Enviar audio introductorio
      await sendAudioMessage(phoneClean, AUDIO_URL);
      await db
        .collection('leads').doc(leadId).collection('messages')
        .add({ mediaType: 'audio', mediaUrl: AUDIO_URL, sender: 'business', timestamp: new Date() });

      // 6) Enviar el video como enlace de texto
      await sendVideoMessage(phoneClean, VIDEO_URL);
      await db
        .collection('leads').doc(leadId).collection('messages')
        .add({ mediaType: 'video', mediaUrl: VIDEO_URL, sender: 'business', timestamp: new Date() });

      // 7) Mensaje promocional
      const promo =
        `${firstName} el costo normal es de $1997 MXN pero tenemos la promocional esta semana de $697 MXN.\n\n` +
        `Puedes pagar en esta cuenta:\n\n🏦 Transferencia bancaria:\n` +
        `Cuenta: 4152 3143 2669 0826\nBanco: BBVA\nTitular: Iván Martínez Jiménez\n\n` +
        `🌐 Pago en línea o en dolares 🇺🇸 (45 USD):\n` +
        `https://cantalab.com/tu-cancion-mx/`;
      await sendTextMessage(phoneClean, promo);
      await db
        .collection('leads').doc(leadId).collection('messages')
        .add({ content: promo, sender: 'business', timestamp: new Date() });

      // 8) Actualizar lead y marcar letra enviada
      await leadRef.update({
        etiquetas: FieldValue.arrayUnion('LetraEnviada'),
        secuenciasActivas: FieldValue.arrayUnion({
          trigger: 'LetraEnviada',
          startTime: new Date().toISOString(),
          index: 0
        })
      });
      await docSnap.ref.update({ status: 'enviada' });
    }
  } catch (err) {
    console.error('❌ Error en sendLetras:', err);
  }
}


async function generarLetraParaMusica() {
  const snap = await db.collection('musica')
    .where('status', '==', 'Sin letra')
    .limit(1)
    .get();
  if (snap.empty) return;

  const docSnap = snap.docs[0];
  const d       = docSnap.data();
  const prompt = `
Escribe una letra de canción con lenguaje simple siguiendo esta estructura:
verso 1, verso 2, coro, verso 3, verso 4 y coro.
Agrega título en negritas.
Propósito: ${d.purpose}.
Nombre: ${d.includeName}.
Anecdotas: ${d.anecdotes}.
  `.trim();

  // Generamos la letra con OpenAI
  const resp = await openai.createChatCompletion({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Eres un compositor creativo.' },
      { role: 'user',   content: prompt }
    ],
    max_tokens: 400,
  });
  const letra = resp.data.choices?.[0]?.message?.content?.trim();
  if (!letra) throw new Error(`No letra para ${docSnap.id}`);

  // 1) Actualiza el documento en 'musica'
  await docSnap.ref.update({
    lyrics: letra,
    status: 'Sin prompt',
    lyricsGeneratedAt: FieldValue.serverTimestamp()
  });
  console.log(`✅ generarLetraParaMusica: letra generada para ${docSnap.id}`);

  // 2) Guarda la letra también en el lead asociado
  if (data.leadId) {
    const leadRef = db.collection('leads').doc(data.leadId);
    await leadRef.update({
      letra,                                      // campo rápido para acceso
      letraIds: FieldValue.arrayUnion(docSnap.id) // histórico de IDs
    });
    console.log(`✅ letra guardada en lead ${data.leadId}`);
  } else {
    console.warn(`⚠️ generarLetraParaMusica: no existe leadId en ${docSnap.id}`);
  }
}



/**
 * Genera y refina automáticamente el prompt para Suno usando ChatGPT.
 * Pasa de status 'Sin prompt' → 'Sin música'.
 */
async function generarPromptParaMusica() {
  // 1) Recupera un documento pendiente
  const snap = await db.collection('musica')
    .where('status', '==', 'Sin prompt')
    .limit(1)
    .get();
  if (snap.empty) return;

  const docSnap = snap.docs[0];
  const { artist, genre, voiceType } = docSnap.data();

  // 2) Borrador del prompt
  const draft = `
  Crea un promt para decirle a suno que haga una canción estilo exitos de  ${artist} genero 
   ${genre} con tipo de voz ${voiceType}. Sin mencionar al artista en cuestion u otras palabras
    que puedan causar conflictos de derecho de autor, centrate en los elementos musicales como ritmo, instrumentos,
     generos. Suno requiere que sean maximo 120 caracteres y que le pases los elementos separados por coma, 
     mira este ejemplo ( rock pop con influencias en blues, guitarra electrica, ritmo de bateria energico)
      genera algo similar para cancion que quiero.
  `.trim();

  // 3) Usa ChatGPT para refinar el borrador
  const gptRes = await openai.createChatCompletion({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Eres un redactor creativo de prompts musicales.' },
      { role: 'user', content: `Refina este borrador para que tenga menos de 120 caracteres y sólo liste los elementos separados por comas: "${draft}"` }
    ]
  });

  const stylePrompt = gptRes.data.choices[0].message.content.trim();

  // 4) Guarda el prompt refinado en Firestore y avanza el estado
  await docSnap.ref.update({
    stylePrompt,
    status: 'Sin música'
  });

  console.log(`✅ generarPromptParaMusica: ${docSnap.id} → "${stylePrompt}"`);
}





// ————————————
// Helpers Suno
// ————————————

/**
 * Lanza la generación de música en Suno y retorna el taskId.
 */
/**
 * Lanza la generación de música en Suno y retorna el taskId.
 */
async function lanzarTareaSuno({ title, stylePrompt, lyrics }) {
  const url  = 'https://apibox.erweima.ai/api/v1/generate';
  const body = {
    model:        "V4_5",
    customMode:   true,
    instrumental: false,
    title,
    style:        stylePrompt,
    prompt:       lyrics,
    callbackUrl:  process.env.CALLBACK_URL  // tu endpoint /api/suno/callback
  };

  console.log('🛠️ Suno request:', { body });
  const res = await axios.post(url, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${process.env.SUNO_API_KEY}`
    }
  });
  console.log('🛠️ Suno response:', res.status, res.data);

  if (res.data.code !== 200 || !res.data.data?.taskId) {
    throw new Error(`No taskId recibido de Suno. Respuesta: ${JSON.stringify(res.data)}`);
  }
  return res.data.data.taskId;
}



/**
 * Busca un documento con status 'Sin música', lanza la tarea en Suno
 * y guarda el taskId en Firestore. El webhook se encargará de actualizar
 * el audioUrl y el status cuando Suno lo notifique.
 */
async function generarMusicaConSuno() {
  // 1) Selecciona un documento pendiente de música
  const snap = await db.collection('musica')
    .where('status', '==', 'Sin música')
    .limit(1)
    .get();
  if (snap.empty) return;  // no hay nada que procesar

  const doc = snap.docs[0];
  const docRef = doc.ref;
  const { stylePrompt, purpose, lyrics } = doc.data();

  // 2) Marca como “Procesando música”
  await docRef.update({ 
    status: 'Procesando música',
    generatedAt: FieldValue.serverTimestamp()
  
  });

  try {
    // 3) Lanza la tarea y guarda el taskId
    const taskId = await lanzarTareaSuno({
      title: purpose.slice(0, 30),   // Suno permite hasta 30 chars
      stylePrompt,
      lyrics
    });
    await docRef.update({ taskId });

    console.log(`🔔 generarMusicaConSuno: lanzado task ${taskId} para ${docRef.id}`);
  } catch (err) {
    console.error(`❌ Error en generarMusicaConSuno (${docRef.id}):`, err.message);
    // Marca error para no reintentar indefinidamente
    await docRef.update({
      status:     'Error música',
      errorMsg:   err.message,
      updatedAt:  FieldValue.serverTimestamp()
    });
  }
}


async function procesarClips() {
  const snap = await db.collection('musica')
    .where('status', '==', 'Audio listo')
    .get();
  if (snap.empty) return;

  for (const docSnap of snap.docs) {
    const ref    = docSnap.ref;
    const { fullUrl } = docSnap.data();
    const id     = docSnap.id;

    if (!fullUrl) {
      console.error(`[${id}] falta fullUrl`);
      continue;
    }

    // Marcamos que estamos procesando el clip
    await ref.update({ status: 'Generando clip' });

    // Rutas absolutas
    const tmpFull      = path.join(os.tmpdir(), `${id}-full.mp3`);
    const tmpClip      = path.join(os.tmpdir(), `${id}-clip.mp3`);
    const watermarkUrl = 'https://cantalab.com/wp-content/uploads/2025/05/marca-de-agua-1-minuto.mp3';
    const watermarkTmp  = path.join(os.tmpdir(), 'watermark.mp3');
    const tmpWater     = path.join(os.tmpdir(), `${id}-watermarked.mp3`);

    // 1) Descargar audio completo
    await downloadStream(fullUrl, tmpFull);
    if (!fs.existsSync(tmpFull)) {
      console.error(`[${id}] descarga full fallida`);
      await ref.update({ status: 'Error descarga full' });
      continue;
    }

    // 2) Generar clip de 60s
    try {
      await new Promise((res, rej) => {
        ffmpeg(tmpFull)
          .setStartTime(0)
          .setDuration(60)
          .output(tmpClip)
          .on('end', res)
          .on('error', rej)
          .run();
      });
    } catch (err) {
      console.error(`[${id}] error generando clip:`, err);
      await ref.update({ status: 'Error clip' });
      continue;
    }

    // 3) Descargar marca y superponer al clip
    await downloadStream(watermarkUrl, watermarkTmp);
    if (!fs.existsSync(watermarkTmp)) {
      console.error(`[${id}] descarga watermark fallida`);
      await ref.update({ status: 'Error watermark descarga' });
      continue;
    }
    try {
      await new Promise((res, rej) => {
        ffmpeg()
          .input(tmpClip)
          .input(watermarkTmp)
          .complexFilter([
            '[1]adelay=1000|1000,volume=0.3[beep];' +
            '[0][beep]amix=inputs=2:duration=first'
          ])
          .output(tmpWater)
          .on('end', res)
          .on('error', rej)
          .run();
      });
    } catch (err) {
      console.error(`[${id}] error aplicando watermark:`, err);
      await ref.update({ status: 'Error watermark' });
      continue;
    }

    // 4) Subir clip final y obtener Signed URL
try {
  // 4.1) Sube el archivo
  const [file] = await bucket.upload(tmpWater, {
    destination: `musica/clip/${id}-clip.mp3`,
    metadata:    { contentType: 'audio/mpeg' }
  });

  // 4.2) Genera un signed URL con expiración de 24h
  const [clipUrl] = await file.getSignedUrl({
    action:  'read',
    expires: Date.now() + 24 * 60 * 60 * 1000
  });

  // 4.3) Actualiza Firestore
  await ref.update({
    clipUrl,
    status: 'Enviar música'
  });

  console.log(`[${id}] clip listo → Enviar música (URL firmada)`);
} catch (err) {
  console.error(`[${id}] error subiendo clip:`, err);
  await ref.update({ status: 'Error upload clip' });
}


    // Limpieza
    [tmpFull, tmpClip, watermarkTmp, tmpWater].forEach(f => {
      try { fs.unlinkSync(f); } catch {}
    });
  }
}



// 4) Enviar música por WhatsApp (Enviar música → Enviada)
async function enviarMusicaPorWhatsApp() {
  // 1) Buscamos todos los docs listos para enviar
  const snap = await db.collection('musica')
    .where('status', '==', 'Enviar música')
    .get();
  if (snap.empty) return;

  const now = Date.now();

  for (const docSnap of snap.docs) {
    const data    = docSnap.data();
    const ref     = docSnap.ref;
    const leadId  = data.leadId;
    const phone   = (data.leadPhone || '').replace(/\D/g, '');
    const lyrics  = data.lyrics;
    const clip    = data.clipUrl;
    const created = data.createdAt?.toDate?.().getTime() || now;

    // 2) Sólo enviamos si han pasado ≥15 minutos desde createdAt
    if (now - created < 15 * 60_000) continue;

    if (!phone || !lyrics || !clip) {
      console.warn(`❌ faltan datos en doc ${docSnap.id}`);
      continue;
    }

    try {
      // --- Traemos el nombre del lead ---
      const leadSnap = await db.collection('leads').doc(leadId).get();
      const leadName = leadSnap.exists
        ? (leadSnap.data().name || '').split(' ')[0]
        : '';

      // --- 3) Mensaje1: Saludo + letra ---
      const saludo = leadName
        ? `Hola ${leadName}, esta es la letra que hicimos para tu canción:`
        : `Esta es la letra que hicimos para tu canción:`;
      await sendTextMessage(phone, `${saludo}\n\n${lyrics}`);

      // --- 4) Mensaje2: Pregunta de feedback ---
      await sendTextMessage(phone, `¿Cómo la vez? Le pusimos música y quedó de esta manera.`);

      // --- 5) Mensaje3: Enviar el clip de audio ---
      await sendAudioMessage(phone, clip);

      // --- 6) Actualizar estado en Firestore ---
      await ref.update({
        status: 'Enviada',
        sentAt: FieldValue.serverTimestamp()
      });

      // --- 7) Añadir secuencia "CancionEnviada" al lead ---
      await db.collection('leads').doc(leadId).update({
        secuenciasActivas: FieldValue.arrayUnion({
          trigger:   'CancionEnviada',
          startTime: new Date().toISOString(),
          index:     0
        })
      });

      console.log(`✅ Mensajes y clip enviados al ${phone}, secuencia CancionEnviada agregada.`);
    } catch (err) {
      console.error(`❌ Error enviando música para doc ${docSnap.id}:`, err);
    }
  }
}






export {
  processSequences,
  generateLetras,
  sendLetras,
  generarLetraParaMusica,
  generarPromptParaMusica,
  generarMusicaConSuno,
  procesarClips, 
  retryStuckMusic,
  enviarMusicaPorWhatsApp
};