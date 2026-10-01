class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function required(value, field) {
  if (value === undefined || value === null || value === "") {
    throw new HttpError(400, `O campo '${field}' é obrigatório.`);
  }
  return value;
}

module.exports = { HttpError, required };

