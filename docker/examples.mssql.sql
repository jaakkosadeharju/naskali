USE shop;
GO

CREATE OR ALTER VIEW dbo.order_details AS
SELECT o.id AS order_id, o.customer_id, c.name AS customer_name,
       p.sku, o.quantity, p.price AS unit_price, o.quantity * p.price AS total, o.ordered_at
FROM dbo.orders o
JOIN dbo.customers c ON c.id = o.customer_id
JOIN dbo.products p ON p.id = o.product_id;
GO

CREATE OR ALTER FUNCTION dbo.line_total(@unit_price DECIMAL(10, 2), @quantity INT)
RETURNS DECIMAL(18, 2)
AS
BEGIN
  RETURN @unit_price * @quantity;
END;
GO

CREATE OR ALTER PROCEDURE dbo.customer_order_count @customer INT
AS
BEGIN
  SET NOCOUNT ON;
  SELECT COUNT(*) AS order_count FROM dbo.orders WHERE customer_id = @customer;
END;
GO
