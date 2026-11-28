CREATE TABLE IF NOT EXISTS proactive_rules (
  id CHAR(36) NOT NULL PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  prompt TEXT NOT NULL,
  interval_minutes INT UNSIGNED NOT NULL,
  execution_mode ENUM('observe','active') NOT NULL DEFAULT 'observe',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  next_run_at TIMESTAMP(3) NOT NULL,
  last_triggered_at TIMESTAMP(3) NULL DEFAULT NULL,
  last_outcome VARCHAR(32) NULL DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY proactive_rules_id_tenant (id, tenant_id),
  KEY proactive_rules_due_idx (enabled, next_run_at),
  KEY proactive_rules_tenant_idx (tenant_id, updated_at),
  CONSTRAINT proactive_rules_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS proactive_occurrences (
  id CHAR(36) NOT NULL PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  rule_id CHAR(36) NOT NULL,
  rule_name VARCHAR(120) NOT NULL,
  mandate TEXT NOT NULL,
  scheduled_for TIMESTAMP(3) NOT NULL,
  outcome ENUM('observed','queued','skipped_busy') NOT NULL,
  run_id CHAR(36) NULL DEFAULT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY proactive_occurrences_rule_schedule (rule_id, scheduled_for),
  UNIQUE KEY proactive_occurrences_id_tenant (id, tenant_id),
  KEY proactive_occurrences_tenant_created_idx (tenant_id, created_at),
  KEY proactive_occurrences_rule_created_idx (rule_id, created_at),
  CONSTRAINT proactive_occurrences_rule_tenant_fk FOREIGN KEY (rule_id, tenant_id)
    REFERENCES proactive_rules(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT proactive_occurrences_run_tenant_fk FOREIGN KEY (run_id, tenant_id)
    REFERENCES runs(id, tenant_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
