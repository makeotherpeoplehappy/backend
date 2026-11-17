-- One pledge per purchase: each order keeps one pledge (a kept one first, then
-- an open one, then the oldest) and the others are removed.
DELETE FROM pledges WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY order_ref
      ORDER BY CASE status WHEN 'kept' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, id
    ) AS rn
    FROM pledges
  ) WHERE rn = 1
);
UPDATE pledges SET line_ref = 'order', piece = 1;
