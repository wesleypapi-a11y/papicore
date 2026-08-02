require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

require('./database/database');

const agendamentosRouter = require('./routes/agendamentos');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const { requireAuth } = require('./middlewares/auth');
const errorHandler = require('./middlewares/errorHandler');

const app = express();

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', agendamentosRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin', requireAuth, adminRouter);

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Rota não encontrada.' });
});

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
