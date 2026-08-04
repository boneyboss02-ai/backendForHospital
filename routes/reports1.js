const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Functional/operational reporting — revenue, visit volume, doctor
// workload, chair utilization, low stock. Same access as Billing, since
// revenue is financial data. Medical reports (per-patient clinical
// history) live at GET /api/patients/:id/history instead — this route is
// clinic-wide numbers, not patient-specific records.

function dateRange(req) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  // include the full "to" day
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

// GET /api/reports/overview?from=YYYY-MM-DD&to=YYYY-MM-DD (defaults to last 30 days)
router.get('/overview', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  const { from, to } = dateRange(req);

  try {
    const [revenue, invoicesIssued, newPatients, apptsByStatus, apptsByDoctor, revenueByDay, lowStock, chairUtilization] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE paid_at BETWEEN $1 AND $2`, [from, to]),
      db.query(`SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS total FROM invoices WHERE created_at BETWEEN $1 AND $2`, [from, to]),
      db.query(`SELECT COUNT(*) AS count FROM patients WHERE created_at BETWEEN $1 AND $2`, [from, to]),
      db.query(
        `SELECT status, COUNT(*) AS count FROM appointments WHERE scheduled_at BETWEEN $1 AND $2 GROUP BY status`,
        [from, to]
      ),
      db.query(
        `SELECT u.full_name AS doctor_name, COUNT(*) AS count
         FROM appointments a JOIN users u ON u.id = a.doctor_id
         WHERE a.scheduled_at BETWEEN $1 AND $2
         GROUP BY u.full_name ORDER BY count DESC LIMIT 10`,
        [from, to]
      ),
      db.query(
        `SELECT DATE(paid_at) AS day, COALESCE(SUM(amount), 0) AS total
         FROM payments WHERE paid_at BETWEEN $1 AND $2
         GROUP BY DATE(paid_at) ORDER BY day`,
        [from, to]
      ),
      db.query(`SELECT COUNT(*) AS count FROM inventory_items WHERE stock_quantity <= reorder_level`),
      db.query(
        `SELECT w.name AS room_name, COUNT(*) FILTER (WHERE b.status = 'occupied') AS occupied, COUNT(*) AS total
         FROM beds b JOIN wards w ON w.id = b.ward_id
         GROUP BY w.name ORDER BY w.name`
      ),
    ]);

    res.json({
      range: { from, to },
      revenue: Number(revenue.rows[0].total),
      invoices_issued: { count: Number(invoicesIssued.rows[0].count), total: Number(invoicesIssued.rows[0].total) },
      new_patients: Number(newPatients.rows[0].count),
      appointments_by_status: apptsByStatus.rows.map((r) => ({ status: r.status, count: Number(r.count) })),
      appointments_by_doctor: apptsByDoctor.rows.map((r) => ({ doctor_name: r.doctor_name, count: Number(r.count) })),
      revenue_by_day: revenueByDay.rows.map((r) => ({ day: r.day, total: Number(r.total) })),
      low_stock_count: Number(lowStock.rows[0].count),
      chair_utilization: chairUtilization.rows.map((r) => ({
        room_name: r.room_name, occupied: Number(r.occupied), total: Number(r.total),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error building report' });
  }
});

module.exports = router;
