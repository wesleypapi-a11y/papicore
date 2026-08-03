function errorHandler(err, req, res, next) {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido no corpo da requisição.' });
  }

  if (err && err.name === 'MulterError') {
    /* Quando o limite de tamanho estoura, o multer aborta a leitura do corpo
       da requisição imediatamente. Se o navegador ainda estiver enviando o
       arquivo nesse momento, a conexão é encerrada antes que ele receba esta
       resposta — e o fetch() do navegador reporta isso como "Failed to
       fetch" em vez de entregar a mensagem de erro. Drenar o restante do
       corpo antes de responder evita esse encerramento abrupto. */
    if (!req.readableEnded) req.resume();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'O arquivo excede o tamanho permitido.'
      : 'Falha no envio do arquivo.';
    return res.status(400).json({ error: message });
  }

  if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({
      error: 'Já existe um agendamento para esta unidade, data e horário.'
    });
  }

  if (err && err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(400).json({ error: 'Unidade informada não existe.' });
  }

  if (err && err.code === 'SQLITE_CONSTRAINT') {
    return res.status(400).json({ error: 'Conflito ao salvar os dados no banco.' });
  }

  const status = err.status || 500;
  const message = status === 500 ? 'Erro interno do servidor.' : err.message;

  if (status === 500) {
    console.error('[ERROR]', err);
  }

  return res.status(status).json({ error: message });
}

module.exports = errorHandler;
