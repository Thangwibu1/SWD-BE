-- E-commerce SUT schema: exactly five business tables (guide section 6.1).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(255) NOT NULL,
  password_hash text NOT NULL,
  role varchar(20) NOT NULL DEFAULT 'customer'
    CHECK (role IN ('customer','admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_users_email_lower ON users (lower(email));

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku varchar(64) NOT NULL UNIQUE,
  name varchar(255) NOT NULL,
  category varchar(80) NOT NULL,
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_products_category_active ON products(category,is_active);

CREATE TABLE inventory (
  product_id uuid PRIMARY KEY REFERENCES products(id),
  available_quantity integer NOT NULL CHECK (available_quantity >= 0),
  reserved_quantity integer NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  status varchar(24) NOT NULL
    CHECK (status IN ('PENDING','CONFIRMED','CANCELLED','FAILED')),
  payment_status varchar(24) NOT NULL
    CHECK (payment_status IN ('NOT_REQUIRED','PENDING','PAID','FAILED','REFUNDED')),
  total_amount numeric(12,2) NOT NULL CHECK (total_amount >= 0),
  idempotency_key varchar(80) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_orders_user_created ON orders(user_id,created_at DESC);
CREATE INDEX ix_orders_status ON orders(status);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  UNIQUE(order_id,product_id)
);
CREATE INDEX ix_order_items_order ON order_items(order_id);
