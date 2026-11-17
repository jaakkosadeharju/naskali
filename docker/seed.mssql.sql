-- SQL Server version of the `shop` sample data (see seed.sql for MySQL).
-- Run by docker/mssql-entrypoint.sh (sqlcmd -f 65001, so the file is read as UTF-8).
CREATE DATABASE shop;
GO
USE shop;
GO

CREATE TABLE customers (
  id INT IDENTITY(1,1) PRIMARY KEY,
  name NVARCHAR(100) NOT NULL,
  email NVARCHAR(200) NULL,
  created_at DATETIME2(0) NOT NULL DEFAULT SYSDATETIME()
);
-- Unique like the other databases, but allowing several NULLs (a plain UNIQUE allows one).
CREATE UNIQUE INDEX customers_email ON customers(email) WHERE email IS NOT NULL;

CREATE TABLE products (
  id INT IDENTITY(1,1) PRIMARY KEY,
  sku VARCHAR(32) NOT NULL UNIQUE,
  name NVARCHAR(200) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  attributes NVARCHAR(MAX) NULL CHECK (ISJSON(attributes) = 1)
);

CREATE TABLE orders (
  id INT IDENTITY(1,1) PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  product_id INT NOT NULL REFERENCES products(id),
  quantity INT NOT NULL,
  ordered_at DATETIME2(0) NOT NULL
);
CREATE INDEX orders_customer_id ON orders(customer_id);
CREATE INDEX orders_product_id ON orders(product_id);

CREATE TABLE events (
  id INT IDENTITY(1,1) PRIMARY KEY,
  type NVARCHAR(50) NOT NULL,
  payload NVARCHAR(MAX) NULL CHECK (ISJSON(payload) = 1),
  raw_body NVARCHAR(MAX) NULL,
  created_at DATETIME2(0) NOT NULL DEFAULT SYSDATETIME()
);
GO

WITH n AS (SELECT TOP (1000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO customers (name, email)
SELECT CONCAT(N'Customer ', n), CONCAT(N'customer', n, N'@example.com') FROM n ORDER BY n;

WITH n AS (SELECT TOP (200) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects)
INSERT INTO products (sku, name, price, attributes)
SELECT CONCAT('SKU-', RIGHT(CONCAT('00000', n), 5)), CONCAT(N'Product ', n), ROUND(1 + ((n * 7919) % 19900) / 100.0, 2),
       CONCAT(N'{"color":"', CHOOSE(1 + n % 4, 'red', 'green', 'blue', 'black'), N'","weight_kg":', n % 10, N'}')
FROM n ORDER BY n;

WITH n AS (SELECT TOP (50000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO orders (customer_id, product_id, quantity, ordered_at)
SELECT 1 + n % 1000, 1 + (n * 7) % 200, 1 + n % 5, DATEADD(day, -(n % 730), SYSDATETIME()) FROM n ORDER BY n;

INSERT INTO events (type, payload, raw_body) VALUES
(N'order.created',
 N'{"order_id":1,"customer":{"id":2,"name":"Customer 2","vip":true},"items":[{"sku":"SKU-00008","qty":2,"price":12.5},{"sku":"SKU-00015","qty":1,"price":99.0}],"coupon":null,"tags":["web","first-order"],"meta":"{\"source\":\"webhook\",\"retries\":[1,2],\"headers\":{\"x-request-id\":\"a1b2c3\"}}"}',
 CONCAT(N'{', CHAR(10), N'  "event": "order.created",', CHAR(10), N'  "signature": "sha256=9f86d08",', CHAR(10), N'  "delivered": true', CHAR(10), N'}')),
(N'customer.updated',
 N'{"customer_id":7,"changes":{"email":["old7@example.com","customer7@example.com"]},"actor":{"type":"admin","name":"Märta Ångström 👩‍💻"}}',
 CONCAT(N'Customer 7 updated their e-mail address via the account page.', CHAR(10), N'No further action needed.')),
(N'inventory.snapshot',
 (SELECT 'HEL-1' AS warehouse,
         (SELECT CONCAT('SKU-', RIGHT(CONCAT('00000', n), 5)) AS sku, (n * 37) % 120 AS on_hand, (n * 11) % 9 AS reserved
          FROM (SELECT TOP (300) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) AS s ORDER BY n FOR JSON PATH) AS counts
  FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
 NULL),
(N'ping', N'[1,2.5,"three",false,null]', N'pong');
GO
