-- Migration: create counters and commercial_quotations tables

CREATE TABLE IF NOT EXISTS counters (
  name VARCHAR(64) PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS commercial_quotations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  quotation_number VARCHAR(64) NOT NULL UNIQUE,
  consecutive BIGINT NOT NULL,
  commercial_initials VARCHAR(16) NOT NULL,
  suffix CHAR(1) NOT NULL,
  visit_id INT NULL,
  project_id INT NULL,
  budget DECIMAL(15,2) NOT NULL DEFAULT 0,
  status ENUM('cotizado','aprobado','rechazado') NOT NULL DEFAULT 'cotizado',
  approved_value DECIMAL(15,2) NULL,
  approval_date DATETIME NULL,
  billing_date DATETIME NULL,
  billed_value DECIMAL(15,2) NULL,
  observations TEXT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_visit_id (visit_id),
  INDEX idx_project_id (project_id)
);

-- Optional: initialize counter to a known value
INSERT INTO counters (name, value)
SELECT 'quotation', 0
WHERE NOT EXISTS (SELECT 1 FROM counters WHERE name = 'quotation');
