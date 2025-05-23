// src/server/scheduler.js
import { db } from './firebaseAdmin.js';
import { sendTextMessage, sendAudioMessage, sendVideoMessage, sendTemplateMessage } from './whatsappService.js';


import admin from 'firebase-admin';
import { Configuration, OpenAIApi } from 'openai';
import fetch from 'node-fetch';
import axios from 'axios';
const bucket = admin.storage().bucket();

function sanitizeParam(text) {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
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
function replacePlaceholders(template, leadData) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, field) => {
    if (field === 'letra') {
      return leadData.letra || '';
    }
    if (field === 'nombre') {
      const nombre = leadData.nombre || '';
      return nombre.split(' ')[0] || '';
    }
    return leadData[field] || '';
  });
}


/**
 * Envía un mensaje de WhatsApp según su tipo usando la Cloud API.
 */
export async function enviarMensaje(lead, mensaje) {
  try {
    // 1) Normalizar teléfono
    const phone = (lead.telefono || '').replace(/\D/g, '');

    // 2) Si en el contenido o parámetros hay {{letra}}, cargar la letra más reciente
    const textoCompleto = mensaje.contenido || '';
    const usaLetra =
      textoCompleto.includes('{{letra}}') ||
      mensaje.parameters?.some(p => p.value.includes('{{letra}}'));
    if (usaLetra) {
      // Asegurarse de tener lead.letraIds (debe venir del proceso que carga leads)
      if (Array.isArray(lead.letraIds) && lead.letraIds.length > 0) {
        const latestId = lead.letraIds[0];
        const doc = await db.collection('letras').doc(latestId).get();
        lead.letra = doc.exists ? (doc.data().letra || '') : '';
      } else {
        lead.letra = '';
      }
    }

    // 3) Función de ayuda para reemplazar y sanitizar
    const fill = text => sanitizeParam(replacePlaceholders(text, lead));

    // 4) Switch según tipo
    switch (mensaje.type) {
      case 'texto': {
        const content = fill(mensaje.contenido || '');
        if (content) await sendTextMessage(phone, content);
        break;
      }

      case 'formulario': {
        // reutilizamos replacePlaceholders para nombre y teléfono
        const content = fill(mensaje.contenido || '')
          .replace(/\{\{telefono\}\}/g, phone);
        if (content) await sendTextMessage(phone, content);
        break;
      }

      case 'audio': {
        const mediaUrl = fill(mensaje.contenido || '');
        await sendAudioMessage(phone, mediaUrl);
        break;
      }

      case 'imagen': {
        const mediaUrl = fill(mensaje.contenido || '');
        await sendTextMessage(phone, mediaUrl);
        break;
      }

      case 'video': {
        const mediaUrl = fill(mensaje.contenido || '');
        await sendVideoMessage(phone, mediaUrl);
        break;
      }

      case 'template': {
        // Construir parámetros de plantilla
        const params = (mensaje.parameters || []).map(p => ({
          type: 'text',
          text: fill(p.value)
        }));
        const components = params.length
          ? [{ type: 'body', parameters: params }]
          : [];

        // Enviar
        await sendTemplateMessage({
          to:           phone,
          templateName: mensaje.templateName,
          language:     mensaje.language || 'es_MX',
          components
        });

        // Registrar en Firestore
        await db
          .collection('leads')
          .doc(lead.id)
          .collection('messages')
          .add({
            content:   `Plantilla ${mensaje.templateName} enviada`,
            template:  mensaje.templateName,
            variables: (mensaje.parameters || []).reduce((obj, p) => {
              obj[p.key] = replacePlaceholders(p.value, lead);
              return obj;
            }, {}),
            sender:    'business',
            timestamp: new Date()
          });
        break;
      }

      default:
        console.warn(`Tipo desconocido en enviarMensaje(): ${mensaje.type}`);
    }
  } catch (err) {
    console.error("Error en enviarMensaje:", err);
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
    const snap = await db.collection('letras').where('status', '==', 'Sin letra').get();
    console.log(`✔️ generateLetras: encontrados ${snap.size} registros con status 'Sin letra'`);
    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      const prompt = `Escribe una letra de canción con lenguaje simple que su estructura sea verso 1, verso 2, coro, verso 3, verso 4 y coro. Agrega titulo de la canción en negritas. No pongas datos personales que no se puedan confirmar. Agrega un coro cantable y memorable. Solo responde con la letra de la canción sin texto adicional. Propósito: ${data.purpose}. Nombre: ${data.includeName}. Anecdotas o fraces: ${data.anecdotes}`;
      console.log(`📝 prompt para ${docSnap.id}:\n${prompt}`);

      const response = await openai.createChatCompletion({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Eres un compositor creativo.' },
          { role: 'user', content: prompt }
        ]
      });

      const letra = response.data.choices?.[0]?.message?.content?.trim();
      if (letra) {
        console.log(`✅ letra generada para ${docSnap.id}`);
        await docSnap.ref.update({
          letra,
          status: 'enviarLetra',
          letraGeneratedAt: FieldValue.serverTimestamp()
        });
      }
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

  await docSnap.ref.update({
    lyrics: letra,
    status: 'Sin prompt',
    lyricsGeneratedAt: FieldValue.serverTimestamp()
  });
  console.log(`✅ generarLetraParaMusica: ${docSnap.id}`);
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
    model:        "V4",
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





// 4) Enviar música por WhatsApp (Enviar música → Enviada)
async function enviarMusicaPorWhatsApp() {
  // 1) Buscamos todos los docs listos para enviar
  const snap = await db.collection('musica')
    .where('status', '==', 'Enviar música')
    .get();
  if (snap.empty) return;

  const now = Date.now();

  for (const docSnap of snap.docs) {
    const doc    = docSnap.data();
    const ref    = docSnap.ref;
    const leadId = doc.leadId;
    const phone  = (doc.leadPhone || '').replace(/\D/g, '');
    const lyrics = doc.lyrics;
    const clip   = doc.clipUrl;
    const created = doc.createdAt?.toDate?.().getTime() || now;

    // 2) Sólo enviamos si han pasado ≥15 minutos desde createdAt
    if (now - created < 15 * 60_000) continue;

    if (!phone || !lyrics || !clip) {
      console.warn(`❌ faltan datos en doc ${docSnap.id}`);
      continue;
    }

    try {
      // 3) Enviar la letra
      await sendTextMessage(phone, `Aquí tienes la letra de tu canción:\n\n${lyrics}`);

      // 4) Enviar el clip de 30s con marca de agua
      await sendAudioMessage(phone, clip);

      // 5) Actualizar estado en Firestore
      await ref.update({
        status: 'Enviada',
        sentAt: FieldValue.serverTimestamp()
      });

      // 6) Añadir secuencia "CancionEnviada" al lead
      await db.collection('leads').doc(leadId).update({
        secuenciasActivas: FieldValue.arrayUnion({
          trigger:   'CancionEnviada',
          startTime: new Date().toISOString(),
          index:     0
        })
      });

      console.log(`✅ Letra + clip enviados al ${phone} y secuencia CancionEnviada agregada.`);
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
  enviarMusicaPorWhatsApp
};
