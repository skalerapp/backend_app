-- Full commercial schema: clients, projects (partial), visits, nearby_places, visit_nearby_places, quotations, counters, orders(ot), visit_locations, audit_logs

-- clients
CREATE TABLE IF NOT EXISTS clients (
  id INT PRIMARY KEY AUTO_INCREMENT,
  client_type ENUM('juridica','natural') NOT NULL,
  nit VARCHAR(80) NOT NULL,
  business_name VARCHAR(255) NOT NULL,
  city VARCHAR(120),
  billing_email VARCHAR(255),
  contact_name VARCHAR(150),
  contact_phone VARCHAR(50),
  areas JSON NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_clients_nit (nit)
);

-- projects (partial, ensure compatible with existing projects table)
CREATE TABLE IF NOT EXISTS projects_minimal (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  client_id INT NULL,
  category VARCHAR(100),
  subcategory VARCHAR(100),
  planned_start DATE NULL,
  planned_end DATE NULL,
  status ENUM('draft','active','on_hold','completed','cancelled') DEFAULT 'draft',
  budget DECIMAL(15,2) NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_projects_client (client_id)
);

-- commercial visits (ensure existing table kept)
CREATE TABLE IF NOT EXISTS commercial_visits (
  id INT PRIMARY KEY AUTO_INCREMENT,
  project_id INT NULL,
  client_id INT NULL,
  client_name VARCHAR(160) NOT NULL,
  client_contact VARCHAR(160) NULL,
  commercial_id INT NULL,
  visit_date DATETIME NOT NULL,
  city VARCHAR(120),
  service_scope TEXT NULL,
  site_conditions TEXT NULL,
  access_types VARCHAR(255) NULL,
  delivery_time_estimate VARCHAR(128) NULL,
  will_generate_quotation TINYINT(1) DEFAULT 0,
  form_type VARCHAR(80) NULL,
  form_payload LONGTEXT NULL,
  summary TEXT NULL,
  outcome TEXT NULL,
  next_action TEXT NULL,
  next_action_date DATE NULL,
  evidence_path VARCHAR(500) NULL,
  expense_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  status ENUM('planned','completed','follow_up','cancelled') NOT NULL DEFAULT 'planned',
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  recorded_at DATETIME NULL,
  recorded_by INT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_visits_project (project_id),
  INDEX idx_visits_client (client_id),
  INDEX idx_visits_date (visit_date)
);

-- nearby places
CREATE TABLE IF NOT EXISTS nearby_places (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(80) NULL,
  address VARCHAR(255) NULL,
  phone VARCHAR(50) NULL,
  notes TEXT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS visit_nearby_places (
  id INT PRIMARY KEY AUTO_INCREMENT,
  visit_id INT NOT NULL,
  nearby_place_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_vnp_visit (visit_id),
  INDEX idx_vnp_place (nearby_place_id)
);

-- counters
CREATE TABLE IF NOT EXISTS counters (
  name VARCHAR(64) PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);

INSERT INTO counters (name, value)
SELECT 'quotation', 0
WHERE NOT EXISTS (SELECT 1 FROM counters WHERE name = 'quotation');

-- commercial_quotations
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
  INDEX idx_quot_visit (visit_id),
  INDEX idx_quot_project (project_id)
);

-- orders (OT) minimal
CREATE TABLE IF NOT EXISTS orders_ot (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  ot_code VARCHAR(128) UNIQUE,
  quotation_id BIGINT NULL,
  assigned_by INT NULL,
  assigned_at DATETIME NULL,
  status ENUM('open','in_progress','closed') DEFAULT 'open',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  entity_type VARCHAR(80) NOT NULL,
  entity_id BIGINT NULL,
  action VARCHAR(80) NOT NULL,
  data_json LONGTEXT NULL,
  performed_by INT NULL,
  performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- optional visit_locations table (if separate storage desired)
CREATE TABLE IF NOT EXISTS visit_locations (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  visit_id INT NOT NULL,
  lat DECIMAL(10,7) NOT NULL,
  lng DECIMAL(10,7) NOT NULL,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  recorded_by INT NULL
);

-- FK constraints can be added post-migration if desired
