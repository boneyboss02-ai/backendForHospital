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
// Revenue/appointment/utilization figures are visible to admin and
// receptionist (same access as Billing). Expenses and profit are
// admin-only — what the clinic pays staff isn't receptionist's business —
// so those fields are simply omitted from the response for anyone else.
router.get('/overview', authenticate, authorize('admin', 'receptionist'), async (req, res) => {
  const { from, to } = dateRange(req);
  const isAdmin = req.user.role === 'admin';

  try {
    const [revenue, invoicesIssued, newPatients, apptsByStatus, apptsByDoctor, revenueByDay, lowStock, chairUtilization, expensesTotal, expensesByCategory, suppliesCost] = await Promise.all([
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
      isAdmin
        ? db.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE expense_date BETWEEN $1 AND $2`, [from, to])
        : Promise.resolve({ rows: [{ total: 0 }] }),
      isAdmin
        ? db.query(
            `SELECT category, COALESCE(SUM(amount), 0) AS total
             FROM expenses WHERE expense_date BETWEEN $1 AND $2
             GROUP BY category ORDER BY total DESC`,
            [from, to]
          )
        : Promise.resolve({ rows: [] }),
      isAdmin
        ? db.query(
            `SELECT COALESCE(SUM(iu.quantity * i.unit_price), 0) AS total
             FROM inventory_usage iu JOIN inventory_items i ON i.id = iu.item_id
             WHERE iu.used_at BETWEEN $1 AND $2`,
            [from, to]
          )
        : Promise.resolve({ rows: [{ total: 0 }] }),
    ]);

    const revenueTotal = Number(revenue.rows[0].total);
    const expensesTotalNum = Number(expensesTotal.rows[0].total);
    // What medicine/supplies were actually consumed cost, valued at
    // today's unit_price (inventory_usage doesn't snapshot the price at
    // the moment it was used, so — like the profitability report below —
    // this is an approximation if prices have changed since). This is the
    // piece that was missing from `profit` before: it only ever subtracted
    // expenses, never what treatments actually cost in supplies.
    const suppliesCostNum = Number(suppliesCost.rows[0].total);

    res.json({
      range: { from, to },
      revenue: revenueTotal,
      invoices_issued: { count: Number(invoicesIssued.rows[0].count), total: Number(invoicesIssued.rows[0].total) },
      new_patients: Number(newPatients.rows[0].count),
      appointments_by_status: apptsByStatus.rows.map((r) => ({ status: r.status, count: Number(r.count) })),
      appointments_by_doctor: apptsByDoctor.rows.map((r) => ({ doctor_name: r.doctor_name, count: Number(r.count) })),
      revenue_by_day: revenueByDay.rows.map((r) => ({ day: r.day, total: Number(r.total) })),
      low_stock_count: Number(lowStock.rows[0].count),
      chair_utilization: chairUtilization.rows.map((r) => ({
        room_name: r.room_name, occupied: Number(r.occupied), total: Number(r.total),
      })),
      ...(isAdmin ? {
        expenses: expensesTotalNum,
        expenses_by_category: expensesByCategory.rows.map((r) => ({ category: r.category, total: Number(r.total) })),
        cost_of_supplies: suppliesCostNum,
        // Staff wages aren't tracked as their own thing anywhere in this
        // app — there's no payroll table. If you want them counted here,
        // log them as an Expense (any category works, e.g. "payroll") and
        // they'll already be included in `expenses` and this profit figure.
        profit: revenueTotal - expensesTotalNum - suppliesCostNum,
      } : {}),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error building report' });
  }
});

// GET /api/reports/profitability?from=&to=&doctor_id=&patient_id=
// Admin-only — the "clean teeth for 1500, 300 was chemicals, 1200 profit"
// view. Per completed visit: revenue is what was actually invoiced for that
// appointment (consultation fee + any procedure charges), cost is what the
// inventory used during that visit is worth at today's unit_price (this is
// an approximation — inventory_usage doesn't snapshot the price at the time
// it was used, so if a cost changes later, past reports will reflect the
// new price, not the historical one). Combined with expenses for the same
// range to give a true net profit, not just gross margin on procedures.
router.get('/profitability', authenticate, authorize('admin'), async (req, res) => {
  const { from, to } = dateRange(req);
  const { doctor_id, patient_id } = req.query;

  const conditions = [`a.status = 'completed'`, `a.scheduled_at BETWEEN $1 AND $2`];
  const values = [from, to];
  let i = 3;
  if (doctor_id) { conditions.push(`a.doctor_id = $${i++}`); values.push(doctor_id); }
  if (patient_id) { conditions.push(`a.patient_id = $${i++}`); values.push(patient_id); }

  try {
    const [visits, expensesTotal] = await Promise.all([
      db.query(
        `SELECT a.id AS appointment_id, a.scheduled_at, p.full_name AS patient_name, u.full_name AS doctor_name,
                COALESCE(rev.total_revenue, 0) AS revenue,
                COALESCE(cost.total_cost, 0) AS cost
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         JOIN users u ON u.id = a.doctor_id
         LEFT JOIN (
           SELECT appointment_id, SUM(total_amount) AS total_revenue
           FROM invoices WHERE appointment_id IS NOT NULL GROUP BY appointment_id
         ) rev ON rev.appointment_id = a.id
         LEFT JOIN (
           SELECT iu.appointment_id, SUM(iu.quantity * i.unit_price) AS total_cost
           FROM inventory_usage iu JOIN inventory_items i ON i.id = iu.item_id
           GROUP BY iu.appointment_id
         ) cost ON cost.appointment_id = a.id
         WHERE ${conditions.join(' AND ')}
         ORDER BY a.scheduled_at DESC`,
        values
      ),
      db.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE expense_date BETWEEN $1 AND $2`, [from, to]),
    ]);

    const rows = visits.rows.map((v) => {
      const revenue = Number(v.revenue);
      const cost = Number(v.cost);
      return { ...v, revenue, cost, profit: revenue - cost };
    });
    const grossRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);
    const grossCost = rows.reduce((sum, r) => sum + r.cost, 0);
    const grossProfit = grossRevenue - grossCost;
    const expenses = Number(expensesTotal.rows[0].total);

    res.json({
      range: { from, to },
      visits: rows,
      summary: {
        gross_revenue: grossRevenue,
        cost_of_supplies: grossCost,
        gross_profit: grossProfit,
        expenses,
        net_profit: grossProfit - expenses,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error building profitability report' });
  }
});

module.exports = router;
