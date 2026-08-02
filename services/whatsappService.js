const { getDb } = require('../database/tenantDatabase');
const {
  PAYMENT_LABELS,
  VEHICLE_CATEGORY_LABELS,
  formatMoney,
  formatPhone,
  normalizePhone
} = require('../utils/helpers');

const GRAPH_URL = String(process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');
const TOKEN = String(process.env.WHATSAPP_TOKEN || '').trim();
const PHONE_NUMBER_ID = String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();

function isConfigured() {
  return Boolean(TOKEN && PHONE_NUMBER_ID);
}

function fmtDateBR(dateStr) {
  const d = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function fmtDuration(minutes) {
  const m = Number(minutes || 0);
  if (!m) return '';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h && rest) return `${h}h${String(rest).padStart(2, '0')}`;
  if (h) return `${h}h`;
  return `${m} min`;
}

function getCompanyName() {
  const db = getDb();
  const s = db.prepare('SELECT company_name FROM company_settings WHERE id = 1').get();
  return (s && s.company_name) || 'Torque Detail';
}

function getPaymentLabel(appointment) {
  const key = String(appointment.payment_method || 'local').toLowerCase();
  return PAYMENT_LABELS[key] || 'Pagamento no local';
}

function vehicleDescription(a) {
  let text = `${a.vehicle_brand || ''} ${a.vehicle_model || ''}`.trim();
  if (a.vehicle_year) text += ` (${a.vehicle_year})`;
  return text;
}

function buildConfirmationMessage(a) {
  const company = getCompanyName();
  const lines = [];
  lines.push(`*${company}*`);
  lines.push('*Seu agendamento foi confirmado!*');
  lines.push('');
  lines.push(`Olá, ${a.customer_name}!`);
  lines.push('');
  lines.push(`Código: *${a.appointment_code}*`);
  lines.push(`Data: *${fmtDateBR(a.appointment_date)}*`);
  lines.push(`Horário: *${a.start_time} às ${a.end_time}*`);
  if (a.booked_duration_minutes) lines.push(`Duração: ${fmtDuration(a.booked_duration_minutes)}`);
  lines.push('');
  lines.push(`Serviço: ${a.service_name}`);
  lines.push(`Veículo: ${vehicleDescription(a)}`);
  if (a.unit_name) lines.push(`Unidade: ${a.unit_name}`);
  if (a.modality_name) lines.push(`Modalidade: ${a.modality_name}`);
  lines.push(`Valor: *${formatMoney(a.total_price)}*`);
  lines.push(`Pagamento: ${getPaymentLabel(a)}`);
  lines.push('');
  lines.push('Agradecemos a preferência e esperamos você!');

  return lines.join('\n');
}

function buildStoreNotificationMessage(a) {
  const lines = [];
  lines.push('*Novo agendamento recebido*');
  lines.push('');
  lines.push(`Código: ${a.appointment_code}`);
  lines.push(`Cliente: ${a.customer_name}`);
  lines.push(`Telefone: ${formatPhone(a.customer_phone)}`);
  lines.push(`Veículo: ${vehicleDescription(a)}`);
  lines.push(`Serviço: ${a.service_name}`);
  if (a.unit_name) lines.push(`Unidade: ${a.unit_name}`);
  if (a.modality_name) lines.push(`Modalidade: ${a.modality_name}`);
  lines.push(`Data: ${fmtDateBR(a.appointment_date)}`);
  lines.push(`Horário: ${a.start_time} às ${a.end_time}`);
  if (a.booked_duration_minutes) lines.push(`Duração: ${fmtDuration(a.booked_duration_minutes)}`);
  lines.push(`Valor: ${formatMoney(a.total_price)}`);
  lines.push(`Pagamento: ${getPaymentLabel(a)}`);
  lines.push('');
  lines.push('Acesse o painel para confirmar.');

  return lines.join('\n');
}

async function sendTextMessage(to, text) {
  if (!isConfigured()) {
    console.warn('[whatsapp] Não configurado (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID ausentes). Mensagem não enviada.');
    return { skipped: true, reason: 'not_configured' };
  }

  const phone = normalizePhone(to);
  if (!phone) {
    console.warn('[whatsapp] Destinatário sem telefone válido. Mensagem não enviada.');
    return { skipped: true, reason: 'invalid_recipient' };
  }

  const response = await fetch(`${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: text }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (data.error && data.error.message) || `HTTP ${response.status}`;
    console.error(`[whatsapp] Falha no envio para ${phone}: ${message}`);
    return { error: true, status: response.status, message };
  }
  return { ok: true, id: data.messages && data.messages[0] && data.messages[0].id };
}

async function notifyAppointmentConfirmed(appointment) {
  const text = buildConfirmationMessage(appointment);
  return sendTextMessage(appointment.customer_phone, text);
}

async function notifyStoreNewAppointment(appointment) {
  const db = getDb();
  const settings = db.prepare('SELECT whatsapp, phone FROM company_settings WHERE id = 1').get() || {};
  const storePhone = settings.whatsapp || settings.phone;
  if (!storePhone) {
    console.warn('[whatsapp] WhatsApp da loja não cadastrado nas configurações. Aviso não enviado.');
    return { skipped: true, reason: 'no_store_phone' };
  }
  const text = buildStoreNotificationMessage(appointment);
  return sendTextMessage(storePhone, text);
}

module.exports = {
  isConfigured,
  sendTextMessage,
  notifyAppointmentConfirmed,
  notifyStoreNewAppointment,
  buildConfirmationMessage,
  buildStoreNotificationMessage
};
