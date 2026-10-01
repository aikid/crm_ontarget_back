function publicUser(user) {
  return {
    id: user.id,
    clientId: user.clientId,
    name: user.name,
    email: user.email,
    initials: user.initials,
    role: user.role,
    active: user.active,
    client: user.client || null,
  };
}

module.exports = { publicUser };
