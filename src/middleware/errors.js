const { HttpError } = require("../lib/http-error");
const { ZodError } = require("zod");

function notFound(_request, _response, next) {
  next(new HttpError(404, "Rota não encontrada."));
}

function errorHandler(error, _request, response, _next) {
  const validationError = error instanceof ZodError;
  const uploadError = error.name === "MulterError";
  const prismaStatus = error.code === "P2025" ? 404 : ["P2002", "P2003"].includes(error.code) ? 409 : null;
  const status = validationError || uploadError ? 400 : error.status || prismaStatus || 500;
  if (status >= 500) console.error(error);
  response.status(status).json({
    error: {
      message: status >= 500
        ? "Erro interno do servidor."
        : uploadError
          ? "O arquivo excede o limite de 10 MB ou é inválido."
        : validationError
          ? "Os dados informados são inválidos."
          : error.code === "P2002"
            ? "Já existe um registro com os mesmos dados únicos."
            : error.code === "P2003"
              ? "A operação viola um relacionamento existente."
              : error.message,
      ...(validationError ? {
        details: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
      } : error.details ? { details: error.details } : {}),
    },
  });
}

module.exports = { notFound, errorHandler };
