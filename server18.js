require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');

const authRoutes = require('./routes/auth');
const patientRoutes = require('./routes/patients');
const appointmentRoutes = require('./routes/appointments');
const inpatientRoutes = require('./routes/inpatient');
const inventoryRoutes = require('./routes/inventory');
const prescriptionRoutes = require('./routes/prescriptions');
const billingRoutes = require('./routes/billing');
const staffRoutes = require('./routes/staff');
const labRoutes = require('./routes/lab');
const portalRoutes = require('./routes/portal');
const notificationRoutes = require('./routes/notifications');
const shiftRoutes = require('./routes/shifts');
const reportRoutes = require('./routes/reports');
const expenseRoutes = require('./routes/expenses');
const chatRoutes = require('./routes/chat');
const treatmentRoutes = require('./routes/treatments');
const staffChatRoutes = require('./routes/staff-chat');
const paymentRoutes = require('./routes/payments');
const { init: initSocket } = require('./utils/socket');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/inpatient', inpatientRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/prescriptions', prescriptionRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/lab', labRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/shifts', shiftRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/treatments', treatmentRoutes);
app.use('/api/staff-chat', staffChatRoutes);
app.use('/api/payments', paymentRoutes);

// NOTE: uploaded lab result files are intentionally NOT served via
// express.static — they're only ever handed out through the authenticated
// GET /api/lab/results/:id/file route, which checks ownership first.

// Fallback 404
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Central error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);
initSocket(server);
server.listen(PORT, () => {
  console.log(`Yoma API running on http://localhost:${PORT}`);
  console.log(`Websocket notifications active on the same port.`);
});
