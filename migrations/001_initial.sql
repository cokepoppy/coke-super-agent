CREATE TABLE IF NOT EXISTS tenants (
  id CHAR(36) NOT NULL PRIMARY KEY,
  slug VARCHAR(64) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  username VARCHAR(120) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(180) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY users_id_tenant (id, tenant_id),
  CONSTRAINT users_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY sessions_expiry_idx (expires_at),
  CONSTRAINT sessions_user_tenant_fk FOREIGN KEY (user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS threads (
  id CHAR(36) NOT NULL PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  title VARCHAR(160) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY threads_id_tenant (id, tenant_id),
  KEY threads_tenant_updated_idx (tenant_id, updated_at),
  CONSTRAINT threads_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS runs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  thread_id CHAR(36) NOT NULL,
  status ENUM('queued','working','waiting_for_user','done','failed','stopped') NOT NULL DEFAULT 'queued',
  prompt TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY runs_id_tenant (id, tenant_id),
  KEY runs_tenant_created_idx (tenant_id, created_at),
  CONSTRAINT runs_thread_tenant_fk FOREIGN KEY (thread_id, tenant_id) REFERENCES threads(id, tenant_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS messages (
  id CHAR(36) NOT NULL PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  thread_id CHAR(36) NOT NULL,
  run_id CHAR(36) NULL,
  role ENUM('user','assistant','system') NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY messages_tenant_thread_created_idx (tenant_id, thread_id, created_at),
  CONSTRAINT messages_thread_tenant_fk FOREIGN KEY (thread_id, tenant_id) REFERENCES threads(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT messages_run_tenant_fk FOREIGN KEY (run_id, tenant_id) REFERENCES runs(id, tenant_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS run_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  run_id CHAR(36) NOT NULL,
  sequence_no INT UNSIGNED NOT NULL,
  event_type VARCHAR(48) NOT NULL,
  payload JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY run_events_sequence_unique (run_id, sequence_no),
  KEY run_events_tenant_cursor_idx (tenant_id, run_id, id),
  CONSTRAINT run_events_run_tenant_fk FOREIGN KEY (run_id, tenant_id) REFERENCES runs(id, tenant_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS computers (
  tenant_id CHAR(36) NOT NULL PRIMARY KEY,
  sandbox_id VARCHAR(96) NULL UNIQUE,
  template_id VARCHAR(120) NULL,
  state ENUM('not_created','creating','running','paused','failed') NOT NULL DEFAULT 'not_created',
  generation INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT computers_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
