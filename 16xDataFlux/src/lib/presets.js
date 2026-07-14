// Preset legacy SQL schemas users can load with one click.

export const PRESETS = [
  {
    id: 'ecommerce',
    name: 'E-Commerce Platform',
    icon: '🛒',
    blurb: '9 tables, heavy JOIN chains on every product page load',
    sql: `-- Legacy e-commerce relational schema
CREATE TABLE customers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  phone VARCHAR(32),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE addresses (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  line1 VARCHAR(255) NOT NULL,
  city VARCHAR(80) NOT NULL,
  country VARCHAR(2) NOT NULL,
  postal_code VARCHAR(16),
  is_default BOOLEAN DEFAULT FALSE
);

CREATE TABLE categories (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(80) NOT NULL,
  parent_id INT REFERENCES categories(id)
);

CREATE TABLE products (
  id INT PRIMARY KEY AUTO_INCREMENT,
  sku VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  price_cents INT NOT NULL,
  category_id INT REFERENCES categories(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE product_images (
  id INT PRIMARY KEY AUTO_INCREMENT,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url VARCHAR(500) NOT NULL,
  position INT DEFAULT 0
);

CREATE TABLE inventory (
  id INT PRIMARY KEY AUTO_INCREMENT,
  product_id INT NOT NULL UNIQUE REFERENCES products(id),
  quantity INT NOT NULL DEFAULT 0,
  warehouse VARCHAR(40)
);

CREATE TABLE orders (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL REFERENCES customers(id),
  address_id INT REFERENCES addresses(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_cents INT NOT NULL,
  placed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
  id INT PRIMARY KEY AUTO_INCREMENT,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  quantity INT NOT NULL,
  unit_price_cents INT NOT NULL
);

CREATE TABLE reviews (
  id INT PRIMARY KEY AUTO_INCREMENT,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id INT NOT NULL REFERENCES customers(id),
  rating INT NOT NULL,
  body TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_orders_customer ON orders (customer_id);
CREATE INDEX idx_items_order ON order_items (order_id);
CREATE INDEX idx_reviews_product ON reviews (product_id);`
  },
  {
    id: 'healthcare',
    name: 'Healthcare Records',
    icon: '🏥',
    blurb: 'Patients, encounters, prescriptions — classic normalization sprawl',
    sql: `-- Hospital records schema (legacy)
CREATE TABLE patients (
  id INT PRIMARY KEY AUTO_INCREMENT,
  mrn VARCHAR(20) NOT NULL UNIQUE,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  dob DATE NOT NULL,
  blood_type VARCHAR(3)
);

CREATE TABLE physicians (
  id INT PRIMARY KEY AUTO_INCREMENT,
  npi VARCHAR(10) NOT NULL UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  specialty VARCHAR(80)
);

CREATE TABLE encounters (
  id INT PRIMARY KEY AUTO_INCREMENT,
  patient_id INT NOT NULL REFERENCES patients(id),
  physician_id INT NOT NULL REFERENCES physicians(id),
  encounter_type VARCHAR(30) NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  notes TEXT
);

CREATE TABLE diagnoses (
  id INT PRIMARY KEY AUTO_INCREMENT,
  encounter_id INT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  icd10_code VARCHAR(8) NOT NULL,
  description VARCHAR(255)
);

CREATE TABLE medications (
  id INT PRIMARY KEY AUTO_INCREMENT,
  ndc_code VARCHAR(12) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  form VARCHAR(40)
);

CREATE TABLE prescriptions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  encounter_id INT NOT NULL REFERENCES encounters(id),
  medication_id INT NOT NULL REFERENCES medications(id),
  dosage VARCHAR(60) NOT NULL,
  frequency VARCHAR(60),
  duration_days INT
);

CREATE TABLE lab_results (
  id INT PRIMARY KEY AUTO_INCREMENT,
  encounter_id INT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  test_code VARCHAR(12) NOT NULL,
  value_num DECIMAL(10,3),
  unit VARCHAR(20),
  flagged BOOLEAN DEFAULT FALSE
);

CREATE TABLE allergies (
  id INT PRIMARY KEY AUTO_INCREMENT,
  patient_id INT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  substance VARCHAR(120) NOT NULL,
  severity VARCHAR(20)
);

CREATE INDEX idx_enc_patient ON encounters (patient_id);
CREATE INDEX idx_rx_encounter ON prescriptions (encounter_id);`
  },
  {
    id: 'social',
    name: 'Social Network',
    icon: '💬',
    blurb: 'Follows, posts, likes — a graph problem trapped in tables',
    sql: `-- Social network schema (screaming to be a graph)
CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  handle VARCHAR(40) NOT NULL UNIQUE,
  display_name VARCHAR(80),
  bio TEXT,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE follows (
  follower_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE posts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  author_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE likes (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  liked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE comments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id INT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE hashtags (
  id INT PRIMARY KEY AUTO_INCREMENT,
  tag VARCHAR(60) NOT NULL UNIQUE
);

CREATE TABLE post_hashtags (
  post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  hashtag_id INT NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, hashtag_id)
);

CREATE INDEX idx_posts_author ON posts (author_id);
CREATE INDEX idx_comments_post ON comments (post_id);`
  },
  {
    id: 'banking',
    name: 'Core Banking',
    icon: '🏦',
    blurb: 'Accounts, transactions, ledgers — high-volume JOIN pressure',
    sql: `-- Core banking ledger schema
CREATE TABLE branches (
  id INT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(10) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  city VARCHAR(80)
);

CREATE TABLE customers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  national_id VARCHAR(20) NOT NULL UNIQUE,
  full_name VARCHAR(150) NOT NULL,
  segment VARCHAR(20) DEFAULT 'retail',
  branch_id INT REFERENCES branches(id)
);

CREATE TABLE accounts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  iban VARCHAR(34) NOT NULL UNIQUE,
  customer_id INT NOT NULL REFERENCES customers(id),
  account_type VARCHAR(20) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  balance_cents BIGINT NOT NULL DEFAULT 0,
  opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE transactions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  account_id INT NOT NULL REFERENCES accounts(id),
  counterparty_account_id INT REFERENCES accounts(id),
  amount_cents BIGINT NOT NULL,
  tx_type VARCHAR(20) NOT NULL,
  reference VARCHAR(140),
  executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cards (
  id INT PRIMARY KEY AUTO_INCREMENT,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pan_last4 VARCHAR(4) NOT NULL,
  network VARCHAR(12),
  expires_on DATE NOT NULL,
  status VARCHAR(12) DEFAULT 'active'
);

CREATE TABLE loans (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL REFERENCES customers(id),
  principal_cents BIGINT NOT NULL,
  interest_bps INT NOT NULL,
  term_months INT NOT NULL,
  disbursed_at TIMESTAMP
);

CREATE TABLE loan_payments (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  loan_id INT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL,
  paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tx_account ON transactions (account_id);
CREATE INDEX idx_tx_executed ON transactions (executed_at);
CREATE INDEX idx_accounts_customer ON accounts (customer_id);`
  }
];
