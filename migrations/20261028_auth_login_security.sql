CREATE TABLE IF NOT EXISTS auth_login_lockouts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lock_key VARCHAR(255) NOT NULL,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_attempt_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_auth_login_lockouts_key (lock_key),
  KEY idx_auth_login_lockouts_locked_until (locked_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_login_events (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  identifier VARCHAR(255) NOT NULL,
  outcome VARCHAR(40) NOT NULL,
  message VARCHAR(255) NULL,
  client_platform VARCHAR(32) NULL,
  ip_address VARCHAR(120) NULL,
  user_agent TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_auth_login_events_created_at (created_at),
  KEY idx_auth_login_events_user_id (user_id),
  KEY idx_auth_login_events_outcome (outcome),
  KEY idx_auth_login_events_identifier (identifier)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
