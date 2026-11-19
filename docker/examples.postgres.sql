CREATE OR REPLACE VIEW public.order_details AS
SELECT o.id AS order_id, o.customer_id, c.name AS customer_name,
       p.sku, o.quantity, p.price AS unit_price, o.quantity * p.price AS total, o.ordered_at
FROM public.orders o
JOIN public.customers c ON c.id = o.customer_id
JOIN public.products p ON p.id = o.product_id;

CREATE OR REPLACE FUNCTION public.line_total(unit_price NUMERIC, quantity INTEGER)
RETURNS NUMERIC
LANGUAGE SQL IMMUTABLE STRICT
AS $$ SELECT unit_price * quantity $$;

CREATE OR REPLACE PROCEDURE public.customer_order_count(IN customer INTEGER, OUT order_count BIGINT)
LANGUAGE SQL
AS $$ SELECT COUNT(*) FROM public.orders WHERE customer_id = customer $$;
