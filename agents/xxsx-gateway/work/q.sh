DB=/data/xxsx-api/new-api-data/xxsx-new-api.db
echo ===USERS-SCHEMA===
sqlite3 "$DB" "PRAGMA table_info(users);"
echo ===ADMIN-TOKEN-COL===
sqlite3 "$DB" "SELECT id, username, role, status, access_token FROM users WHERE id=1;" 2>&1
echo ===MAYBE-TOKEN===
sqlite3 "$DB" "SELECT id, username, role, status FROM users WHERE id IN (1,2);"
echo ===REDEMPTIONS-ADMIN===
sqlite3 "$DB" "SELECT count(*) FROM redemptions;" 2>&1
