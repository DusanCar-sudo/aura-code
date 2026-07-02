/**
 * Builds a query to fetch a user by username.
 */
function buildUserQuery(username) {
  // BUG: username is concatenated directly into the SQL string —
  // classic SQL injection vector.
  return `SELECT * FROM users WHERE username = '${username}'`;
}

module.exports = { buildUserQuery };
