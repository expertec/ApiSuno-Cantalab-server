// whatsappService.js

import axios from 'axios';
import dotenv from 'dotenv';
import { db } from './firebaseAdmin.js';

dotenv.config();

const TOKEN   = process.env.WHATSAPP_TOKEN;
const PHONEID = process.env.PHONE_NUMBER_ID;
// Base URL para todas las llamadas (sin “/messages”)
const API_BASE = `https://graph.facebook.com/v15.0/${PHONEID}`;

/** Normaliza teléfono a E.164 sin '+' */
function normalize(phone) {
  let num = String(phone).replace(/\D/g, '');
  if (num.length === 10) num = '52' + num;
  return num;
}

/** Llama a la WhatsApp Cloud API */
async function callWhatsAppAPI(path, body, config = {}) {
  const url = API_BASE + path;
  console.log(`[WA API] POST ${path}:`, body);

  const axiosConfig = {
    params: { access_token: TOKEN },
    headers: {
      'Content-Type': 'application/json',
      ...(config.headers || {}),
    },
    ...config,
  };

  try {
    const resp = await axios.post(url, body, axiosConfig);
    console.log(`[WA API] ${path} respondió:`, resp.data);
    return resp.data;
  } catch (err) {
    console.error(`[WA API][ERROR] ${path}:`, err.response?.data || err.message);
    throw err;
  }
}

/** Envía un mensaje de texto por WhatsApp y lo guarda en Firestore. */
export async function sendTextMessage(phone, text) {
  const to = normalize(phone);
  await callWhatsAppAPI('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  });

  // Guardar en Firestore
  const q = await db.collection('leads')
                  .where('telefono', '==', to)
                  .limit(1)
                  .get();
  if (!q.empty) {
    const leadId = q.docs[0].id;
    const msgData = {
      content: text,
      sender: 'business',
      timestamp: new Date()
    };
    await db.collection('leads').doc(leadId).collection('messages').add(msgData);
    await db.collection('leads').doc(leadId).update({ lastMessageAt: msgData.timestamp });
  }
}

/** Envía un mensaje de audio (ID o URL) por WhatsApp y lo guarda en Firestore. */
export async function sendAudioMessage(phone, media) {
  const to = normalize(phone);
  const audioField = media.startsWith('http')
    ? { link: media }
    : { id: media };

  await callWhatsAppAPI('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: audioField
  });

  // Guardar en Firestore
  const q = await db.collection('leads')
                  .where('telefono', '==', to)
                  .limit(1)
                  .get();
  if (!q.empty) {
    const leadId = q.docs[0].id;
    const msgData = {
      content:   '',
      mediaType: 'audio',
      mediaId:   media,
      sender:    'business',
      timestamp: new Date()
    };
    await db.collection('leads').doc(leadId).collection('messages').add(msgData);
    await db.collection('leads').doc(leadId).update({ lastMessageAt: msgData.timestamp });
  }
}

/** Envía un mensaje de vídeo (ID o URL) por WhatsApp y lo guarda en Firestore. */
export async function sendVideoMessage(phone, media) {
    const to = normalize(phone);
    const videoField = media.startsWith('http')
      ? { link: media }
      : { id: media };
  
    await callWhatsAppAPI('/messages', {
      messaging_product: 'whatsapp',
      to,
      type: 'video',
      video: videoField
    });
  
    // Guardar en Firestore
    const q = await db.collection('leads')
                    .where('telefono', '==', to)
                    .limit(1)
                    .get();
    if (!q.empty) {
      const leadId = q.docs[0].id;
      const msgData = {
        content:   '',
        mediaType: 'video',
        mediaUrl:  media,
        sender:    'business',
        timestamp: new Date()
      };
      await db.collection('leads').doc(leadId).collection('messages').add(msgData);
      await db.collection('leads').doc(leadId).update({ lastMessageAt: msgData.timestamp });
    }
  }


   
/** Envía un documento (PDF, DOCX, etc.) por WhatsApp y lo guarda en Firestore. */
export async function sendDocumentMessage(phone, media) {
  const to = normalize(phone);

  // — Extraemos el nombre del archivo de la URL —
  // Por ejemplo, ".../uploads/mi-archivo.pdf?token=..." → "mi-archivo.pdf"
  const urlPath = media.split('?')[0];
  const filename = decodeURIComponent(urlPath.substring(urlPath.lastIndexOf('/') + 1));

  // — Llamada a WhatsApp Cloud API con filename —
  await callWhatsAppAPI('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: {
      link: media,
      filename
    }
  });

  // — Guardar en Firestore igual que con audio y video —
  const q = await db.collection('leads')
                  .where('telefono', '==', to)
                  .limit(1)
                  .get();
  if (!q.empty) {
    const leadId = q.docs[0].id;
    const msgData = {
      content:   '',
      mediaType: 'document',
      mediaUrl:  media,
      sender:    'business',
      timestamp: new Date()
    };
    await db.collection('leads').doc(leadId).collection('messages').add(msgData);
    await db.collection('leads').doc(leadId).update({ lastMessageAt: msgData.timestamp });
  }
}



  /**
 * Envía un mensaje de plantilla de WhatsApp con componentes dinámicos.
 */
  export async function sendTemplateMessage({ to, templateName, language, components }) {
    // Construimos el payload mínimo
    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        // sólo incluimos components si hay al menos un parámetro
        ...(components && components.length > 0
           ? { components }
           : {})
      }
    };
    await callWhatsAppAPI('/messages', payload);
  }
  