-- SQLite version of the `shop` sample data (see seed.sql for MySQL). Built by `npm run db:sqlite`.
PRAGMA foreign_keys = ON;

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  attributes JSON
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  ordered_at DATETIME NOT NULL
);
CREATE INDEX orders_customer_id ON orders(customer_id);
CREATE INDEX orders_product_id ON orders(product_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type VARCHAR(50) NOT NULL,
  payload JSON,
  raw_body TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO customers (name, email)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1000)
SELECT 'Customer ' || n, 'customer' || n || '@example.com' FROM seq;

INSERT INTO products (sku, name, price, attributes)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200)
SELECT printf('SKU-%05d', n), 'Product ' || n, round(1 + ((n * 7919) % 19900) / 100.0, 2),
       json_object('color', CASE n % 4 WHEN 0 THEN 'red' WHEN 1 THEN 'green' WHEN 2 THEN 'blue' ELSE 'black' END, 'weight_kg', n % 10)
FROM seq;

INSERT INTO orders (customer_id, product_id, quantity, ordered_at)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50000)
SELECT 1 + n % 1000, 1 + (n * 7) % 200, 1 + n % 5, datetime('now', '-' || (n % 730) || ' days')
FROM seq;

INSERT INTO events (type, payload, raw_body) VALUES
('order.created',
 json_object('order_id', 1, 'customer', json_object('id', 2, 'name', 'Customer 2', 'vip', json('true')),
   'items', json_array(json_object('sku', 'SKU-00008', 'qty', 2, 'price', 12.5), json_object('sku', 'SKU-00015', 'qty', 1, 'price', 99.0)),
   'coupon', NULL, 'tags', json_array('web', 'first-order'),
   'meta', '{"source":"webhook","retries":[1,2],"headers":{"x-request-id":"a1b2c3"}}'),
 '{' || char(10) || '  "event": "order.created",' || char(10) || '  "signature": "sha256=9f86d08",' || char(10) || '  "delivered": true' || char(10) || '}'),
('customer.updated',
 json_object('customer_id', 7, 'changes', json_object('email', json_array('old7@example.com', 'customer7@example.com')),
   'actor', json_object('type', 'admin', 'name', 'Märta Ångström 👩‍💻')),
 'Customer 7 updated their e-mail address via the account page.' || char(10) || 'No further action needed.'),
('inventory.snapshot',
 (WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 300)
  SELECT json_object('warehouse', 'HEL-1', 'counts',
           json_group_array(json_object('sku', printf('SKU-%05d', n), 'on_hand', (n * 37) % 120, 'reserved', (n * 11) % 9)))
  FROM seq),
 NULL),
('ping', json_array(1, 2.5, 'three', json('false'), NULL), 'pong');

CREATE VIEW order_details AS
SELECT o.id AS order_id, o.customer_id, c.name AS customer_name,
       p.sku, o.quantity, p.price AS unit_price, round(o.quantity * p.price, 2) AS total, o.ordered_at
FROM orders o
JOIN customers c ON c.id = o.customer_id
JOIN products p ON p.id = o.product_id;
