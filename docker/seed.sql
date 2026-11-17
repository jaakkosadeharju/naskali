USE shop;

CREATE TABLE customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  attributes JSON
);

CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  ordered_at DATETIME NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

INSERT INTO customers (name, email)
SELECT CONCAT('Customer ', n), CONCAT('customer', n, '@example.com')
FROM (
  WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1000)
  SELECT n FROM seq
) s;

INSERT INTO products (sku, name, price, attributes)
SELECT CONCAT('SKU-', LPAD(n, 5, '0')), CONCAT('Product ', n), ROUND(1 + RAND(n) * 199, 2),
       JSON_OBJECT('color', ELT(1 + n % 4, 'red', 'green', 'blue', 'black'), 'weight_kg', n % 10)
FROM (
  WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200)
  SELECT n FROM seq
) s;

SET SESSION cte_max_recursion_depth = 100000;
INSERT INTO orders (customer_id, product_id, quantity, ordered_at)
SELECT 1 + n % 1000, 1 + (n * 7) % 200, 1 + n % 5, NOW() - INTERVAL (n % 730) DAY
FROM (
  WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50000)
  SELECT n FROM seq
) s;
