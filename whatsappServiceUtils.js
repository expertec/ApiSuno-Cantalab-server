// whatsappServiceUtils.js
import axios from 'axios';
const TOKEN   = process.env.WHATSAPP_TOKEN;
const PHONEID = process.env.PHONE_NUMBER_ID;
const API_BASE = `https://graph.facebook.com/v15.0/${PHONEID}`;

export function normalize(phone) {
  let num = String(phone).replace(/\D/g, '');
  if (num.length === 10) num = '52' + num;
  return num;
}

export async function callWhatsAppAPI(path, body, config = {}) {
  const url = API_BASE + path;
  const resp = await axios.post(url, body, {
    params: { access_token: TOKEN },
    ...config
  });
  return resp.data;
}

export async function uploadMedia(filePath, mimeType) {
  // subir el blob/archivo a /media
  const FormData = await import('form-data').then(m => m.default);
  const fs       = await import('fs').then(m => m.default);
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('type', mimeType);
  const data = await callWhatsAppAPI('/media', form, {
    headers: form.getHeaders()
  });
  return data.id;
}
