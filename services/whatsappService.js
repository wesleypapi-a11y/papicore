/*
 * whatsappService.js (shim de compatibilidade)
 *
 * A lógica agora vive em services/whatsapp/whatsappService.js. Este arquivo
 * só repassa os exports para não quebrar require('services/whatsappService').
 */

'use strict';

module.exports = require('./whatsapp/whatsappService');
