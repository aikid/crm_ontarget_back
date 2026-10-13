function normalizeOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Origem HTTP(S) inválida: ${value}`);
  }
  return url.origin;
}

function originList(value, fallback = []) {
  const items = value
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : fallback;
  return [...new Set(items.map(normalizeOrigin))];
}

module.exports = { normalizeOrigin, originList };
