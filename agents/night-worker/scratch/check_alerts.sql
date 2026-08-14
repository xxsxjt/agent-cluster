.mode column
SELECT id, kind, substr(title,1,40) AS title, substr(message,1,60) AS msg FROM admin_mobile_alerts ORDER BY id DESC LIMIT 5;
