const bcrypt = require("bcryptjs");

const HASH_ROUNDS = 12;

function hashPassword(password) {
  return bcrypt.hash(password, HASH_ROUNDS);
}

function verifyPassword(password, hash) {
  if (!hash || hash === "!") return Promise.resolve(false);
  return bcrypt.compare(password, hash);
}

module.exports = { hashPassword, verifyPassword };
