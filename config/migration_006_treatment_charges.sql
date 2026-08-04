-- ============================================
-- Migration 006: Treatment charges + inventory usage tracking
-- Run once against an existing database, in order after migration_005.
-- ============================================

-- When a doctor completes a visit and says "I used 2 aspirin and a
-- filling", this records exactly what was used, by whom, and when —
-- separate from the invoice (this is not billed; it's inventory
-- consumption). Feeds into the patient's full history and gives an audit
-- trail for stock levels. Doctors can only consume via this path — adding
-- or restocking inventory stays admin/nurse only (routes/inventory.js).
CREATE TABLE inventory_usage (
    id SERIAL PRIMARY KEY,
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
    item_id INTEGER REFERENCES inventory_items(id),
    quantity INTEGER NOT NULL,
    used_by INTEGER REFERENCES users(id),
    used_at TIMESTAMP DEFAULT NOW()
);
