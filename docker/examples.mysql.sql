CREATE OR REPLACE VIEW order_details AS
SELECT o.id AS order_id, o.customer_id, c.name AS customer_name,
       p.sku, o.quantity, p.price AS unit_price, o.quantity * p.price AS total, o.ordered_at
FROM orders o
JOIN customers c ON c.id = o.customer_id
JOIN products p ON p.id = o.product_id;

CREATE FUNCTION IF NOT EXISTS line_total(unit_price DECIMAL(10, 2), quantity INT)
RETURNS DECIMAL(18, 2)
DETERMINISTIC NO SQL
RETURN unit_price * quantity;

CREATE PROCEDURE IF NOT EXISTS customer_order_count(IN customer INT)
READS SQL DATA
SELECT COUNT(*) AS order_count FROM orders WHERE customer_id = customer;
