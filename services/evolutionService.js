/*
 * evolutionService.js (DEPRECADO — shim de compatibilidade)
 *
 * A arquitetura atual é: Controller → whatsappService → provider ativo
 * (mock | evolution). Nenhum controller importa mais este módulo.
 *
 * Este arquivo mantém a API antiga (usada por testes legados e código
 * antigo) repassando para o whatsappService e o evolutionProvider. Não deve
 * ser usado em código novo.
 */

'use strict';

const service = require('./whatsapp/whatsappService');
const evolutionProvider = require('./whatsapp/providers/evolutionProvider');
const core = require('../database/coreDatabase');

module.exports = {
  INSTANCE_STATUSES: evolutionProvider.INSTANCE_STATUSES,
  DEFAULT_INSTANCE_NAME: evolutionProvider.DEFAULT_INSTANCE_NAME,
  getStatus: () => {
    const s = service.getWhatsappSettings();
    return {
      configured: service.isConfigured(),
      enabled: Boolean(s && s.enabled),
      server_url: (s && s.server_url) || '',
      mock: !(s && s.enabled)
    };
  },
  isConfigured: service.isConfigured,
  sanitizeSettings: evolutionProvider.sanitizeSettings,
  toInternationalPhone: evolutionProvider.toInternationalPhone,
  instanceNameFromDatabaseName: service.instanceNameFromDatabaseName,
  instanceNameFromDb: service.instanceNameFromDb,
  connectionState: service.connectionState,
  connect: service.connect,
  reconnect: service.reconnect,
  disconnect: service.disconnect,
  testConnection: service.testConnection,
  sendTextMessage: service.sendTextMessage,
  refreshStatus: service.refreshStatus,
  overview: service.overview,
  getEvolutionSettings: service.getEvolutionSettings,
  getEvolutionInstanceByDatabaseName: core.getEvolutionInstanceByDatabaseName,
  getEvolutionInstance: core.getEvolutionInstance,
  getTenantById: core.getTenantById
};
