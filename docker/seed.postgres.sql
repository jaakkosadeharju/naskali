-- PostgreSQL version of the `shop` sample data (see seed.sql for MySQL).
-- Runs as user `dev` in database `shop` on first container start.

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  attributes JSONB
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  product_id INT NOT NULL REFERENCES products(id),
  quantity INT NOT NULL,
  ordered_at TIMESTAMP NOT NULL
);
CREATE INDEX orders_customer_id ON orders(customer_id);
CREATE INDEX orders_product_id ON orders(product_id);

CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  payload JSONB,
  raw_body TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
COMMENT ON TABLE events IS 'Event log with JSON payloads';

INSERT INTO customers (name, email)
SELECT 'Customer ' || n, 'customer' || n || '@example.com' FROM generate_series(1, 1000) AS n ORDER BY n;

INSERT INTO products (sku, name, price, attributes)
SELECT 'SKU-' || lpad(n::text, 5, '0'), 'Product ' || n, round(1 + ((n * 7919) % 19900) / 100.0, 2),
       jsonb_build_object('color', (ARRAY['red', 'green', 'blue', 'black'])[1 + n % 4], 'weight_kg', n % 10)
FROM generate_series(1, 200) AS n ORDER BY n;

INSERT INTO orders (customer_id, product_id, quantity, ordered_at)
SELECT 1 + n % 1000, 1 + (n * 7) % 200, 1 + n % 5, now() - make_interval(days => n % 730)
FROM generate_series(1, 50000) AS n ORDER BY n;

INSERT INTO events (type, payload, raw_body) VALUES
('order.created',
 jsonb_build_object('order_id', 1, 'customer', jsonb_build_object('id', 2, 'name', 'Customer 2', 'vip', true),
   'items', jsonb_build_array(jsonb_build_object('sku', 'SKU-00008', 'qty', 2, 'price', 12.5), jsonb_build_object('sku', 'SKU-00015', 'qty', 1, 'price', 99.0)),
   'coupon', NULL, 'tags', jsonb_build_array('web', 'first-order'),
   'meta', '{"source":"webhook","retries":[1,2],"headers":{"x-request-id":"a1b2c3"}}'),
 E'{\n  "event": "order.created",\n  "signature": "sha256=9f86d08",\n  "delivered": true\n}'),
('customer.updated',
 jsonb_build_object('customer_id', 7, 'changes', jsonb_build_object('email', jsonb_build_array('old7@example.com', 'customer7@example.com')),
   'actor', jsonb_build_object('type', 'admin', 'name', 'Märta Ångström 👩‍💻')),
 E'Customer 7 updated their e-mail address via the account page.\nNo further action needed.'),
('inventory.snapshot',
 (SELECT jsonb_build_object('warehouse', 'HEL-1', 'counts',
           jsonb_agg(jsonb_build_object('sku', 'SKU-' || lpad(n::text, 5, '0'), 'on_hand', (n * 37) % 120, 'reserved', (n * 11) % 9) ORDER BY n))
  FROM generate_series(1, 300) AS n),
 NULL),
('ping', '[1, 2.5, "three", false, null]'::jsonb, 'pong');
