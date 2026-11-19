ALTER TABLE computers
  ADD COLUMN desktop_state ENUM('pending','installing','ready','failed') NOT NULL DEFAULT 'pending' AFTER state,
  ADD COLUMN desktop_updated_at TIMESTAMP(3) NULL DEFAULT NULL AFTER desktop_state;
